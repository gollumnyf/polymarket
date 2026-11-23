import {Engine} from './engine.mjs';
import {safeError} from './polymarket.mjs';
import {ROUND_SECONDS,roundStart,simulateFill,validateConfig} from './strategy.mjs';
import {RoundHistory,HISTORY_COUNT} from './history.mjs';
import {HISTORY_DISPLAY_COUNT} from '../src/history-summary.mjs';

export const PREVIOUS_ENTRY_SECONDS=15;
export const PREVIOUS_PRICE_CAP=0.7;
const MARKET_PREFETCH_MS=12000;
const sameMarket=(a,b)=>a?.round===b?.round&&a?.conditionId===b?.conditionId&&
  a?.outcomes?.length===b?.outcomes?.length&&a?.outcomes?.every(o=>b.outcomes.some(other=>other.direction===o.direction&&other.assetId===o.assetId));
const validDirection=direction=>direction==='UP'||direction==='DOWN';
const inverse=direction=>direction==='UP'?'DOWN':'UP';
const fixedConfig=config=>({...config,entryDelay:0,entryWindow:PREVIOUS_ENTRY_SECONDS,
  sameDirectionOnly:false,followPreviousAtOpen:true,reverseSignal:false});

export class PreviousDirectionEngine extends Engine{
  constructor(store,venue,{marketStore,previousMarketStore,mode='paper',...options}={}){
    super(store,venue,{...options,modes:[mode]});this.marketStore=marketStore;this.previousMarketStore=previousMarketStore;this.mode=mode;
    this.history=new RoundHistory(venue,{now:this.now,store,lookback:Math.max(HISTORY_COUNT+1,HISTORY_DISPLAY_COUNT),displayCount:HISTORY_DISPLAY_COUNT});
    const account=store.account(mode),config=fixedConfig({...account.config,
      maxPrice:!account.config.followPreviousAtOpen?PREVIOUS_PRICE_CAP:account.config.maxPrice});
    if(Object.keys(config).some(key=>config[key]!==account.config[key]))store.saveAccount({...account,config});
  }
  configure(mode,input){
    if(mode!==this.mode)throw Error('不支持此交易模式');
    const current=this.store.account(mode).config;
    const config=validateConfig(fixedConfig({...input,
      minPrice:Object.hasOwn(input,'minPrice')?input.minPrice:current.minPrice,
      maxPrice:Object.hasOwn(input,'maxPrice')?input.maxPrice:current.maxPrice}));
    if(config.minPrice>config.maxPrice)throw Error('最低买入价不能高于最高买入价');
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
  hasExecutionPriority(now=this.now()){
    if(!this.store.account(this.mode).running)return false;
    const elapsed=now-roundStart(now)*1000;
    return elapsed<=PREVIOUS_ENTRY_SECONDS*1000||elapsed>=ROUND_SECONDS*1000-MARKET_PREFETCH_MS;
  }
  prefetchNextMarket(){
    if(this.closing||this.marketPrefetchTask||!this.store.account(this.mode).running)return;
    const now=this.now(),round=roundStart(now)+ROUND_SECONDS;
    if(round*1000-now>MARKET_PREFETCH_MS||this.prefetchedMarket?.round===round||
      (this.marketPrefetchRound===round&&now-this.marketPrefetchAt<2000))return;
    this.marketPrefetchRound=round;this.marketPrefetchAt=now;
    this.marketPrefetchTask=Promise.resolve().then(()=>this.venue.market(round)).then(market=>{
      if(!this.closing&&market?.round===round&&roundStart(this.now())<round)this.prefetchedMarket=market;
    }).catch(()=>{/* A missing upcoming market falls back to the normal opening request. */})
      .finally(()=>{this.marketPrefetchTask=null;});
  }
  marketPollInterval(start){
    return !this.market?.active&&this.now()/1000-start<=PREVIOUS_ENTRY_SECONDS
      ?1000:super.marketPollInterval(start);
  }
  async refreshMarketBooks(start,tasks){
    const cached=this.prefetchedMarket;
    if(this.market||cached?.round!==start)return super.refreshMarketBooks(start,tasks);
    this.prefetchedMarket=null;
    this.lastMarketPoll=this.now();
    // Only the token IDs are reused. Request fresh books and market status after the bell.
    const booksRequest=Promise.resolve().then(()=>this.venue.books(cached)).then(books=>({books}),error=>({error}));
    let fresh;
    try{fresh=await this.venue.market(start);}
    catch(error){this.errors.market=safeError(error);return;}
    await Promise.allSettled(tasks);
    if(this.closing||roundStart(this.now())!==start)return;
    this.market=fresh;delete this.errors.market;
    this.rememberOpening();
    if(fresh?.round!==start)return;
    if(!sameMarket(cached,fresh)){await this.refreshBooks(fresh);return;}
    const result=await booksRequest;
    if(this.closing||roundStart(this.now())!==start)return;
    if(result.error)this.errors.books=safeError(result.error);
    else{this.books=result.books;delete this.errors.books;}
  }
  async tick(){
    this.prefetchNextMarket();
    const now=this.now();
    if(!this.closing&&this.hasExecutionPriority(now)&&now-roundStart(now)*1000>=ROUND_SECONDS*1000-MARKET_PREFETCH_MS){
      this.collectPriceTicks();
      return; // Do not start obsolete book requests just before the next opening.
    }
    if(!this.closing&&this.canRunBackground()&&this.venue.fetch&&this.venue.public)
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
    const stats={same,reverse,estimated,missing:HISTORY_COUNT-same-reverse,total:HISTORY_COUNT,rule:'reverse'};
    const comparison=`近 ${stats.total} 场：同向命中 ${same} / 反向命中 ${reverse}${estimated?`，含预计 ${estimated} 场`:''}${stats.missing?`，${stats.missing} 场不可比较`:''}`;
    if(result.source==='official_void')return {...result,stats,code:'PREVIOUS_ROUND_VOID',message:`${comparison}；上一场 #${result.round} 已官方判定作废，没有 UP/DOWN 方向，本场跳过`};
    if(!result.direction)return {...result,stats,code:'PREVIOUS_DIRECTION_MISSING',message:`${comparison}；上一场 #${result.round} 尚无官方结果或预计方向，等待这一场的数据`};
    if(sameStreak===1)return {...result,previousDirection:result.direction,direction:null,stats,code:'PREVIOUS_REVERSE_COOLDOWN',message:`${comparison}；刚形成连续两场 ${result.direction}，本场跳过；下一场恢复反向买入检查，同一段走势不再重复跳过`};
    const source={official:'官方最终结果',polymarket_event_metadata:'官方场次起止价预计',polymarket_crypto_price:'官方接口起止价预计',polymarket_last_second:'同源末秒价预计',polymarket_last_available:'同源收盘前最后可用价预计'}[result.source];
    const direction=inverse(result.direction);
    return {...result,previousDirection:result.direction,direction,stats,code:null,message:`${comparison}；固定买上一场反方向；上一场 #${result.round} ${source} ${result.direction}，本场买 ${direction}`};
  }
  entryDirection(_account,start){return this.signal(start).direction;}
  entryGuard(_account,start){const signal=this.signal(start);return signal.code?signal:null;}
  quote(book,budget,config,schedule){return simulateFill(book,budget,config,schedule,
    {strictTicks:true,ignoreSlippage:true,minimumBestAsk:config.minPrice});}
  orderSignalFields(_account,start){
    const s=this.signal(start);
    return {entryReason:s.message,signalRule:'previous_round_fixed_reverse',referencePrice:null,signalPrice:null};
  }
  snapshot(){
    return {...super.snapshot(),strategy:'previous_round_fixed_reverse',entrySignal:this.signal(),redemption:this.redemption?.snapshot()};
  }
}
