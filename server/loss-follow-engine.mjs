import {PreviousDirectionEngine} from './previous-direction-engine.mjs';
import {roundStart,ROUND_SECONDS,resetAtAmountLimit} from './strategy.mjs';
import {ACTIVE_LOSS_FOLLOW_VERSION} from './strategy-versions.mjs';
import {stakeAmount} from '../src/stake-amount.mjs';

export class LossFollowEngine extends PreviousDirectionEngine {
  constructor(store,venue,{source,...options}){
    super(store,venue,{...options,mode:'paper',previousMarketStore:source.store});
    this.source=source;
    store.db.exec(`CREATE TABLE IF NOT EXISTS loss_follow_triggers (
      session TEXT NOT NULL REFERENCES account_sessions(id), source_round INTEGER NOT NULL,
      first_round INTEGER NOT NULL, second_round INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      PRIMARY KEY(session,source_round)
    )`);
    this.strategyVersion=store.registerStrategyVersion(ACTIVE_LOSS_FOLLOW_VERSION);
  }
  nextAmount(account){return stakeAmount(account.config.baseAmount,account.stakeLosses??account.losses,5);}
  resetStakeCycle(account){
    if(account.config.baseAmount<=account.config.maxAmount&&account.losses>account.config.maxDoublings)
      return {...account,losses:0,cycle:account.cycle+1,cyclePnl:0};
    return resetAtAmountLimit(account,a=>this.nextAmount(a));
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
  monitor(start,now=this.now(),preview=false){
    const own=this.store.account('paper'),from=this.source.store.account('paper');
    const latest=this.store.recentFilledOrders('paper',own.session,1,{ignoreVoid:true})[0];
    const latestResult=latest?this.evidence(this,latest,now):null;
    const ownWon=latestResult?.result==='won';
    const trigger=this.store.db.prepare('SELECT * FROM loss_follow_triggers WHERE session=? ORDER BY source_round DESC LIMIT 1').get(own.session);
    let armed=!!trigger&&(!ownWon||trigger.source_round>latest.round);
    const holding=!!latest&&!ownWon;
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
      .filter(order=>!ownWon||order.round>latest.round);
    let losses=0;
    const samples=recent.map(order=>({round:order.round,...this.evidence(this.source,order,now)}));
    for(const sample of samples){if(sample.result!=='lost')break;losses++;}
    return {active,losses,ready:active||losses>=3,samples,ownResult:latestResult?.result??null,
      armed,activeFrom:active?(armed?trigger.source_round:latest.round):null};
  }
  arm(start=roundStart(this.now())){
    const account=this.store.account('paper');
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
    const base=this.source.signal(start);
    if(!state.ready)return {...base,direction:null,code:'LOSS_FOLLOW_WAIT',message:'等待上场方向模拟的新三连亏：'+state.losses+' / 3'};
    const evidence=state.active?'本轮跟随中，来源触发场 #'+state.activeFrom+'；获胜后重新待命':'来源三连亏：'+state.samples.map(x=>'#'+x.round+' '+x.source).join('、');
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
    result.accounts.paper.stakeIncrement=5;
    return {...result,strategy:'previous_round_loss_follow',lossFollow:{...this.monitor(round,this.now(),true),
      minPrice:source.config.minPrice,maxPrice:source.config.maxPrice}};
  }
}
