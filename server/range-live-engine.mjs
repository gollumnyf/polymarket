import {RangeEngine} from './range-engine.mjs';
import {validateConfig} from './strategy.mjs';
import {validateRangeConfig} from './range-strategy.mjs';

// Share market decisions, never copy paper orders or the paper martingale cycle.
// The existing live database retains its orders, logs, balances and reservations.
export class RangeLiveEngine extends RangeEngine {
  constructor(store,venue,source,options={}){
    super(store,venue,{...options,modes:['live']});
    this.source=source;
    source.followers??=new Set();source.followers.add(this);
    this.syncExecutionConfig();
  }
  syncExecutionConfig(){
    const account=this.store.account('live'),config={...account.config,entryDelay:0,
      entryWindow:this.source.store.account('paper').config.entryWindow,maxPrice:0.5,
      sameDirectionOnly:false,followPreviousAtOpen:false,reverseSignal:false};
    if(Object.keys(config).some(key=>config[key]!==account.config[key]))this.store.saveAccount({...account,config});
  }
  backfillMarketHistory(){}
  pollVoteHistory(){}
  analysis(){return this.source.analysis();}
  signal(){
    const result=this.source.signal(),sourceSpot=this.source.spot;
    if(result.code)return result;
    if(this.spot?.round!==sourceSpot?.round||this.spot?.conditionId!==sourceSpot?.conditionId||this.spot?.windowSeconds!==sourceSpot?.windowSeconds)
      return {...result,direction:null,code:'RANGE_FOLLOW_MARKET_MISMATCH',message:'实盘与区间突破模拟的市场场次或预言机窗口不一致，等待同一市场数据后再下单'};
    return result;
  }
  snapshot(){
    this.syncExecutionConfig();
    const result=super.snapshot();
    return {...result,rangeState:this.source.store.rangeState(),historyRepair:{...this.source.historyRepair},strategySource:'range'};
  }
  orderSignalFields(){
    const result=super.orderSignalFields();
    // Regime/config IDs belong to their own database; copy typed decision evidence.
    const {id,...shared}=this.source.store.rangeConfig();
    const config=this.store.saveRangeConfig(shared);
    const state=this.store.saveRangeState({...result.rangeSignal,configId:config.id});
    return {...result,rangeSignal:{...result.rangeSignal,...state}};
  }
  async start(mode){this.syncExecutionConfig();return super.start(mode);}
  async attempt(mode){this.syncExecutionConfig();return super.attempt(mode);}
  configure(mode,input){
    if(mode!=='live')throw Error('此页面仅支持实盘交易');
    const account=this.store.account(mode);
    if(account.running||this.store.pending(mode).length)throw Error('请暂停实盘，并等待已有订单结算后修改参数');
    const {rangeConfig,...trading}=input,config=validateConfig(trading),shared=this.source.store.rangeConfig();
    const requested=rangeConfig?validateRangeConfig(rangeConfig):null;
    if(requested&&Object.keys(requested).some(key=>requested[key]!==shared[key])||config.entryWindow!==this.source.store.account('paper').config.entryWindow)
      throw Error('区间参数和检测时长跟随区间突破模拟，请在模拟盘中修改');
    if(config.entryDelay!==0||config.maxPrice!==0.5||config.sameDirectionOnly||config.followPreviousAtOpen||config.reverseSignal)
      throw Error('实盘跟随区间突破策略，固定零延迟和买价严格低于 0.50');
    this.store.saveAccount({...account,config});this.log(mode,'info','实盘资金参数已保存；区间方向跟随模拟盘，马丁资金序列独立');this.broadcast();
  }
}
