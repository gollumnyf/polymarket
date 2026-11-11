import {MomentumEngine} from './momentum.mjs';
import {normalizeHistoricalRound} from './history.mjs';
import {roundStart,simulateFill,validateConfig} from './strategy.mjs';
import {safeError} from './polymarket.mjs';
import {stableRange,classifyRange,rangeRegime,RANGE_BUCKET_MS,RANGE_EDGE_FRACTION,levelWindow,validateRangeConfig} from './range-strategy.mjs';

export class RangeEngine extends MomentumEngine {
  constructor(store,venue,options={}){
    super(store,venue,options);
    this.voteRevision=0;this.lastVotePoll=0;this.voteTask=null;this.backfillTask=null;this.backfillQueue=new Map();this.backfillInFlight=new Set();this.backfillRetryAt=new Map();this.historyRepair={pending:0,active:0,lastError:null};this.analysisCache=null;
  }
  backfillMarketHistory(){
    if(this.closing||!this.venue.fetch||!Number.isFinite(this.spot?.windowSeconds))return this.backfillTask;
    const config=this.store.rangeConfig(),window=this.spot.windowSeconds,end=roundStart(this.now());
    const state=this.store.rangeState(),start=Math.min(end-Math.max(config.levelLookbackHours,config.lookbackHours)*3600,state?.breakoutPendingDirection&&!state.breakoutConfirmedAt?state.breakoutStartRound??end:end);
    const known=new Set(this.store.marketPrices(window,start,end).map(item=>item.round));
    for(let round=end-300;round>=start;round-=300){
      const key=window+':'+round;
      if(known.has(round)||this.backfillInFlight.has(key)||this.backfillQueue.has(key)||(this.backfillRetryAt.get(key)??0)>this.now())continue;
      this.backfillQueue.set(key,{key,round,window});
    }
    this.historyRepair.pending=this.backfillQueue.size;
    if(this.backfillTask||!this.backfillQueue.size)return this.backfillTask;
    const worker=async()=>{
      while(!this.closing&&this.backfillQueue.size){
        const [key,job]=this.backfillQueue.entries().next().value;this.backfillQueue.delete(key);this.backfillInFlight.add(key);
        this.historyRepair.pending=this.backfillQueue.size;this.historyRepair.active=this.backfillInFlight.size;
        try{
          const params=new URLSearchParams({symbol:'BTC',eventStartTime:new Date(job.round*1000).toISOString(),endDate:new Date((job.round+300)*1000).toISOString(),variant:'fiveminute',twapEnabled:String(job.window>0),twapLookbackSeconds:String(job.window||60)});
          const response=await this.venue.fetch('https://polymarket.com/api/crypto/crypto-price?'+params);
          if(!response.ok)throw Error('HTTP '+response.status);
          const data=await response.json(),open=Number(data.openPrice),close=Number(data.closePrice);
          if(!Number.isFinite(open)||open<=0||!Number.isFinite(close)||close<=0)throw Error('官方接口尚未返回有效的场次起止价');
          if(this.closing)return;
          this.store.transaction(()=>{
            this.store.marketRound(job.round,open,close,job.window,this.now());
            if(this.spot?.windowSeconds===job.window)this.store.saveVote({round:job.round,open,close,outcome:close>=open?'UP':'DOWN',source:'polymarket_crypto_price',updatedAt:this.now()});
          });
          this.backfillRetryAt.delete(key);this.analysisCache=null;this.voteRevision++;this.historyRepair.lastError=null;
          // Use each completed response immediately; do not wait for a whole batch.
          void this.attempt('paper').catch(error=>{if(!this.closing)this.runtimeIssue('paper','补齐后交易检查失败，自动重试：'+safeError(error));});
          this.broadcast();
        }catch(error){
          if(!this.closing){
            const message='场次 #'+job.round+' 起止价补齐失败：'+safeError(error);
            const firstFailure=!this.backfillRetryAt.has(key);
            this.backfillRetryAt.set(key,this.now()+1000);this.historyRepair.lastError=message;
            if(firstFailure)this.runtimeIssue('paper',message+'；继续重试，不暂停策略');
          }
        }finally{this.backfillInFlight.delete(key);this.historyRepair.active=this.backfillInFlight.size;}
      }
    };
    // Start on a microtask so repeated reads see the task and cannot duplicate it.
    this.backfillTask=Promise.resolve().then(()=>Promise.all(Array.from({length:8},()=>worker())))
      .finally(()=>{this.backfillTask=null;this.historyRepair.pending=this.backfillQueue.size;});
    return this.backfillTask;
  }
  // Market outcomes are independent of orders, fills and order PnL.
  marketRoundOutcome(round,window){
    const history=this.store.historicalRound(round),cached=this.store.vote(round);
    const direction=value=>['UP','DOWN'].includes(value),valid=value=>Number.isFinite(value)&&value>0;
    const save=value=>this.store.saveVote({round,...value});
    if(history?.status==='resolved'&&direction(history.result))return save({outcome:history.result,source:'official',open:history.open,close:history.close,updatedAt:history.updatedAt||this.now()});
    if(history?.status==='void')return save({source:'official_void',updatedAt:history.updatedAt||this.now()});
    if(cached?.source==='official_void'||cached?.source==='official'&&direction(cached.outcome))return cached;
    const prices=(open,close,source,updatedAt)=>save({open,close,outcome:close>=open?'UP':'DOWN',source,updatedAt});
    if(valid(history?.open)&&valid(history?.close))return prices(history.open,history.close,'polymarket_event_metadata',history.updatedAt||this.now());
    const official=Number.isFinite(window)?this.store.marketPrices(window,round,round+300)[0]:null;
    if(valid(official?.open)&&valid(official?.close))return prices(official.open,official.close,'polymarket_crypto_price',official.fetchedAt);
    const prediction=this.store.roundPrediction(round);
    if(prediction&&Number.isFinite(window)&&prediction.oracleWindow===window&&valid(prediction.open)&&valid(prediction.close)&&
      ['polymarket_event_metadata','polymarket_crypto_price','polymarket_last_second'].includes(prediction.source))
      return prices(prediction.open,prediction.close,prediction.source,prediction.observedAt);
    const opening=this.store.roundOpening(round),tick=opening&&Number.isFinite(window)&&opening.oracleWindow===window?this.store.lastSecondTick(round,window):null;
    if(valid(opening?.open)&&valid(tick?.price))return prices(opening.open,tick.price,'polymarket_last_second',tick.time);
    // The cached record is a market vote, never an order prediction.
    return cached||{round,outcome:null,source:'pending'};
  }
  voteSummary(config,window){
    const latest=roundStart(this.now())-300,expected=config.lookbackHours*12;
    let up=0,down=0,covered=0,official=0,estimated=0,voids=0,previousDirection=null,previousSource=null;
    for(let i=0;i<expected;i++){
      const round=latest-i*300;
      const vote=this.marketRoundOutcome(round,window);
      if(vote?.outcome){covered++;if(vote.outcome==='UP')up++;else down++;if(vote.source==='official')official++;else estimated++;}
      else if(vote?.source==='official_void'){covered++;voids++;}
      if(i===0){previousDirection=vote?.outcome??null;previousSource=vote?.source??null;}
    }
    return {up,down,expected,covered,official,estimated,voids,complete:covered===expected,direction:covered===expected?(up>down?'UP':down>up?'DOWN':null):null,
      previousRound:latest,previousDirection,previousSource,previousEstimated:!!previousDirection&&previousSource!=='official'};
  }
  analysis(){
    this.backfillMarketHistory();
    const config=this.store.rangeConfig(),window=this.spot?.windowSeconds,end=Math.floor(this.now()/RANGE_BUCKET_MS)*RANGE_BUCKET_MS;
    const key=`${config.id}:${window}:${end}:${this.voteRevision}`;
    // Keep candle analysis cached, but re-read results so a just-arrived previous
    // forecast or official correction is used even within the same five seconds.
    if(this.analysisCache?.key===key)return {...this.analysisCache,candidate:classifyRange(this.analysisCache.candidate,this.spot?.price),vote:this.voteSummary(config,window)};
    const start=end-config.lookbackHours*3600000;
    const levelStart=levelWindow(this.now(),config.levelLookbackHours).start;
    const history=Number.isFinite(window)?this.store.rangeBars(window,Math.min(start,levelStart),end):[];
    const bars=history.filter(bar=>bar.bucket>=start);
    const official=Number.isFinite(window)?this.store.marketPrices(window,Math.floor(levelStart/1000),roundStart(this.now())):[];
    const candidate=stableRange(bars,config,this.now(),history,this.spot?.price,official),vote=this.voteSummary(config,window);
    this.analysisCache={key,config,candidate,vote};return this.analysisCache;
  }
  signal(){
    const previous=this.store.rangeState();
    const reject=(code,message)=>({direction:null,code,message,state:previous});
    const spot=this.spot,now=this.now();
    if(spot?.sourceId!=='polymarket'||spot.round!==roundStart(now)||!Number.isFinite(spot.windowSeconds))return reject('RANGE_OFFICIAL_PRICE_MISSING','等待本场同预言机窗口的 Polymarket 官方价格');
    if(!Number.isFinite(spot.price)||spot.price<=0||!Number.isFinite(spot.at)||spot.at>now||now-spot.at>6000)return reject('RANGE_PRICE_STALE','当前官方报价无效或超过 6000 毫秒新鲜度上限，继续等待更新');
    const {config,candidate:analysisCandidate,vote}=this.analysis();
    const completedRounds=[];
    if(previous?.breakoutStartRound!=null&&!previous.breakoutConfirmedAt){
      for(let round=previous.breakoutStartRound;round<roundStart(now);round+=300){
        const history=this.store.historicalRound(round),prediction=this.store.roundPrediction(round),storedVote=this.store.vote(round),official=this.store.marketPrices(spot.windowSeconds,round,round+300)[0];
        const valid=value=>Number.isFinite(value)&&value>0;
        let close=null,source=null;
        if(history?.status==='void'||storedVote?.source==='official_void'){completedRounds.push({round,invalid:true});continue;}
        if(valid(history?.close)){close=history.close;source='polymarket_event_metadata';}
        else if(valid(official?.close)){close=official.close;source='polymarket_crypto_price';}
        else if(prediction?.oracleWindow===spot.windowSeconds&&valid(prediction.close)){close=prediction.close;source=prediction.source;}
        else if(valid(storedVote?.close)&&['official','polymarket_event_metadata','polymarket_crypto_price'].includes(storedVote.source)){close=storedVote.close;source=storedVote.source;}
        else {const tick=this.store.lastSecondTick(round,spot.windowSeconds);if(tick){close=tick.price;source='polymarket_last_second';}}
        if(!valid(close)){completedRounds.push({round,invalid:true});continue;}
        completedRounds.push({round,close,source});
      }
    }
    let candidate={...analysisCandidate,completedRounds},usingSavedRange=false;
    if(!candidate.levelAnalysis.ready&&previous?.configId===config.id&&previous.oracleWindow===spot.windowSeconds&&previous.supportSource==='rolling_extremes'&&
      [previous.lower,previous.upper].every(value=>Number.isFinite(value)&&value>0)&&previous.upper>=previous.lower){
      usingSavedRange=true;
      candidate=classifyRange({...candidate,lower:previous.lower,upper:previous.upper,actualLower:previous.actualLower,actualUpper:previous.actualUpper,
        widthPercent:previous.widthPercent,start:previous.windowStart,end:previous.windowEnd,
        levelAnalysis:{...candidate.levelAnalysis,ready:true,start:previous.levelWindowStart,end:previous.levelWindowEnd}},spot.price);
    }
    let state=rangeRegime(previous,candidate,vote,spot,config.id,now);
    if(!state)return {...reject(candidate.code||'RANGE_NOT_STABLE',candidate.message),candidate,vote};
    state=this.store.saveRangeState(state);
    if(!state.direction&&vote.complete&&vote.up===vote.down)return {direction:null,code:'RANGE_TIE_PREVIOUS_UNAVAILABLE',
      message:`区间初次选向同票（UP ${vote.up} / DOWN ${vote.down}），上一场 #${vote.previousRound} ${vote.previousSource==='official_void'?'官方判定作废，没有涨跌方向':'尚无有效官方结果和预测方向'}，继续等待`,state,candidate,vote};
    if(!state.direction)return {direction:null,code:'RANGE_VOTE_INCOMPLETE',message:
      `已形成稳定区间；近 ${config.lookbackHours} 小时仅取得 ${vote.covered}/${vote.expected} 场方向，继续补齐`,state,candidate,vote};
    const edgeMessage=()=>{
      const support=state.direction==='UP',lower=state.breakoutReferenceLower??state.lower,upper=state.breakoutReferenceUpper??state.upper,width=upper-lower;
      const boundary=support?lower:upper,near=support?lower+width*RANGE_EDGE_FRACTION:upper-width*RANGE_EDGE_FRACTION;
      const name=support?'下支撑位':'上压力位',cross=support?'跌破':'上穿',outside=support?spot.price<lower:spot.price>upper;
      const base=state.rangeBaseDirection?`回到区间中部后恢复基础方向 ${state.rangeBaseDirection}`:'回到区间中部后按场次统计选向';
      if(!outside)return `已贴近${name}，当前信号买 ${state.direction}：当前价 ${spot.price.toFixed(2)} ${support?'≤':'≥'} 贴近阈值 ${near.toFixed(2)}（区间${support?'下':'上'}侧 ${RANGE_EDGE_FRACTION*100}%）；${name} ${boundary.toFixed(2)}，尚未${cross}。${base}`;
      const line=support?lower-width*config.breakoutPercent/100:upper+width*config.breakoutPercent/100;
      const enough=support?spot.price<line:spot.price>line;
      const pending=state.breakoutPendingDirection;
      const reason=!enough?`距离尚未严格超过突破线 ${line.toFixed(2)}（区间宽度的 ${config.breakoutPercent}%）`:
        pending=== (support?'DOWN':'UP')?`已越过突破线 ${line.toFixed(2)}，连续收盘确认 ${state.breakoutCount??0}/${config.breakoutRounds} 场`:
        `已越过突破线 ${line.toFixed(2)}，本方向尚未累计收盘确认${pending?`；仍在核对先前 ${pending==='UP'?'上穿':'下破'}的收盘数据`:''}`;
      return `已${cross}${name} ${boundary.toFixed(2)}，当前价 ${spot.price.toFixed(2)}；${reason}，突破尚未确认。当前仍按${support?'支撑位':'压力位'}反向买 ${state.direction}`;
    };
    const previousResultText=vote.previousDirection?
      `当前上一场 #${vote.previousRound}：${vote.previousDirection}（${vote.previousSource==='official'?'官方最终结果':'未结算，场次预计结果'}）`:
      `当前上一场 #${vote.previousRound}：${vote.previousSource==='official_void'?'官方作废，无涨跌方向':'正在获取场次预计结果'}`;
    const message=state.phase==='range'?
      (state.lockedDirectionRule==='range_edge_reversion'?edgeMessage():
      state.lockedDirectionRule==='tie_reverse_previous'?`区间基础方向 ${state.direction}；首次选向时 UP ${state.upCount} / DOWN ${state.downCount} 同票，采用当时上一场 #${state.lockedPreviousRound} ${state.lockedPreviousDirection}（${state.lockedPreviousSource==='official'?'官方最终结果':'场次预计结果'}）的反方向。${previousResultText}；区间内继续沿用已锁定方向`:
      `价格位于历史区间，已锁定 ${state.direction}，选向时 UP ${state.upCount} / DOWN ${state.downCount}；每场开盘沿用。当前上界 ${state.actualUpper.toFixed(2)} / 下界 ${state.actualLower.toFixed(2)}，每场结束重算`):
      `已连续 ${state.breakoutCount} 场收盘${state.direction==='UP'?'上穿压力':'下破支撑'}并超过参考区间宽度的 ${config.breakoutPercent}%，突破确认买 ${state.direction}；从场次 #${state.tradeFromRound} 起执行，回到参考区间内重新按区间规则选向`;
    return {direction:state.direction,code:null,message:usingSavedRange?`历史起止价正在补齐，暂沿用已保存区间 ${state.lower.toFixed(2)}–${state.upper.toFixed(2)}；${message}`:message,state,candidate,vote,usingSavedRange,directionRule:state.lockedDirectionRule};
  }

  snapshot(){
    const state=super.snapshot(),analysis=this.analysis();
    return {...state,strategy:'range_breakout',rangeConfig:analysis.config,rangeAnalysis:{candidate:analysis.candidate,vote:analysis.vote},rangeState:this.store.rangeState(),historyRepair:{...this.historyRepair}};
  }
  requiresCurrentOpening(){return false;}
  entryGuard(){
    const signal=this.signal();if(signal.code)return signal;
    if(signal.state.tradeFromRound&&roundStart(this.now())<signal.state.tradeFromRound)return {code:'RANGE_BREAKOUT_NEXT_ROUND',message:`前次突破后的最早执行场次为 #${signal.state.tradeFromRound}，当前方向 ${signal.direction}；从该场开盘开始买入，本场不追单`};
    if(!this.spot.conditionId||this.spot.conditionId!==this.market?.conditionId)return {code:'RANGE_MARKET_MISMATCH',message:'当前官方报价与盘口不属于同一场市场，继续等待匹配数据'};
    return null;
  }
  orderSignalFields(){
    const decision=this.signal();
    return {signalRule:'range_regime',referencePrice:this.spot.currentOpen??null,signalPrice:this.spot.price,
      rangeSignal:{...decision.state,price:this.spot.price,priceAt:this.spot.at,directionRule:decision.directionRule,
        decisionUpCount:decision.state.upCount,decisionDownCount:decision.state.downCount,
        tiePreviousRound:decision.state.lockedPreviousRound,
        tiePreviousDirection:decision.state.lockedPreviousDirection,
        tiePreviousSource:decision.state.lockedPreviousSource}};
  }
  quote(book,budget,config,schedule){
    const valid=book.asks.map(level=>Number(level.price)).filter(price=>Number.isFinite(price)&&price>0&&price<1),best=Math.min(...valid);
    if(Number.isFinite(best)&&best>=0.5)throw Object.assign(Error(`所选方向卖一 ${best.toFixed(6)} 不低于 0.500000；此策略严格要求买价 < 0.50，本次不买入`),{code:'RANGE_PRICE_NOT_BELOW_HALF',evidence:{budget,bestAsk:best,maxPrice:0.5}});
    const tick=Number(book.tickSize);
    const cap=Number.isFinite(tick)&&tick>0?(Math.ceil(0.5/tick-1e-10)-1)*tick:0.5;
    const quote=simulateFill(book,budget,{...config,maxPrice:cap},schedule,{strictTicks:true});
    return {...quote,priceLimit:Math.min(quote.priceLimit,cap)};
  }
  configure(mode,input){
    if(mode!=='paper')throw Error('此页面仅支持模拟交易');
    const account=this.store.account(mode);
    if(account.running||this.store.pending(mode).length)throw Error('请暂停策略，并等待已有订单结算后修改参数');
    const {rangeConfig,...trading}=input;
    const config=validateConfig(trading);
    if(config.entryDelay!==0||config.maxPrice!==0.5||config.sameDirectionOnly||config.followPreviousAtOpen||config.reverseSignal)throw Error('区间策略固定零延迟、区间/突破方向和买价严格低于 0.50');
    const requested=rangeConfig?validateRangeConfig(rangeConfig):null;
    const sharedChanged=config.entryWindow!==account.config.entryWindow||requested&&Object.keys(requested).some(key=>requested[key]!==this.store.rangeConfig()[key]);
    if(sharedChanged&&[...(this.followers||[])].some(engine=>engine.store.account('live').running||engine.store.pending('live').length))throw Error('实盘正在运行或有待结算订单，请先暂停实盘并等待结算后修改共用区间参数和检测时长');
    this.store.transaction(()=>{if(requested)this.store.saveRangeConfig(requested);this.store.saveAccount({...account,config});});
    this.analysisCache=null;this.log(mode,'info','区间策略参数已保存；资金序列保留');this.broadcast();
  }
  pollVoteHistory(){
    if(this.voteTask||this.closing||!this.venue.fetch||!this.venue.public||this.now()-this.lastVotePoll<5000)return;
    this.lastVotePoll=this.now();
    const config=this.store.rangeConfig(),latest=roundStart(this.now())-300;
    const requested=Array.from({length:config.lookbackHours*12},(_,i)=>latest-i*300)
      .filter(round=>{const vote=this.store.vote(round);return !vote||!['official','official_void'].includes(vote.source)&&this.now()-vote.updatedAt>=30000;}).slice(0,20);
    if(!requested.length)return;
    this.voteTask=(async()=>{
      const query=new URLSearchParams({limit:String(requested.length)});
      for(const round of requested)query.append('slug',`btc-updown-5m-${round}`);
      const response=await this.venue.fetch(`https://gamma-api.polymarket.com/events?${query}`);
      if(!response.ok)throw Error(`区间方向历史接口 HTTP ${response.status}`);
      const events=await response.json();if(!Array.isArray(events))throw Error('区间方向历史响应无效');
      if(this.closing)return;
      const wanted=new Set(requested.map(round=>`btc-updown-5m-${round}`));
      const selected=events.filter(event=>wanted.has(event.slug));
      const ids=[...new Set(selected.flatMap(event=>event.markets||[]).filter(m=>wanted.has(m.slug)).map(m=>m.conditionId).filter(Boolean))];
      let resolutions=[];
      try{if(ids.length)resolutions=await this.venue.public.fetchResolutions({conditionIds:ids});}
      catch(error){this.runtimeIssue('paper',`官方历史兑付暂不可用，先按平台起止价统计：${safeError(error)}`);}
      if(this.closing)return;
      for(const round of requested){
        const slug=`btc-updown-5m-${round}`,event=selected.find(item=>item.slug===slug),market=event?.markets?.find(item=>item.slug===slug);
        const history=normalizeHistoricalRound(round,event,resolutions.find(item=>item.conditionId===market?.conditionId));
        this.store.saveHistoricalRound(history,this.now());
        const outcome=history.status==='resolved'?history.result:history.open>0&&history.close>0?(history.close>=history.open?'UP':'DOWN'):null;
        this.store.saveVote({round,outcome,source:history.status==='resolved'?'official':history.status==='void'?'official_void':outcome?'polymarket_event_metadata':'pending',open:history.open,close:history.close,updatedAt:this.now()});
      }
      this.voteRevision++;
    })().catch(error=>{if(!this.closing)this.runtimeIssue('paper',`区间历史方向暂不可用，自动重试：${safeError(error)}`);}).finally(()=>{this.voteTask=null;});
  }
  async tick(){this.pollVoteHistory();this.backfillMarketHistory();return super.tick();}
}
