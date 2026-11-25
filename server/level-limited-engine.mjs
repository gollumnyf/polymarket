import {Store} from './store.mjs';
import {PreviousDirectionEngine} from './previous-direction-engine.mjs';
import {ChartRange} from './chart-range.mjs';
import {roundStart} from './strategy.mjs';
import {LEVEL_LIMITED_VERSION} from './strategy-versions.mjs';
import {safeError} from './polymarket.mjs';

export class LevelLimitedStore extends Store{
  constructor(path,{sourceConfig,chartSettings={levelLookbackMinutes:60,middlePercent:60},levelLagMinutes=15}={}){
    super(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS level_limit_settings(
      id INTEGER PRIMARY KEY CHECK(id=1),level_lookback_minutes INTEGER NOT NULL CHECK(level_lookback_minutes BETWEEN 15 AND 1440 AND level_lookback_minutes%5=0),
      middle_percent REAL NOT NULL CHECK(middle_percent>0 AND middle_percent<=100),
      level_lag_minutes INTEGER NOT NULL CHECK(level_lag_minutes BETWEEN 0 AND 1440 AND level_lag_minutes%5=0),updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS level_limit_order_signals(
        order_id TEXT PRIMARY KEY REFERENCES orders(id),lower_price REAL NOT NULL,upper_price REAL NOT NULL,
        observed_price REAL NOT NULL,price_at INTEGER NOT NULL,oracle_window INTEGER NOT NULL,
        levels_round INTEGER NOT NULL,observed_at INTEGER NOT NULL)`);
    if(!this.db.prepare('SELECT id FROM level_limit_settings WHERE id=1').get())this.transaction(()=>{
      this.db.prepare('INSERT INTO level_limit_settings VALUES (1,?,?,?,?)')
        .run(chartSettings.levelLookbackMinutes,chartSettings.middlePercent,levelLagMinutes,Date.now());
      if(sourceConfig){const account=this.account('paper');this.saveAccount({...account,config:{...sourceConfig},
        balance:sourceConfig.initialBalance,startingBalance:sourceConfig.initialBalance});}
    });
  }
  chartSettings(){return this.db.prepare('SELECT level_lookback_minutes AS levelLookbackMinutes,middle_percent AS middlePercent FROM level_limit_settings WHERE id=1').get();}
  levelLagMinutes(){return this.db.prepare('SELECT level_lag_minutes value FROM level_limit_settings WHERE id=1').get().value;}
  saveChartSettings(input){
    for(const key of Object.keys(input??{}))if(!['levelLookbackMinutes','middlePercent'].includes(key))throw Error('不支持的区间参数：'+key);
    const value={...this.chartSettings(),...input};
    if(!Number.isInteger(value.levelLookbackMinutes)||value.levelLookbackMinutes<15||value.levelLookbackMinutes>1440||value.levelLookbackMinutes%5!==0)
      throw Error('支撑 / 压力回看时间须为 15 至 1440 分钟，以 5 分钟为单位');
    if(!Number.isFinite(value.middlePercent)||value.middlePercent<=0||value.middlePercent>100)throw Error('中间蓝色区域占比必须大于 0%，且不超过 100%');
    this.db.prepare('UPDATE level_limit_settings SET level_lookback_minutes=?,middle_percent=?,updated_at=? WHERE id=1')
      .run(value.levelLookbackMinutes,value.middlePercent,Date.now());
    return this.chartSettings();
  }
  reserveOrder(order,book=null){
    return this.transaction(()=>{
      if(!super.reserveOrder(order,book))return false;
      const value=order.levelLimit;
      if(value)this.db.prepare('INSERT INTO level_limit_order_signals VALUES (?,?,?,?,?,?,?,?)')
        .run(order.id,value.lower,value.upper,value.price,value.priceAt,value.oracleWindow,value.levelsRound,order.createdAt);
      return true;
    });
  }
  clearPaperOrders(){
    return this.transaction(()=>{
      this.db.exec("DELETE FROM level_limit_order_signals WHERE order_id IN (SELECT id FROM orders WHERE mode='paper' AND status IN ('won','lost','void','rejected'))");
      return super.clearPaperOrders();
    });
  }
}

export class LevelLimitedEngine extends PreviousDirectionEngine{
  constructor(store,venue,{levels,...options}={}){
    super(store,venue,{...options,mode:'paper'});this.levels=levels;
    this.strategyVersion=store.registerStrategyVersion(LEVEL_LIMITED_VERSION);
  }
  async refreshMarketBooks(start,tasks){
    const feed=this.venue.priceFeed,account=this.store.account('paper');
    if(account.running&&this.now()/1000-start<=account.config.entryWindow&&
      (feed?.round!==start||!Number.isFinite(feed.spec?.seconds))&&this.venue.preparePriceFeed){
      // Oracle identity is required to filter entry prices, even with no chart open.
      // Fetch only that identity alongside market/books; target/history stay deferred.
      tasks.push(this.venue.preparePriceFeed(start,()=>!this.closing).then(()=>{delete this.levelFeedError;})
        .catch(error=>{if(!this.closing)this.levelFeedError={round:start,message:safeError(error)};}));
    }
    return super.refreshMarketBooks(start,tasks);
  }
  levelCheck(start=roundStart(this.now())){
    const now=this.now(),feed=this.venue.priceFeed;
    const block=(code,message,fields={})=>({allowed:false,code,message,...fields});
    if(feed?.round!==start||!Number.isFinite(feed.spec?.seconds))return block('LEVEL_PRICE_ROUND_MISSING',`等待本场 #${start} 的官方BTC价格流及预言机口径；当前价格流场次 ${feed?.round==null?'未确认':'#'+feed.round}${this.levelFeedError?.round===start?'；'+this.levelFeedError.message:''}`);
    const point=feed.recent?.(1)?.at(-1);
    if(!Number.isFinite(point?.price)||point.price<=0||!Number.isFinite(point.time))return block('LEVEL_PRICE_MISSING',`本场 #${start} 尚无有效官方BTC报价`);
    if(point.time<start*1000)return block('LEVEL_PRICE_BEFORE_OPEN',`本场 #${start} 的官方报价尚未到达：最新采样早于开盘 ${start*1000-point.time} 毫秒`);
    if(point.time>now+2000)return block('LEVEL_PRICE_FUTURE',`BTC报价采样超前 ${point.time-now} 毫秒，超过允许的2000毫秒`);
    if(now-point.time>6000)return block('LEVEL_PRICE_STALE',`BTC报价过期：采样距今 ${now-point.time} 毫秒，允许最大6000毫秒`);
    // A local calculation is an entry dependency; it never waits for an API.
    this.levels?.poll(this.store.account('paper').running||this.canRunBackground());
    const current=this.levels?.current(),zone=current?.zone;
    if(current?.round!==start||!Number.isFinite(zone?.lower)||!Number.isFinite(zone?.upper)||zone.upper<=zone.lower)
      return block('LEVELS_NOT_READY',`本场 #${start} 的独立支撑位、压力位尚未就绪，等待历史行情补齐`);
    const fields={lower:zone.lower,upper:zone.upper,price:point.price,priceAt:point.time,
      oracleWindow:feed.spec.seconds,levelsRound:zone.fallbackFrom??start};
    const prices=`BTC ${point.price.toFixed(6)}，支撑 ${zone.lower.toFixed(6)}，压力 ${zone.upper.toFixed(6)}`;
    if(point.price<zone.lower)return block('BELOW_SUPPORT',`低于支撑位 ${(zone.lower-point.price).toFixed(6)}：${prices}，禁止下单`,fields);
    if(point.price>zone.upper)return block('ABOVE_RESISTANCE',`高于压力位 ${(point.price-zone.upper).toFixed(6)}：${prices}，禁止下单`,fields);
    return {allowed:true,code:null,message:`完整支撑压力区间内（含边界）：${prices}${zone.fallbackFrom!=null?'；沿用紧邻上一场区间':''}`, ...fields};
  }
  signal(start=roundStart(this.now())){
    const signal=super.signal(start);if(signal.code)return signal;
    const level=this.levelCheck(start);
    return {...signal,direction:level.allowed?signal.direction:null,code:level.code,message:signal.message+'；'+level.message};
  }
  orderSignalFields(account,start){const level=this.levelCheck(start);return {...super.orderSignalFields(account,start),signalRule:'previous_round_level_limited',oracleWindow:level.oracleWindow,levelLimit:level};}
  snapshot(){return {...super.snapshot(),levelLimit:this.levelCheck()};}
}

export function independentLevelRange(store,marketStore,feed,{now=Date.now}={}){
  const source={
    get spot(){return {round:feed.round,windowSeconds:feed.spec?.seconds};},
    store:{chartSettings:()=>store.chartSettings(),saveChartSettings:input=>store.saveChartSettings(input),
      rangeConfig:()=>({levelLagMinutes:store.levelLagMinutes()}),
      rangeBars:(...args)=>marketStore.rangeBars(...args),marketPrices:(...args)=>marketStore.marketPrices(...args)},
  };
  const range=new ChartRange(source,feed,{now}),configure=range.configure.bind(range);
  range.configure=input=>{
    if(store.account('paper').running||store.pending('paper').length)throw Error('请暂停本模拟盘，并等待持仓结算后修改区间参数');
    return configure(input);
  };
  return range;
}
