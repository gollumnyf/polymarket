import {PreviousDirectionEngine} from './previous-direction-engine.mjs';
import {roundStart,ROUND_SECONDS,resetAtAmountLimit} from './strategy.mjs';
import {ACTIVE_LOSS_FOLLOW_VERSION,ACTIVE_PAPER_LOSS_FOLLOW_VERSION,LOSS_FOLLOW_V2,LOSS_FOLLOW_V4} from './strategy-versions.mjs';
import {stakeAmount} from '../src/stake-amount.mjs';

export class LossFollowEngine extends PreviousDirectionEngine {
  constructor(store,venue,{source,mode='paper',initialConfig,...options}){
    super(store,venue,{...options,mode,previousMarketStore:source.store,repeatAfterLoss:false});
    this.source=source;
    store.db.exec(`CREATE TABLE IF NOT EXISTS loss_follow_triggers (
      session TEXT NOT NULL REFERENCES account_sessions(id), source_round INTEGER NOT NULL,
      first_round INTEGER NOT NULL, second_round INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      PRIMARY KEY(session,source_round)
    )`);
    store.transaction(()=>{
      const version=mode==='paper'?ACTIVE_PAPER_LOSS_FOLLOW_VERSION:ACTIVE_LOSS_FOLLOW_VERSION;
      const initialized=store.db.prepare('SELECT 1 FROM strategy_versions WHERE id IN (?,?) LIMIT 1')
        .get(version.id,LOSS_FOLLOW_V2.id);
      if(mode==='live'&&initialConfig&&!initialized){
        const account=store.account(mode);
        store.saveAccount({...account,config:{...account.config,
          baseAmount:initialConfig.baseAmount,maxAmount:initialConfig.maxAmount,
          maxDoublings:initialConfig.maxDoublings,stopLoss:initialConfig.stopLoss}});
      }
      this.strategyVersion=store.registerStrategyVersion(version);
    });
  }
  get singleTradeCycle(){return this.strategyVersion===ACTIVE_PAPER_LOSS_FOLLOW_VERSION.id;}
  nextAmount(account){return this.singleTradeCycle?account.config.baseAmount:stakeAmount(account.config.baseAmount,account.stakeLosses??account.losses,5);}
  executionAccount(account){return this.singleTradeCycle?{...account,stakeLosses:0,stakeLabel:'本轮固定首笔'}:account;}
  isPreviousStakeCycle(){return this.singleTradeCycle;}
  positionStatus(){return this.singleTradeCycle?'本轮已成交，重新等待来源盘三笔新失利':super.positionStatus();}
  resetStakeCycle(account){
    if(this.singleTradeCycle)return account;
    if(account.config.baseAmount<=account.config.maxAmount&&account.losses>account.config.maxDoublings)
      return {...account,losses:0,cycle:account.cycle+1,cyclePnl:0};
    return resetAtAmountLimit(account,a=>this.nextAmount(a));
  }
  accountAfterSettlement(account,pnl,won,order){
    const settled=super.accountAfterSettlement(account,pnl,won,order);
    return this.singleTradeCycle?{...settled,losses:0,cyclePnl:0,cycle:account.cycle+1}:settled;
  }
  evidence(engine,order,now){
    const final={won:'won',lost:'lost',void:'void'}[order.status];
    if(final)return {result:final,source:'official'};
    const sourceStore=engine.store,end=(order.end??order.round+ROUND_SECONDS)*1000;
    if(now>=end){
      const resolved=sourceStore.historicalRound(order.round);
      if(resolved?.status==='void')return {result:'void',source:'official'};
      if(resolved?.status==='resolved'&&['UP','DOWN'].includes(resolved.result))
        return {result:resolved.result===order.direction?'won':'lost',source:'official'};
      const prices=sourceStore.roundPrediction(order.round);
      const matched=prices?.conditionId===order.conditionId&&(order.oracleWindow==null||prices.oracleWindow===order.oracleWindow)?prices:null;
      const forecast=matched??order.prediction??engine.lastSecondPrediction(order.round,order);
      if(forecast?.outcome)return {result:forecast.outcome===order.direction?'won':'lost',source:forecast.source};
      return {result:'pending',source:'pending'};
    }
    const feed=engine.venue.priceFeed,spot=engine.spot;
    const saved=sourceStore.roundOpening(order.round);
    const opening=saved?.conditionId===order.conditionId?saved:spot?.round===order.round&&spot.conditionId===order.conditionId&&spot.openingSource==='polymarket_official'
      ?{open:spot.currentOpen,oracleWindow:spot.windowSeconds}:null;
    if(!Number.isFinite(opening?.open)||opening.open<=0||!Number.isFinite(opening.oracleWindow)||
      (order.oracleWindow!=null&&order.oracleWindow!==opening.oracleWindow))return {result:'pending',source:'pending'};
    const point=feed?.round===order.round&&feed.spec?.seconds===opening.oracleWindow?feed.recent?.(1)?.at(-1):null;
    const quote=point??(spot?.round===order.round&&spot.conditionId===order.conditionId&&spot.windowSeconds===opening.oracleWindow?{time:spot.at,price:spot.price}:null);
    if(!Number.isFinite(quote?.time)||quote.time<order.round*1000||quote.time>=end||quote.time>now||now-quote.time>6000||
      !Number.isFinite(quote.price)||quote.price<=0)return {result:'pending',source:'pending'};
    return {result:(quote.price>=opening.open?'UP':'DOWN')===order.direction?'won':'lost',source:'polymarket_realtime',priceAt:quote.time};
  }
  firstLossCooldown(start,now,session,trigger){
    if(this.strategyVersion!==ACTIVE_LOSS_FOLLOW_VERSION.id||!trigger||now<start*1000)return null;
    const {first_round,second_round,source_round}=trigger;
    if(second_round-first_round!==ROUND_SECONDS||source_round-second_round!==ROUND_SECONDS)return null;

    const priorRound=start-ROUND_SECONDS;
    if(priorRound<=source_round)return null;
    const prior=this.store.orderForRound(this.mode,priorRound);
    if(!prior||prior.session!==session||!(prior.shares>0)||!['open','lost'].includes(prior.status)||
      !['UP','DOWN'].includes(prior.direction))return null;
    const earlier=this.store.db.prepare(`SELECT 1 FROM orders
      WHERE mode=? AND session=? AND round>? AND round<? AND shares>0
      AND status IN ('open','won','lost','void') LIMIT 1`).get(this.mode,session,source_round,priorRound);
    if(earlier)return null;

    // For a binary loss the winning market direction is the opposite of the order.
    const evidence=this.evidence(this,prior,now);
    const shared=evidence.source==='official'?null:this.evidence(this.source,prior,now);
    const useShared=shared&&(shared.source==='official'||evidence.result==='pending');
    const result=useShared?shared:evidence;
    if(result.result!=='lost')return null;
    for(const round of [first_round,second_round,source_round]){
      const order=this.source.store.orderForRound('paper',round);
      if(order?.direction!==prior.direction||this.evidence(this.source,order,now).result!=='lost')return null;
    }
    const direction=prior.direction==='UP'?'DOWN':'UP';
    return {
      code:'LOSS_FOLLOW_FIRST_LOSS_COOLDOWN',
      message:`来源 #${first_round}、#${second_round}、#${source_round} 连续三场 ${direction}，反买 ${prior.direction} 均失利。本轮首笔跟随 #${priorRound} 反买 ${prior.direction}${result.source==='official'?'官方确认':'预计'}失利，本场跳过，下一场恢复跟随检查`,
      round:start,
    };
  }
  paperFollowEvidence(order,now){
    const evidence=this.evidence(this,order,now);
    if(evidence.source==='official')return evidence;
    if(now<(order.end??order.round+ROUND_SECONDS)*1000)return evidence;
    const market=this.marketResult(order.round);
    if(market.source==='official_void')return {result:'void',source:'official'};
    if(market.direction)return {result:market.direction===order.direction?'won':'lost',source:market.source};
    return evidence;
  }
  repeatedLossCooldown(start,now,order,evidence){
    if(!order||order.round!==start-ROUND_SECONDS||now<start*1000||evidence?.result!=='lost')return null;
    const direction=order.direction==='UP'?'DOWN':'UP';
    const previous=order.round-ROUND_SECONDS,older=previous-ROUND_SECONDS;
    if(this.marketResult(previous).direction!==direction||this.marketResult(older).direction!==direction)return null;
    return {
      code:'LOSS_FOLLOW_SAME_DIRECTION_LOSS_COOLDOWN',
      message:`跟随单 #${order.round} 买 ${order.direction}${evidence.source==='official'?'已确认':'预计'}失利。该场与紧邻的 #${older}、#${previous} 均收盘为 ${direction}，本场跳过，下一场恢复入场检查`,
      round:start,
    };
  }
  monitor(start,now=this.now(),preview=false){
    const own=this.store.account(this.mode),from=this.source.store.account('paper');
    const singleTrade=this.singleTradeCycle;
    const latest=this.store.recentFilledOrders(this.mode,own.session,1,{ignoreVoid:!singleTrade})[0];
    const repeatCooldown=this.strategyVersion===LOSS_FOLLOW_V4.id;
    const latestResult=!latest||singleTrade?null:repeatCooldown?this.paperFollowEvidence(latest,now):this.evidence(this,latest,now);
    const completed=singleTrade?Boolean(latest):latestResult?.result==='won';
    const trigger=this.store.db.prepare('SELECT * FROM loss_follow_triggers WHERE session=? ORDER BY source_round DESC LIMIT 1').get(own.session);
    let armed=!!trigger&&(!completed||trigger.source_round>latest.round);
    const holding=!!latest&&!completed;
    if(armed&&!holding){
      // Before the first fill, an official correction can withdraw a provisional trigger.
      for(const round of [trigger.first_round,trigger.second_round,trigger.source_round]){
        const order=this.source.store.orderForRound('paper',round);
        const result=order&&this.evidence(this.source,order,now);
        if(result?.source==='official'&&result.result!=='lost'){armed=false;break;}
      }
    }
    const active=holding||armed;
    const recent=this.source.store.recentFilledOrders('paper',from.session,3,{beforeRound:preview?start+ROUND_SECONDS:start})
      .filter(order=>!completed||order.round>latest.round);
    let losses=0;
    const samples=recent.map(order=>({round:order.round,...this.evidence(this.source,order,now)}));
    for(const sample of samples){if(sample.result!=='lost')break;losses++;}
    const cooldown=!active?null:repeatCooldown
      ?this.repeatedLossCooldown(start,now,latest,latestResult)
      :this.firstLossCooldown(start,now,own.session,trigger);
    return {active,losses,ready:active||losses>=3,samples,ownResult:latestResult?.result??null,cooldown,
      armed,activeFrom:active?(armed?trigger.source_round:latest.round):null};
  }
  arm(start=roundStart(this.now())){
    const account=this.store.account(this.mode);
    if(!account.running)return;
    const state=this.monitor(start);
    if(state.active||state.losses<3)return;
    const [last,second,first]=state.samples;
    this.store.db.prepare('INSERT OR IGNORE INTO loss_follow_triggers(session,source_round,first_round,second_round,observed_at) VALUES (?,?,?,?,?)')
      .run(account.session,last.round,first.round,second.round,this.now());
  }
  entryGuard(account,start){
    this.arm(start);
    return super.entryGuard(account,start);
  }
  signal(start=roundStart(this.now())){
    const state=this.monitor(start);
    const base=this.mode==='live'?this.source.signal(start,{repeatAfterLoss:false}):this.source.signal(start);
    if(state.cooldown)return {...base,direction:null,...state.cooldown};
    if(!state.ready)return {...base,direction:null,code:'LOSS_FOLLOW_WAIT',message:'等待上场方向模拟的新三连亏：'+state.losses+' / 3'};
    const evidence=state.active?`本轮跟随中，来源触发场 #${state.activeFrom}；${this.singleTradeCycle?'本轮成交一单后重新待命':'获胜后重新待命'}`:'来源三连亏：'+state.samples.map(x=>'#'+x.round+' '+x.source).join('、');
    return {...base,message:evidence+'；'+base.message};
  }
  quote(book,budget,config,schedule){
    const {minPrice,maxPrice}=this.source.store.account('paper').config;
    return super.quote(book,budget,{...config,minPrice,maxPrice},schedule);
  }
  orderSignalFields(account,start){
    return {...super.orderSignalFields(account,start),signalRule:'previous_round_loss_follow'};
  }
  async tick(){
    const now=this.now(),round=roundStart(now);
    if(!this.closing&&now-round*1000<=15000)this.arm(round);
    await super.tick();
    if(!this.closing&&this.hasExecutionPriority(now)&&now-round*1000>=288000)this.broadcast();
  }
  snapshot(){
    const result=super.snapshot(),round=roundStart(this.now()),source=this.source.store.account('paper');
    Object.assign(result.accounts[this.mode],{stakeIncrement:this.singleTradeCycle?0:5,singleTradeCycle:this.singleTradeCycle});
    return {...result,strategy:'previous_round_loss_follow',lossFollow:{...this.monitor(round,this.now(),true),
      minPrice:source.config.minPrice,maxPrice:source.config.maxPrice}};
  }
}
