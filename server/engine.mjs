import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { nextAmount, riskReason, afterSettlement, simulateFill, money, roundStart, validateConfig,resetAtAmountLimit } from './strategy.mjs';
import { safeError } from './polymarket.mjs';
import { recordRoundSignals, SIGNAL_SAMPLE_SECONDS } from './round-signals.mjs';
import { predictionFromPrices, projectedAccount, roundPredictionFromPrices } from './predictions.mjs';
import {oppositeDirection} from '../src/entry-mode.mjs';

export class Engine extends EventEmitter {
  constructor(store, venue, { now = () => Date.now(),modes=['paper','live'] } = {}) {
    super(); this.store = store; this.venue = venue; this.now = now;
    this.spot = null; this.market = null; this.books = {}; this.busy = false;
    this.errors = {}; this.lastMarketPoll = 0; this.lastSettlementPoll = 0; this.lastBalancePoll = 0;
    this.status = { paper: '策略未启动', live: '策略未启动' };
    this.lastLog = new Map();
    this.lastEntryLog=new Map();
    this.entryBlocks = this.store.entryBlocks();
    this.settlementTask=null; this.closing=false;
    this.roundPredictionTasks=new Map();
    this.spotTask=null;this.lastSpotPoll=0;
    this.modes=modes;
    this.canRunBackground=()=>true;
    this.roundPredictionRetryAt=new Map();
  }
  log(mode, level, message) {
    const key = `${mode}:${message}`;
    if (this.now() - (this.lastLog.get(key) || 0) < 30000) return;
    this.lastLog.set(key, this.now()); this.store.log(mode, level, message);
  }
  snapshot() {
    const accounts = {};
    for (const mode of ['paper', 'live']) {
      const account = this.store.account(mode);
      const pending=this.store.pending(mode), projected=this.projectAccount(account,pending), execution=this.executionAccount(projected);
      accounts[mode] = { ...account, nextAmount: this.nextAmount(execution), stakeStep:execution.stakeLosses??projected.losses, stakeProtected:!!execution.stakeProtection, status: this.status[mode],
        projectedLosses:projected.losses,projectedCycle:projected.cycle,projectedCount:projected.projectedCount,
        entryBlock: this.entryBlocks[mode] || null, activeOrders: pending,
        orderCount:this.store.orderCount(mode), historyVersion:this.store.historyVersion(mode) };
    }
    return { time: this.now(), round: roundStart(this.now()),
      previousRoundPrediction:this.store.roundPrediction(roundStart(this.now())-300),spot: this.spot, market: this.market,
      books: this.books, errors: this.errors, ...(this.includeSnapshotTicks===false?{}:{ticks:this.store.ticks()}), accounts, live: this.venue.readiness() };
  }
  broadcast() {
    try{this.emit('update',this.snapshot());}
    catch(error){console.error(`状态推送失败，下次继续重试：${safeError(error)}`);}
  }
  runtimeIssue(mode,message,level='warning'){
    try{
      if(this.store.account(mode)?.running)this.status[mode]=message;
      this.log(mode,level,message);
    }catch(error){console.error(`运行异常，下一次检查继续：${safeError(error)}；${safeError(message)}`);}
  }
  pollPredictions(){
    void this.refreshPredictions().catch(error=>this.runtimeIssue('system',`场次预测暂不可用，下次自动重试：${safeError(error)}`,'error'));
    void this.refreshPreviousPrediction().catch(error=>this.runtimeIssue('system',`上一场预测暂不可用，下次自动重试：${safeError(error)}`,'error'));
  }
  rememberOpening(spot=this.spot,market=this.market){
    const conditionId=spot?.conditionId || (market&&spot&&market.round===spot.round?market.conditionId:null);
    if(spot?.sourceId==='polymarket'&&conditionId&&Number.isFinite(spot.currentOpen)&&spot.currentOpen>0&&Number.isFinite(spot.windowSeconds))
      this.store.saveRoundOpening({round:spot.round,conditionId,open:spot.currentOpen,oracleWindow:spot.windowSeconds,observedAt:this.now()});
  }
  collectPriceTicks(){
    for(const point of this.venue.drainPriceTicks?.()||[])
      this.store.tick(point.time,point.price,'polymarket',point.oracleWindow??this.spot?.windowSeconds??null);
  }
  pollSpot(){
    if(this.spotTask||this.now()-this.lastSpotPoll<1000)return;
    this.lastSpotPoll=this.now();
    this.spotTask=Promise.resolve().then(()=>this.venue.spot()).then(spot=>{
      if(this.closing)return;
      this.spot=spot;this.collectPriceTicks();
      this.store.tick(spot.at,spot.price,spot.sourceId||'polymarket',spot.windowSeconds??null);
      this.rememberOpening();delete this.errors.spot;
      if(spot.sourceId==='polymarket'){
        const delays=[...SIGNAL_SAMPLE_SECONDS,...['paper','live'].map(mode=>this.store.account(mode).config.entryDelay)];
        recordRoundSignals(this.store,spot.round,spot.currentOpen,delays,{oracleWindow:spot.windowSeconds??null});
      }
      this.pollPredictions();
    }).catch(error=>{if(!this.closing)this.errors.spot=safeError(error);}).finally(()=>{this.spotTask=null;});
  }
  async tick() {
    if (this.busy || this.closing) return;
    this.busy = true;
    try {
      const start = roundStart(this.now());
      this.rememberOpening();this.collectPriceTicks();
      if (this.market?.round !== start) { this.market = null; this.books = {}; this.lastMarketPoll = 0; }
      // The previous result is an entry dependency; the other work stays off the awaited path.
      if(this.canRunBackground()){
        this.pollPredictions();this.pollSpot();
      }else if(this.modes.some(mode=>this.store.account(mode).running)){
        void this.refreshPreviousPrediction().catch(error=>this.runtimeIssue('system',safeError(error)));
      }
      await this.refreshMarketBooks(start,[]);
      if(this.closing)return;
      this.collectPriceTicks();
      if(!this.canRunBackground()&&this.modes.includes('live')&&this.store.pending('live').some(order=>order.status==='confirming'||order.status==='uncertain'))
        void this.settlePending(); // A fill still being verified can block entry; do not defer it.

      for (const mode of this.modes){
        try{await this.attempt(mode);}
        catch(error){this.runtimeIssue(mode,`本次交易检查失败，策略继续运行，下次重试：${safeError(error)}`,'error');}
      }
      if(this.canRunBackground()){
        this.pollPredictions();
        if(this.now()-this.lastSettlementPoll>=7000){
          this.lastSettlementPoll=this.now();
          void this.settlePending();
        }
        this.pollDisplayBalance();
      }
    } catch (error) { this.runtimeIssue('system',`本次行情检查失败，策略继续运行，下次重试：${safeError(error)}`,'error'); }
    finally { this.busy = false; this.broadcast(); }
  }
  pollDisplayBalance(){
    if(this.redemption||this.displayBalanceTask||!this.venue.readiness().authenticated||this.now()-this.lastBalancePoll<15000)return;
    this.lastBalancePoll=this.now();
    this.displayBalanceTask=Promise.resolve().then(()=>this.venue.balance()).then(()=>{delete this.errors.wallet;})
      .catch(error=>{this.errors.wallet=safeError(error);}).finally(()=>{this.displayBalanceTask=null;});
  }
  marketPollInterval(_start){return this.errors.market?1000:10000;}
  async refreshMarketBooks(start,tasks){
    if(!this.market||this.now()-this.lastMarketPoll>=this.marketPollInterval(start)){
      this.lastMarketPoll=this.now();
      tasks.push(this.venue.market(start).then(market=>{this.market=market;delete this.errors.market;})
        .catch(error=>{this.errors.market=safeError(error);}));
    }
    await Promise.allSettled(tasks);
    if(this.closing)return;
    this.rememberOpening();
    if(this.market?.round===start)await this.refreshBooks(this.market);
  }
  async refreshBooks(market){
    try{this.books=await this.venue.books(market);delete this.errors.books;}
    catch(error){this.errors.books=safeError(error);}
  }
  pause(mode, reason) {
    const account = this.store.account(mode);
    this.store.saveAccount({ ...account, running: false, reason });
    this.status[mode] = reason; this.log(mode, 'warning', reason);
  }
  resetStakeCycle(account){return resetAtAmountLimit(account);}
  nextAmount(account){return nextAmount(account);}
  riskReason(account,available){return riskReason(account,available,a=>this.nextAmount(a));}
  stakeCycleLimitLabel(){return '单笔上限';}
  projectAccount(account,pending){return projectedAccount(account,pending,a=>this.resetStakeCycle(a));}
  executionAccount(projected){return projected;}
  accountAfterSettlement(account,pnl,won,order){return afterSettlement(account,pnl,won,a=>this.resetStakeCycle(a));}
  isPreviousStakeCycle(order,account){return false;}
  normalizeStakeCycle(mode) {
    const account=this.store.account(mode), normalized=this.resetStakeCycle(account);
    if(normalized!==account){
      this.store.saveAccount(normalized);
      this.log(mode,'info',`下一笔 ${this.nextAmount(account).toFixed(2)} pUSD 超过${this.stakeCycleLimitLabel()}；恢复首笔 ${account.config.baseAmount.toFixed(2)} 开始新轮`);
    }
    return normalized;
  }
  async start(mode) {
    let account = this.normalizeStakeCycle(mode);
    let available = account.balance;
    let walletError=null;
    if (mode === 'live') {
      const ready=this.venue.readiness();
      if(!ready.enabled||!ready.configured)throw new Error('实盘尚未启用或钱包未配置，请先完成本机配置');
      try{available=await this.venue.balance();}
      catch(error){walletError=`钱包检查失败，策略已启动并等待自动重试：${safeError(error)}`;}
    }
    // Read state again after async authentication, so a settlement cannot be overwritten.
    account = this.store.account(mode);
    const reason = this.riskReason(this.executionAccount(this.projectAccount(account,this.store.pending(mode))), available);
    this.store.saveAccount({ ...account, running: true, reason: null });
    this.status[mode] = '等待入场信号'; this.log(mode, 'info', '策略启动；每场只买入一次；错误不自动暂停');
    const uncertain=this.store.pending(mode).find(order=>['uncertain','placing','confirming'].includes(order.status));
    if(walletError||reason||uncertain)this.runtimeIssue(mode,walletError||reason||`订单 ${uncertain.id} 成交结果待确认，策略保持运行并继续核对；确认前不新增买入`);
    this.broadcast();
  }
  stop(mode) { this.pause(mode, '已手动暂停；已有持仓继续等待结算'); this.broadcast(); }
  configure(mode, input) {
    const account = this.store.account(mode);
    if (account.running || this.store.pending(mode).length) throw new Error('请暂停策略，并等待已有订单结算后修改参数');
    const config = validateConfig(input);
    // Do not turn a settings edit into an account reset or cancel the losing streak.
    this.store.saveAccount({ ...account, config });
    this.log(mode, 'info', '策略参数已保存'); this.broadcast();
  }
  resetPaper() {
    if (this.store.account('paper').running || this.store.pending('paper').length) throw new Error('请暂停模拟策略，并等待持仓结算后重置');
    const config = this.store.account('paper').config;
    this.store.saveAccount(this.store.freshAccount('paper', config));
    this.status.paper = '模拟账户已重置';
    this.log('paper', 'info', '模拟资金已重置，历史订单和场次去重记录保留'); this.broadcast();
  }
  blockEntry(mode,round,message,details={},book=null) {
    const account=this.store.account(mode),at=this.now(),elapsed=(at-round*1000)/1000;
    const direction=details.direction??this.entryDirection(account,round)??null;
    const budget=this.nextAmount(this.executionAccount(this.projectAccount(account,this.store.pending(mode))));
    const code=details.code||'ENTRY_BLOCKED';
    const fullMessage=`场次 #${round}，开盘后 ${elapsed.toFixed(3)} 秒${direction?`，准备买入 ${direction}`:''}：${message}`;
    const diagnostic=this.store.saveEntryDiagnostic({configId:account.configId,budget,elapsed,entryDelay:account.config.entryDelay,entryWindow:account.config.entryWindow,
      referencePrice:this.spot?.currentOpen??null,signalPrice:this.spot?.price??null,spotRound:this.spot?.round??null,spotAt:this.spot?.at??null,
      marketRound:this.market?.round??null,marketAt:this.market?.fetchedAt??null,marketActive:this.market?.active??null,bookAt:book?.fetchedAt??null,oracleWindow:this.spot?.windowSeconds??null,
      maxPrice:account.config.maxPrice,slippage:account.config.slippage,...details,mode,round,code,direction,message:fullMessage,at},book);
    const previous=this.entryBlocks[mode],key=`${mode}:${round}:${code}`,lastLogged=this.lastEntryLog.get(key);
    if(previous?.round!==round||previous?.code!==code||lastLogged==null||at-lastLogged>=30000){
      this.store.log(mode,'warning',`本场暂未买入：${fullMessage}`);this.lastEntryLog.set(key,at);
    }
    this.entryBlocks[mode]={...diagnostic,evidenceAvailable:true};
    this.store.saveEntryBlock(mode,this.entryBlocks[mode]);
    this.status[mode]=fullMessage;
  }
  predictionWaitReason(round,order=null) {
    const saved=this.store.roundPrediction(round);
    if(saved)return `场次 #${round} 已保存预计 ${saved.outcome}，该订单的预测记录尚未同步`;
    const opening=this.store.roundOpening(round)||(['current_round_open','current_round_reverse'].includes(order?.signalRule)?{open:order.referencePrice,oracleWindow:order.oracleWindow}:null);
    const reference=Number.isFinite(opening?.open)&&opening.open>0?`本地起始价 ${opening.open.toFixed(6)}`:'本地缺少该场起始价';
    const tick=Number.isFinite(opening?.oracleWindow)?this.store.closingTick(round,opening.oracleWindow):null;
    const sample=tick?`收盘前最近同源采样已保存 ${tick.price.toFixed(6)}，距收盘 ${((round+300)*1000-tick.time)/1000} 秒，等待预测写入`:Number.isFinite(opening?.oracleWindow)?`已向前追溯，本地仍无该场收盘前的有效同源报价（窗口 ${opening.oracleWindow}s）`:'缺少已核实的预言机窗口，不能选择历史报价';
    return `场次 #${round} 未保存预计结果；${this.roundPredictionTasks.has(round)?'起止价接口请求进行中':'接口起止价结果尚未保存'}；${reference}；${sample}`;
  }
  async attempt(mode) {
    let account = this.store.account(mode);
    if (!account.running) { this.status[mode] = account.reason || '策略未启动'; return; }
    account=this.normalizeStakeCycle(mode);
    if(mode==='paper')for(const incomplete of this.store.pending(mode).filter(order=>order.status==='placing')){
      this.store.saveOrder({...incomplete,status:'rejected',note:'模拟成交事务未完成，未扣除资金；本场保留去重，后续场次继续运行'});
      this.runtimeIssue(mode,`模拟订单 ${incomplete.id} 事务未完成，本场不重复买入，后续场次继续运行`);
    }
    const start = roundStart(this.now());
    if (this.store.hasRound(mode, start)) { this.status[mode] = '本场已执行，等待下一场'; return; }
    const elapsed = this.now() / 1000 - start;
    if (elapsed < account.config.entryDelay) { this.status[mode] = `等待设定的入场时间：开盘后 ${elapsed.toFixed(3)} 秒，设定 ${account.config.entryDelay} 秒，还需 ${(account.config.entryDelay-elapsed).toFixed(3)} 秒`; return; }
    if (elapsed > account.config.entryWindow) {
      const block = this.entryBlocks[mode];
      if(block?.round===start&&block.code==='ENTRY_WINDOW_CLOSED'){this.status[mode]=`已过入场窗口，等待下一场；${block.message}`;return;}
      const previous=block?.round===start?`窗口内最近拦截：${block.message}`:'入场窗口内没有保存有效检查依据，无法还原当时的行情';
      this.blockEntry(mode,start,`已过入场窗口：当前 ${elapsed.toFixed(3)} 秒 > 截止 ${account.config.entryWindow} 秒，本场停止买入；${previous}`,{code:'ENTRY_WINDOW_CLOSED'});
      this.status[mode]=`已过入场窗口，等待下一场；${this.entryBlocks[mode].message}`;return;
    }
    const pending = this.store.pending(mode);
    const unconfirmed=pending.find(o=>o.status!=='open');
    if(unconfirmed){this.blockEntry(mode,start,`订单成交结果待确认：场次 #${unconfirmed.round}，订单 ${unconfirmed.id}，状态 ${unconfirmed.status}；确认前禁止新增买入`,{code:'ORDER_UNCONFIRMED',relatedRound:unconfirmed.round});return;}
    const holding=pending.find(o=>o.end*1000>this.now());
    if(holding){this.blockEntry(mode,start,`本场持仓中：场次 #${holding.round} 的订单尚未结束，距离结束 ${(holding.end-this.now()/1000).toFixed(3)} 秒`,{code:'POSITION_NOT_ENDED',relatedRound:holding.round});return;}
    for(const order of pending){
      if(order.prediction||this.isPreviousStakeCycle(order,account))continue;
      const prices=this.store.roundPrediction(order.round)||this.lastSecondPrediction(order.round,order);
      if(!prices||prices.conditionId!==order.conditionId||order.oracleWindow!=null&&prices.oracleWindow!=null&&order.oracleWindow!==prices.oracleWindow)continue;
      this.store.saveRoundPrediction(prices);this.applyOrderPrediction(order,prices);order.prediction=this.store.prediction(order.id);
    }
    const missing=pending.find(o=>!o.prediction&&!this.isPreviousStakeCycle(o,account));
    if(missing){this.blockEntry(mode,start,`等待上一场起止价预测：${this.predictionWaitReason(missing.round,missing)}`,{code:'ORDER_PREDICTION_MISSING',relatedRound:missing.round});return;}
    const follow=account.config.followPreviousAtOpen;
    if(!follow){
      if(!this.spot){this.blockEntry(mode,start,'未收到 BTC 参考行情，当前没有报价可用于判断方向',{code:'SPOT_MISSING'});return;}
      if(this.spot.round!==start){this.blockEntry(mode,start,`BTC 行情场次不匹配：需要 #${start}，当前缓存为 #${this.spot.round}`,{code:'SPOT_WRONG_ROUND'});return;}
      if(this.errors.spot){this.blockEntry(mode,start,`BTC 行情请求失败：${this.errors.spot}`,{code:'SPOT_FETCH_ERROR'});return;}
      if(!Number.isFinite(this.spot.at)||this.now()-this.spot.at>6000){const age=Number.isFinite(this.spot.at)?this.now()-this.spot.at:null;this.blockEntry(mode,start,age==null?'BTC 行情缺少有效采样时间，不能验证新鲜度':`BTC 行情过期：采样距今 ${age} 毫秒，允许最大 6000 毫秒，超出 ${age-6000} 毫秒`,{code:age==null?'SPOT_TIME_MISSING':'SPOT_STALE',dataAgeMs:age,maxAgeMs:6000});return;}
    }
    if(!this.market){this.blockEntry(mode,start,`尚未取得本场 Polymarket 市场 #${start}${this.errors.market?`；接口失败：${this.errors.market}`:''}`,{code:'MARKET_MISSING'});return;}
    if(this.market.round!==start){this.blockEntry(mode,start,`市场场次不匹配：需要 #${start}，当前缓存为 #${this.market.round}`,{code:'MARKET_WRONG_ROUND'});return;}
    if(this.errors.market){this.blockEntry(mode,start,`Polymarket 市场请求失败：${this.errors.market}`,{code:'MARKET_FETCH_ERROR'});return;}
    if(!this.market.active){const state=this.market.marketState;this.blockEntry(mode,start,`本场市场未开放接单：场次 #${start}，${state?`接口 active=${String(state.active)}、closed=${String(state.closed)}、acceptingOrders=${String(state.acceptingOrders)}；要求 active=true、closed=false、acceptingOrders=true`:`缓存可交易标志 active=${String(this.market.active)}`}`,{code:'MARKET_INACTIVE'});return;}
    if(!Number.isFinite(this.market.fetchedAt)||this.now()-this.market.fetchedAt>20000){const age=Number.isFinite(this.market.fetchedAt)?this.now()-this.market.fetchedAt:null;this.blockEntry(mode,start,age==null?'市场数据缺少有效获取时间':`市场数据过期：获取距今 ${age} 毫秒，允许最大 20000 毫秒，超出 ${age-20000} 毫秒`,{code:age==null?'MARKET_TIME_MISSING':'MARKET_STALE',dataAgeMs:age,maxAgeMs:20000});return;}
    const guard=this.entryGuard(account,start);
    if(guard){this.blockEntry(mode,start,guard.message,{code:guard.code});return;}
    const direction = this.entryDirection(account,start);
    if (!follow&&this.requiresCurrentOpening()&&(!Number.isFinite(this.spot.currentOpen) || this.spot.currentOpen <= 0)) {
      this.blockEntry(mode,start,`等待 Polymarket 本场起始价：场次 #${start}，接口当前起始价=${String(this.spot.currentOpen)}，暂不生成入场方向`,{code:'OPENING_PRICE_MISSING'});return;
    }
    if (!direction) { this.blockEntry(mode,start,follow?`跟随上一场：等待上一场预计方向；${this.predictionWaitReason(start-300)}`:this.spot.price===this.spot.currentOpen?`参考价格持平：起始价与当前价均为 ${this.spot.price.toFixed(6)}，没有 UP/DOWN 信号`:`未生成有效方向：起始价 ${String(this.spot.currentOpen)}，当前价 ${String(this.spot.price)}，原始信号 ${String(this.spot.direction)}`,{code:follow?'PREVIOUS_DIRECTION_MISSING':'SIGNAL_NOT_DIRECTIONAL'}); return; }
    const alignment=this.alignmentReason(account,start,direction);
    if (alignment) {this.blockEntry(mode,start,alignment,{code:'SAME_DIRECTION_FILTER'});return;}
    const book = this.books[direction];
    if(this.errors.books){this.blockEntry(mode,start,`盘口请求失败：${this.errors.books}`,{code:'BOOK_FETCH_ERROR'});return;}
    if(!book){this.blockEntry(mode,start,`缺少 ${direction} 盘口：该方向没有可用买卖盘快照`,{code:'BOOK_MISSING'});return;}
    if(!Number.isFinite(book.fetchedAt)||this.now()-book.fetchedAt>6000){const age=Number.isFinite(book.fetchedAt)?this.now()-book.fetchedAt:null;this.blockEntry(mode,start,age==null?`${direction} 盘口缺少有效获取时间`:`${direction} 盘口过期：获取距今 ${age} 毫秒，允许最大 6000 毫秒，超出 ${age-6000} 毫秒`,{code:age==null?'BOOK_TIME_MISSING':'BOOK_STALE',dataAgeMs:age,maxAgeMs:6000},book);return;}
    let available = account.balance;
    if (mode === 'live') {
      try { available = await this.venue.balance(); }
      catch (e) { this.blockEntry(mode,start,`钱包检查失败，本次跳过并自动重试：${safeError(e)}`,{code:'WALLET_CHECK_FAILED'},book); return; }
    }
    // A pause or configuration update can arrive while checking the wallet.
    account = this.store.account(mode);
    if (!account.running) return;
    const updatedGuard=this.entryGuard(account,start);
    if(updatedGuard){this.blockEntry(mode,start,updatedGuard.message,{code:updatedGuard.code});return;}
    const updatedDirection=this.entryDirection(account,start);
    const updatedAlignment=this.alignmentReason(account,start,updatedDirection);
    if (updatedAlignment) {this.blockEntry(mode,start,updatedAlignment,{code:'SAME_DIRECTION_FILTER'});return;}
    if (updatedDirection !== direction) {this.blockEntry(mode,start,`入场信号已改变：钱包检查前 ${direction}，检查后 ${updatedDirection??'无有效方向'}，取消本次买入`,{code:'SIGNAL_CHANGED',direction:updatedDirection},book);return;}
    const tradeAccount=this.executionAccount(this.projectAccount(account,this.store.pending(mode)));
    const reason = this.riskReason(tradeAccount, available);
    if (reason) { this.blockEntry(mode,start,reason,{code:'RISK_LIMIT',availableBalance:available},book);return; }
    let quote;
    try { quote = this.quote(book, this.nextAmount(tradeAccount), account.config, this.market.feeSchedule); }
    catch (e) {
      this.blockEntry(mode,start,safeError(e),{...e.evidence,code:e.code||'QUOTE_FAILED'},book); return;
    }
    if(roundStart(this.now())!==start){this.blockEntry(mode,start,`报价期间场次已切换：报价针对 #${start}，当前 #${roundStart(this.now())}，取消旧场订单`,{code:'ROUND_CHANGED'},book);return;}
    if(this.now()/1000-start>account.config.entryWindow){this.blockEntry(mode,start,`报价完成时已超时：开盘后 ${(this.now()/1000-start).toFixed(3)} 秒 > 入场截止 ${account.config.entryWindow} 秒`,{code:'QUOTE_AFTER_DEADLINE'},book);return;}
    if(this.now()-book.fetchedAt>6000){this.blockEntry(mode,start,`报价完成时盘口过期：获取距今 ${this.now()-book.fetchedAt} 毫秒 > 允许 6000 毫秒`,{code:'BOOK_STALE_AFTER_QUOTE',dataAgeMs:this.now()-book.fetchedAt,maxAgeMs:6000},book);return;}
    const finalGuard=this.entryGuard(account,start);
    if(finalGuard){this.blockEntry(mode,start,finalGuard.message,{code:finalGuard.code},book);return;}
    const quoteGuard=this.quoteGuard(quote);
    if(quoteGuard){this.blockEntry(mode,start,quoteGuard.message,{code:quoteGuard.code},book);return;}
    if(this.entryDirection(account,start)!==direction){this.blockEntry(mode,start,'成交计算后方向发生变化，取消本次买入，等待重新检查',{code:'SIGNAL_CHANGED_AFTER_QUOTE'},book);return;}
    const outcome = this.market.outcomes.find(o => o.direction === direction);
    const order = { id: randomUUID(), mode, session: account.session, round: start, end: start + 300,
      slug: this.market.slug, conditionId: this.market.conditionId, assetId: outcome.assetId,
      outcomeIndex: outcome.index, direction, budget: this.nextAmount(tradeAccount), doubling: tradeAccount.stakeLosses??tradeAccount.losses,
      status: 'placing', createdAt: this.now(), referencePrice: this.spot?.round===start?this.spot.currentOpen:null,
      signalRule: account.config.reverseSignal?'current_round_reverse':follow?'previous_round_prediction':'current_round_open',
      signalPrice:this.spot?.round===start?this.spot.price:null,priceSource:this.spot?.round===start?this.spot.source||null:null,
      oracleWindow:this.spot?.round===start?this.spot.windowSeconds??null:this.store.roundOpening(start)?.oracleWindow??null,
      feeSchedule: this.market.feeSchedule, pnl: null,...this.orderSignalFields(account,start) };
    order.entryReason=[order.entryReason||`入场规则 ${order.signalRule}：参考价 ${order.referencePrice}，当前价 ${order.signalPrice}，选择买 ${direction}`,
      `场次 #${start}，开盘后 ${((order.createdAt-start*1000)/1000).toFixed(3)} 秒；${tradeAccount.stakeLabel??`马丁第 ${order.doubling+1} 笔`}，预算 ${order.budget.toFixed(2)} pUSD；盘口卖一 ${book.asks[0]?.price}，预计成交均价 ${quote.price}，本次成交限价 ${quote.priceLimit}`].join('；');
    if(tradeAccount.stakeProtection)order.entryReason+='；'+tradeAccount.stakeProtection;
    const reserved=mode==='live'&&this.redemption?this.store.transaction(()=>{
      if(!this.store.reserveOrder(order,book))return false;
      this.redemption.bind(order,this.market.version);return true;
    }):this.store.reserveOrder(order,book);
    if(!reserved)return;
    if (mode === 'paper') {
      this.store.transaction(() => {
        this.store.saveOrder({ ...order, ...quote, status: 'open' });
        this.store.saveAccount({ ...account, balance: money(account.balance - quote.cost) });
      });
      this.log(mode, 'success', `本场买入 ${direction}，投入 ${quote.cost.toFixed(2)} pUSD（模拟）`);
    } else {
      try {
        const result = await this.venue.buy(order, quote, () => this.store.account('live').running &&
          roundStart(this.now()) === start && this.now() / 1000 - start <= account.config.entryWindow &&
          this.entryDirection(this.store.account('live'),start) === direction && !this.alignmentReason(this.store.account('live'),start,direction) && !this.quoteGuard(quote));
        if (!result.ok) {
          this.store.saveOrder({ ...order, status: 'rejected', note: safeError(result.message) });
          this.runtimeIssue(mode,`订单被拒绝：${safeError(result.message)}；本场不重复提交，下一场继续运行`); return;
        }
        this.store.saveOrder({ ...order, venueOrderId: result.orderId, status: 'confirming',
          tradeIds: result.tradeIds, note: '已提交 FOK，等待链上成交确认' });
        this.log(mode, 'info', `本场 ${direction} 订单已提交，等待实际成交确认`);
      } catch (e) {
        this.store.saveOrder({ ...order, status: 'uncertain', note: `提交结果不明：${safeError(e)}` });
        this.runtimeIssue(mode,'订单提交结果不明，策略保持运行并继续核对；确认前不新增买入，不重复提交');return;
      }
    }
    this.status[mode] = this.positionStatus();
  }
  positionStatus(){return '本场持仓中；结束后按平台起止价预计结果续投';}
  entryGuard(){return null;}
  requiresCurrentOpening(){return true;}
  orderSignalFields(){return {};}
  quote(book,budget,config,schedule){return simulateFill(book,budget,config,schedule);}
  quoteGuard(){return null;}
  alignmentReason(account,start,direction) {
    if (account.config.reverseSignal||account.config.followPreviousAtOpen||!account.config.sameDirectionOnly) return null;
    const previous=this.store.roundPrediction(start-300);
    if (!previous) return `同向过滤：等待上一场平台起止价的预计方向；${this.predictionWaitReason(start-300)}`;
    return direction === previous.outcome ? null : `同向过滤：本场 ${direction || '持平'} 与上一场预计 ${previous.outcome} 不一致，暂不买入`;
  }
  entryDirection(account,start){return account.config.reverseSignal?oppositeDirection(this.spot?.direction):account.config.followPreviousAtOpen?this.store.roundPrediction(start-300)?.outcome??null:this.spot?.direction;}
  lastSecondPrediction(round,order=null){
    let opening=this.store.roundOpening(round);
    if(!opening&&!order)order=['paper','live'].map(mode=>this.store.orderForRound(mode,round)).find(item=>['current_round_open','current_round_reverse'].includes(item?.signalRule)&&Number.isFinite(item.referencePrice)&&Number.isFinite(item.oracleWindow))||null;
    if(!opening&&['current_round_open','current_round_reverse'].includes(order?.signalRule)&&Number.isFinite(order.referencePrice)&&Number.isFinite(order.oracleWindow))
      opening={round,conditionId:order.conditionId,open:order.referencePrice,oracleWindow:order.oracleWindow};
    if(!opening)return null;
    const tick=this.store.closingTick(round,opening.oracleWindow);
    return tick?roundPredictionFromPrices(round,{...opening,close:tick.price,priceAt:tick.time,source:tick.source},this.now()):null;
  }
  applyOrderPrediction(order,prices){
    if(order?.status!=='open'||order.prediction&&order.prediction.source!=='polymarket_last_available'||this.now()<order.end*1000)return;
    const prediction=predictionFromPrices(order,prices,this.now());if(!prediction)return;
    const account=this.store.account(order.mode);
    const before=this.projectAccount(account,this.store.pending(order.mode)).amountLimitResets;
    const stored=this.store.savePrediction(prediction);
    if(order.prediction&&stored.source===order.prediction.source&&stored.priceAt===order.prediction.priceAt&&stored.close===order.prediction.close)return;
    const after=this.projectAccount(this.store.account(order.mode),this.store.pending(order.mode)).amountLimitResets;
    this.log(order.mode,'info',`场次 #${order.round} 预计${prediction.won?'获胜':'失利'}：起始 ${prediction.open} → ${prediction.source==='polymarket_last_second'?'同源末秒价':prediction.source==='polymarket_last_available'?'向前追溯同源报价':'平台终止价'} ${prediction.close}${prediction.source==='polymarket_last_available'?`（采样 ${new Date(prediction.priceAt).toISOString()}，距收盘 ${(order.end*1000-prediction.priceAt)/1000} 秒）`:''}${order.prediction?'；已更新之前的追溯预测':''}${this.isPreviousStakeCycle(order,account)?'；等待官方结算':'；资金序列按预计结果继续'}`);
    if(after>before)this.log(order.mode,'info',`预计下一笔超过${this.stakeCycleLimitLabel()}，恢复首笔 ${this.store.account(order.mode).config.baseAmount.toFixed(2)} 开始新轮`);
  }
  async getRoundPrediction(round,order=null) {
    let saved=this.store.roundPrediction(round);
    if ((!saved||saved.source==='polymarket_last_available') && this.venue.roundPrices) {
      if (!this.roundPredictionTasks.has(round)&&this.now()>=(this.roundPredictionRetryAt.get(round)||0)) {
        const task=(async()=>{
          const prices=await this.venue.roundPrices(order || {round,end:round+300});
          if (this.closing) return null;
          const prediction=roundPredictionFromPrices(round,prices,this.now());
          this.roundPredictionRetryAt.set(round,this.now()+5000);
          const result=prediction?this.store.saveRoundPrediction(prediction):this.store.roundPrediction(round);
          if(result)for(const pending of this.store.pending().filter(item=>item.round===round&&item.conditionId===result.conditionId&&(item.oracleWindow==null||result.oracleWindow==null||item.oracleWindow===result.oracleWindow)))this.applyOrderPrediction(pending,result);
          return result;
        })().catch(error=>{
          if(!this.closing){this.roundPredictionRetryAt.set(round,this.now()+(/429/.test(String(error.message))?15000:5000));this.runtimeIssue('system',`场次预测接口暂不可用，下次自动重试：${safeError(error)}`);}
          try{return this.closing?null:this.store.roundPrediction(round);}catch{return null;}
        }).finally(()=>this.roundPredictionTasks.delete(round));
        this.roundPredictionTasks.set(round,task);
      }
    }
    if(!saved||saved.source==='polymarket_last_available'){const fallback=this.lastSecondPrediction(round,order);if(fallback)saved=this.store.saveRoundPrediction(fallback);}
    if(!saved&&this.roundPredictionTasks.has(round))saved=await this.roundPredictionTasks.get(round);
    if (saved && order && (saved.conditionId !== order.conditionId ||
      (order.oracleWindow != null && saved.oracleWindow != null && order.oracleWindow !== saved.oracleWindow)))
      throw new Error('缓存的场次预计结果与下单市场或 TWAP 窗口不一致');
    return saved;
  }
  async refreshPreviousPrediction() {
    if (!['paper','live'].some(mode=>{const c=this.store.account(mode).config;return c.sameDirectionOnly||c.followPreviousAtOpen;})) return;
    try {await this.getRoundPrediction(roundStart(this.now())-300);}
    catch(error){this.log('system','warning',`上一场同向判断暂不可用：${safeError(error)}`);}
  }
  async refreshPredictions() {
    const groups=new Map();
    for (const order of this.store.pending()) {
      if (order.status !== 'open' || order.prediction&&order.prediction.source!=='polymarket_last_available' || this.now()<order.end*1000) continue;
      const key=`${order.round}:${order.conditionId}:${order.oracleWindow}`;
      if (!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(order);
    }
    await Promise.allSettled([...groups.values()].map(async orders=>{
      try {
        const prices=await this.getRoundPrediction(orders[0].round,orders[0]);
        if (this.closing) return;
        for (const item of orders) {
          const order=this.store.order(item.id);
          if (order?.status !== 'open' || order.prediction&&order.prediction.source!=='polymarket_last_available') continue;
          this.applyOrderPrediction(order,prices);
        }
      } catch (error) { this.log('system','warning',`场次预测价格暂不可用：${safeError(error)}`); }
    }));
  }
  settlePending() {
    if (this.settlementTask) return this.settlementTask;
    this.settlementTask=this.settleInOrder().catch(error=>{
      if (!this.closing) this.runtimeIssue('system',`结算核对失败，下次自动重试：${safeError(error)}`,'error');
    }).finally(()=>{this.settlementTask=null;if (!this.closing) this.broadcast();});
    return this.settlementTask;
  }
  async settleInOrder() {
    const blocked=new Set();
    for (let order of this.store.pending()) {
      if (this.closing) return;
      try {
        if (['confirming', 'uncertain'].includes(order.status) && order.mode === 'live') {
          const fill = await this.venue.reconcile(order);
          if (this.closing) return;
          if (fill?.rejected) {
            this.store.saveOrder({ ...order, status: 'rejected', note: fill.note });
            this.runtimeIssue('live','官方确认本场订单未成交；本场不重复提交，下一场继续运行'); continue;
          }
          if (fill) order = this.store.saveOrder({ ...order, ...fill, status: 'open', note: '实际成交已链上确认；手续费为按市场参数估算' });
          else {blocked.add(order.mode);continue;}
        }
        if (blocked.has(order.mode)) continue;
        if (!this.canRunBackground() || order.status !== 'open' || this.now() < order.end * 1000) {blocked.add(order.mode);continue;}
        const result = await this.venue.resolution(order);
        if (this.closing) return;
        if (!result) {blocked.add(order.mode);continue;}
        order=this.store.order(order.id);
        if (order.status !== 'open') continue;
        const payout = money(order.shares * result.payout);
        const pnl = money(payout - order.cost);
        const won = result.payout === 1;
        const voided = result.payout > 0 && result.payout < 1;
        const mismatch=Boolean(order.prediction && (voided || order.prediction.won !== won));
        this.store.transaction(() => {
          this.store.saveOrder({ ...order, status: voided ? 'void' : won ? 'won' : 'lost', payout, pnl, settledAt: this.now() });
          let account = this.store.account(order.mode);
          if (voided) {
            account = { ...account, pnl: money(account.pnl + pnl) };
          } else {
            const previous=account;
            account = this.accountAfterSettlement(account, pnl, won, order);
            if(!won && account.losses===0 && previous.losses>=0 && !order.prediction&&!this.isPreviousStakeCycle(order,previous))
              this.log(order.mode,'info',`下一笔超过${this.stakeCycleLimitLabel()}，恢复首笔 ${account.config.baseAmount.toFixed(2)} 开始新轮`);
          }
          if (order.prediction) this.store.verifyPrediction(order.id,!mismatch,this.now());
          if (order.mode === 'paper') account.balance = money(account.balance + payout);
          this.store.saveAccount(account);
        });
        this.log(order.mode, won ? 'success' : 'warning', `官方结算：${order.direction} ${voided ? '非二元兑付' : won ? '获胜' : '失利'}；净盈亏 ${pnl.toFixed(2)} pUSD${mismatch?'；预计结果不一致，已按官方结果入账并继续运行':''}${voided?'；保留当前连败序列，继续运行':''}`);
      } catch (e) { blocked.add(order.mode);this.runtimeIssue(order.mode,`结算/成交核对暂不可用，下次自动重试：${safeError(e)}`,'error'); }
    }
  }
  attachOrderId(id, venueOrderId) {
    const order = this.store.order(id);
    if (!order || order.mode !== 'live' || !['uncertain', 'confirming'].includes(order.status)) throw new Error('此订单无需核对');
    if (typeof venueOrderId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(venueOrderId)) throw new Error('请输入 Polymarket 的完整订单 ID');
    if (order.venueOrderId && order.venueOrderId !== venueOrderId) throw new Error('不能替换已知订单 ID');
    this.store.saveOrder({ ...order, venueOrderId, status: 'confirming', note: '用户提供订单 ID，等待官方成交记录核对' });
    this.log('live', 'info', '已提交订单 ID，系统将继续核对成交；保留当前策略启停状态'); this.broadcast();
  }
}
