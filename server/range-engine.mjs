import {MomentumEngine} from './momentum.mjs';
import {normalizeHistoricalRound} from './history.mjs';
import {roundStart,simulateFill,validateConfig} from './strategy.mjs';
import {safeError} from './polymarket.mjs';
import {stableRange,classifyRange,rangeRegime,RANGE_BUCKET_MS,levelWindow,validateRangeConfig} from './range-strategy.mjs';

export class RangeEngine extends MomentumEngine {
  constructor(store,venue,options={}){
    super(store,venue,options);
    this.voteRevision=0;this.lastVotePoll=0;this.voteTask=null;this.analysisCache=null;
  }
  voteSummary(config,window){
    const latest=roundStart(this.now())-300,expected=config.lookbackHours*12;
    let up=0,down=0,covered=0,official=0,estimated=0,voids=0,previousDirection=null,previousSource=null;
    for(let i=0;i<expected;i++){
      const round=latest-i*300;
      let vote=this.store.vote(round),history=this.store.historicalRound(round),prediction=this.store.roundPrediction(round);
      if(history?.status==='resolved'&&history.result){vote=this.store.saveVote({round,outcome:history.result,source:'official',open:history.open,close:history.close,updatedAt:history.updatedAt||this.now()});}
      else if(history?.status==='void')vote=this.store.saveVote({round,source:'official_void',updatedAt:history.updatedAt||this.now()});
      else if(prediction&&prediction.oracleWindow===window)vote=this.store.saveVote({...prediction,source:prediction.source,updatedAt:prediction.observedAt});
      if(!vote?.outcome&&!['official_void'].includes(vote?.source)){
        const opening=this.store.roundOpening(round),tick=opening?.oracleWindow===window?this.store.lastSecondTick(round,window):null;
        if(tick)vote=this.store.saveVote({round,outcome:tick.price>=opening.open?'UP':'DOWN',source:'polymarket_last_second',open:opening.open,close:tick.price,updatedAt:this.now()});
      }
      if(vote?.outcome){covered++;if(vote.outcome==='UP')up++;else down++;if(vote.source==='official')official++;else estimated++;}
      else if(vote?.source==='official_void'){covered++;voids++;}
      if(i===0){previousDirection=vote?.outcome??null;previousSource=vote?.source??null;}
    }
    return {up,down,expected,covered,official,estimated,voids,complete:covered===expected,direction:covered===expected?(up>down?'UP':down>up?'DOWN':null):null,
      previousRound:latest,previousDirection,previousSource};
  }
  analysis(){
    const config=this.store.rangeConfig(),window=this.spot?.windowSeconds,end=Math.floor(this.now()/RANGE_BUCKET_MS)*RANGE_BUCKET_MS;
    const key=`${config.id}:${window}:${end}:${this.voteRevision}`;
    // Keep candle analysis cached, but re-read results so a just-arrived previous
    // forecast or official correction is used even within the same five seconds.
    if(this.analysisCache?.key===key)return {...this.analysisCache,candidate:classifyRange(this.analysisCache.candidate,this.spot?.price),vote:this.voteSummary(config,window)};
    const start=end-config.lookbackHours*3600000;
    const levelStart=levelWindow(this.now()).start;
    const history=Number.isFinite(window)?this.store.rangeBars(window,Math.min(start,levelStart),end):[];
    const bars=history.filter(bar=>bar.bucket>=start);
    const candidate=stableRange(bars,config,this.now(),history,this.spot?.price),vote=this.voteSummary(config,window);
    this.analysisCache={key,config,candidate,vote};return this.analysisCache;
  }
  signal(){
    const previous=this.store.rangeState();
    const reject=(code,message)=>({direction:null,code,message,state:previous});
    const spot=this.spot,now=this.now();
    if(spot?.sourceId!=='polymarket'||spot.round!==roundStart(now)||!Number.isFinite(spot.windowSeconds))return reject('RANGE_OFFICIAL_PRICE_MISSING','等待本场同预言机窗口的 Polymarket 官方价格');
    if(!Number.isFinite(spot.price)||spot.price<=0||!Number.isFinite(spot.at)||spot.at>now||now-spot.at>6000)return reject('RANGE_PRICE_STALE','当前官方报价无效或超过 6000 毫秒新鲜度上限，继续等待更新');
    const {config,candidate,vote}=this.analysis();
    let state=rangeRegime(previous,candidate,vote,spot,config.id,now);
    if(!state)return {...reject(candidate.code||'RANGE_NOT_STABLE',candidate.message),candidate,vote};
    state=this.store.saveRangeState(state);
    if(!state.direction&&vote.complete&&vote.up===vote.down)return {direction:null,code:'RANGE_TIE_PREVIOUS_UNAVAILABLE',
      message:`区间初次选向同票（UP ${vote.up} / DOWN ${vote.down}），上一场 #${vote.previousRound} ${vote.previousSource==='official_void'?'官方判定作废，没有涨跌方向':'尚无有效官方结果和预测方向'}，继续等待`,state,candidate,vote};
    if(!state.direction)return {direction:null,code:'RANGE_VOTE_INCOMPLETE',message:
      `已形成稳定区间；近 ${config.lookbackHours} 小时仅取得 ${vote.covered}/${vote.expected} 场方向，继续补齐`,state,candidate,vote};
    const message=state.phase==='range'?
      (state.lockedDirectionRule==='range_edge_reversion'?`价格靠近${state.direction==='DOWN'?'上压力':'下支撑'}，买 ${state.direction}；回到区间中部后沿用原有区间选向逻辑`:
      state.lockedDirectionRule==='tie_reverse_previous'?`区间已锁定 ${state.direction}：选向时 UP ${state.upCount} / DOWN ${state.downCount} 同票，取上一场 #${state.lockedPreviousRound} ${state.lockedPreviousDirection} 的反方向；每场开盘沿用，不再按票数重新选向`:
      `价格位于历史区间，已锁定 ${state.direction}，选向时 UP ${state.upCount} / DOWN ${state.downCount}；每场开盘沿用。当前上界 ${state.actualUpper.toFixed(2)} / 下界 ${state.actualLower.toFixed(2)}，每场结束重算`):
      `${state.phase==='breakout_up'?'上穿实际最高价':'下穿实际最低价'} ${(state.phase==='breakout_up'?state.actualUpper:state.actualLower).toFixed(2)}，持续买 ${state.direction}；${state.tradeFromRound?`从场次 #${state.tradeFromRound} 开盘起沿用`:'每场开盘沿用'}，价格回到更新后的历史区间内即按票数重新选向`;
    return {direction:state.direction,code:null,message,state,candidate,vote,directionRule:state.lockedDirectionRule};
  }

  snapshot(){
    const state=super.snapshot(),analysis=this.analysis();
    return {...state,strategy:'range_breakout',rangeConfig:analysis.config,rangeAnalysis:{candidate:analysis.candidate,vote:analysis.vote},rangeState:this.store.rangeState()};
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
  async tick(){this.pollVoteHistory();return super.tick();}
}
