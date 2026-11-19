import {Engine} from './engine.mjs';
import {roundStart,simulateFill,validateConfig} from './strategy.mjs';
import {RoundHistory,HISTORY_COUNT} from './history.mjs';

export const PREVIOUS_ENTRY_SECONDS=15;
export const PREVIOUS_PRICE_CAP=0.7;
const SAME_ADVANTAGE=5;
const validDirection=direction=>direction==='UP'||direction==='DOWN';
const inverse=direction=>direction==='UP'?'DOWN':'UP';
const fixedConfig=config=>({...config,entryDelay:0,entryWindow:PREVIOUS_ENTRY_SECONDS,
  sameDirectionOnly:false,followPreviousAtOpen:true,reverseSignal:false});

export class PreviousDirectionEngine extends Engine{
  constructor(store,venue,{marketStore,previousMarketStore,mode='paper',...options}={}){
    super(store,venue,{...options,modes:[mode]});this.marketStore=marketStore;this.previousMarketStore=previousMarketStore;this.mode=mode;
    this.history=new RoundHistory(venue,{now:this.now,store,lookback:HISTORY_COUNT+1});
    const account=store.account(mode),config=fixedConfig({...account.config,
      maxPrice:mode==='live'||!account.config.followPreviousAtOpen?PREVIOUS_PRICE_CAP:account.config.maxPrice});
    if(Object.keys(config).some(key=>config[key]!==account.config[key]))store.saveAccount({...account,config});
  }
  configure(mode,input){
    if(mode!==this.mode)throw Error('不支持此交易模式');
    const current=this.store.account(mode).config;
    const config=validateConfig(fixedConfig({...input,
      minPrice:Object.hasOwn(input,'minPrice')?input.minPrice:current.minPrice,
      maxPrice:mode==='live'?PREVIOUS_PRICE_CAP:Object.hasOwn(input,'maxPrice')?input.maxPrice:current.maxPrice}));
    if(mode==='paper'&&config.minPrice>config.maxPrice)throw Error('最低买入价不能高于最高买入价');
    return super.configure(mode,config);
  }
  async start(mode){
    if(mode!==this.mode)throw Error('不支持此交易模式');
    if(mode==='live'&&!this.venue.readiness().authenticated)throw Error('请先连接此页面的交易钱包，再启动实盘');
    return super.start(mode);
  }
  async attempt(mode){if(mode===this.mode)return super.attempt(mode);}
  resetStakeCycle(account){
    if(account.mode===this.mode&&account.config.baseAmount<=account.config.maxAmount&&account.losses>account.config.maxDoublings)
      return {...account,losses:0,cycle:account.cycle+1,cyclePnl:0};
    return super.resetStakeCycle(account);
  }
  stakeCycleLimitLabel(){return '单笔金额或加倍次数上限';}
  async tick(){
    if(!this.closing&&this.venue.fetch&&this.venue.public)
      this.history.poll()?.catch(error=>this.runtimeIssue('system',`历史场次刷新失败：${error.message}`));
    return super.tick();
  }
  marketResult(round){
    const stores=[this.store,this.previousMarketStore,this.marketStore].filter(Boolean);
    const rows=stores.map(store=>store.historicalRound(round));
    const vote=this.marketStore?.vote(round);
    for(const row of rows){
      if(row?.status==='void')return {round,direction:null,source:'official_void'};
      if(row?.status==='resolved'&&validDirection(row.result))return {round,direction:row.result,source:'official'};
    }
    if(vote?.source==='official_void')return {round,direction:null,source:'official_void'};
    if(vote?.source==='official'&&validDirection(vote.outcome))return {round,direction:vote.outcome,source:'official'};
    const metadata=rows.find(row=>row?.open>0&&row?.close>0);
    if(metadata)return {round,direction:metadata.close>=metadata.open?'UP':'DOWN',source:'polymarket_event_metadata'};
    const predictions=[...stores.map(store=>store.roundPrediction(round)),vote].filter(p=>validDirection(p?.outcome));
    const priority=['polymarket_event_metadata','polymarket_crypto_price','polymarket_last_second','polymarket_last_available'];
    for(const source of priority){const p=predictions.find(p=>p.source===source);if(p)return {round,direction:p.outcome,source};}
    return {round,direction:null,source:'pending'};
  }
  signal(start=roundStart(this.now())){
    const result=this.marketResult(start-300);
    let newer=result,same=0,reverse=0,estimated=0,sameStreak=0,atHead=true;
    // 40 evaluated rounds need 41 outcomes. Missing rounds break adjacency.
    for(let i=2;i<=HISTORY_COUNT+1;i++){
      const older=this.marketResult(start-i*300);
      const aligned=Boolean(newer.direction&&newer.direction===older.direction);
      if(atHead&&aligned)sameStreak++;else atHead=false;
      if(newer.direction&&older.direction){
        if(aligned)same++;else reverse++;
        if(newer.source!=='official'||older.source!=='official')estimated++;
      }
      newer=older;
    }
    const advantage=same-reverse;
    const stats={same,reverse,estimated,missing:HISTORY_COUNT-same-reverse,total:HISTORY_COUNT,rule:advantage>=SAME_ADVANTAGE?'same':'reverse'};
    const comparison=`近 ${stats.total} 场：同向命中 ${same} / 反向命中 ${reverse}${estimated?`，含预计 ${estimated} 场`:''}${stats.missing?`，${stats.missing} 场不可比较`:''}`;
    if(result.source==='official_void')return {...result,stats,code:'PREVIOUS_ROUND_VOID',message:`${comparison}；上一场 #${result.round} 已官方判定作废，没有 UP/DOWN 方向，本场跳过`};
    if(!result.direction)return {...result,stats,code:'PREVIOUS_DIRECTION_MISSING',message:`${comparison}；上一场 #${result.round} 尚无官方结果或预计方向，等待这一场的数据`};
    if(stats.rule==='reverse'&&sameStreak===2)return {...result,previousDirection:result.direction,direction:null,stats,code:'PREVIOUS_REVERSE_COOLDOWN',message:`${comparison}；当前选反买，最近两场都与各自上一场同向（连续三场 ${result.direction}），本场暂停买入，下一场恢复判断`};
    const source={official:'官方最终结果',polymarket_event_metadata:'官方场次起止价预计',polymarket_crypto_price:'官方接口起止价预计',polymarket_last_second:'同源末秒价预计',polymarket_last_available:'同源收盘前最后可用价预计'}[result.source];
    const direction=stats.rule==='same'?result.direction:inverse(result.direction);
    const choice=`同向减反向为 ${advantage} 场，${stats.rule==='same'?`达到 ${SAME_ADVANTAGE} 场门槛，跟随上一场`:`不足 ${SAME_ADVANTAGE} 场，反买`}`;
    return {...result,previousDirection:result.direction,direction,stats,code:null,message:`${comparison}；${choice}；上一场 #${result.round} ${source} ${result.direction}，本场买 ${direction}`};
  }
  entryDirection(_account,start){return this.signal(start).direction;}
  entryGuard(_account,start){const signal=this.signal(start);return signal.code?signal:null;}
  quote(book,budget,config,schedule){return simulateFill(book,budget,this.mode==='paper'?config:{...config,maxPrice:PREVIOUS_PRICE_CAP},schedule,
    {strictTicks:true,ignoreSlippage:true,minimumBestAsk:this.mode==='paper'?config.minPrice:null});}
  orderSignalFields(_account,start){
    const s=this.signal(start);
    return {entryReason:s.message,signalRule:`previous_round_rolling_${s.stats.rule}`,referencePrice:null,signalPrice:null};
  }
  snapshot(){
    const s=super.snapshot(),source=this.chartRangeSource;
    const analysis=source?.spot?.round===s.round&&source?.spot?.windowSeconds===s.spot?.windowSeconds&&s.spot?source.analysis():null;
    const zone=analysis?.candidate;
    const chartRange=zone?.levelAnalysis?.ready&&Number.isFinite(zone.lower)&&zone.upper>zone.lower
      ?{lower:zone.lower,upper:zone.upper,edgePercent:analysis.config.edgePercent,phase:'reference'}:null;
    return {...s,strategy:'previous_round_rolling',entrySignal:this.signal(),chartRange};
  }
}
