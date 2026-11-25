import {RangeAdaptiveEngine} from './range-adaptive-engine.mjs';
import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Polymarket, safeError } from './polymarket.mjs';
import { RoundHistory } from './history.mjs';
import {MomentumEngine} from './momentum.mjs';
import {RangeEngine} from './range-engine.mjs';
import {Engine} from './engine.mjs';
import {LiveRedemption} from './redemption.mjs';
import {ChartOpening} from './chart-opening.mjs';
import {ChartRange} from './chart-range.mjs';
import {PolymarketPriceFeed} from './price-feed.mjs';
import {RangeStore} from './range-store.mjs';
import {Store} from './store.mjs';
import {PreviousDirectionEngine} from './previous-direction-engine.mjs';
import {LossFollowEngine} from './loss-follow-engine.mjs';
import {BollingerStore,BollingerEngine} from './bollinger-engine.mjs';
import {LevelLimitedStore,LevelLimitedEngine,independentLevelRange} from './level-limited-engine.mjs';
import {tradingReport} from './reports.mjs';
import {serveUiStream} from './ui-stream.mjs';

export function createApp(engine, { history = new RoundHistory(engine.venue, { store: engine.store }),onShutdown=null,rangeEngine=null,previousEngine=null,previousLiveEngine=null,lossFollowEngine=null,bollingerEngine=null,levelLimitedEngine=null,adaptiveObserver=null,allowedModes=['paper','live'],legacyRangeLiveRetired=false,chart=null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if(rangeEngine)app.use('/range',createApp(rangeEngine,{onShutdown,adaptiveObserver,allowedModes:['paper'],chart}));
  if(previousEngine)app.use('/previous',createApp(previousEngine,{history:previousEngine.history,onShutdown,allowedModes:['paper'],chart}));
  if(previousLiveEngine)app.use('/previous-live',createApp(previousLiveEngine,{history:previousLiveEngine.history,onShutdown,allowedModes:['live'],chart}));
  if(lossFollowEngine)app.use('/loss-follow',createApp(lossFollowEngine,{history:lossFollowEngine.history,onShutdown,allowedModes:['paper'],chart}));
  if(bollingerEngine)app.use('/bollinger',createApp(bollingerEngine,{history:bollingerEngine.history,onShutdown,allowedModes:['paper'],chart}));
  if(levelLimitedEngine)app.use('/level-limited',createApp(levelLimitedEngine,{history:levelLimitedEngine.history,onShutdown,allowedModes:['paper'],chart:{...chart,range:levelLimitedEngine.levels}}));
  app.use('/gam',(req,res)=>res.status(410).json({error:'GAM 均值方差模块已移除'}));
  app.use('/lead',(req,res)=>res.status(410).json({error:'行情领先与配对模块已移除'}));
  const token = randomBytes(32).toString('hex');
  const service={name:'polymarket-btc-console',root:resolve(fileURLToPath(new URL('../',import.meta.url))),pid:process.pid,instanceId:randomBytes(12).toString('hex'),shutdownEnabled:typeof onShutdown==='function'};
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // Local only. Host and origin checks also prevent DNS rebinding and cross-site
    // requests from turning a public page into a local trading command surface.
    const host = req.hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return res.status(403).json({ error: '仅允许本机访问' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      const supplied = req.get('x-control-token') || '';
      const suppliedBytes = Buffer.from(supplied);
      const expectedBytes = Buffer.from(token);
      const validToken = suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
      let validOrigin = false;
      try { validOrigin = new URL(req.get('origin')).host === req.get('host'); } catch { /* no browser origin */ }
      if (!validToken || !validOrigin) return res.status(403).json({ error: '请求验证失败，请刷新页面重试' });
    }
    next();
  });
  app.use('/api', express.json({ limit: '16kb' }));
  if(adaptiveObserver){
    app.get('/api/adaptive/state',(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(adaptiveObserver.snapshot(req.query.page));});
    app.post('/api/adaptive/config',(req,res)=>{try{adaptiveObserver.configure(req.body);res.json({...engine.snapshot(),controlToken:token});}catch(e){res.status(400).json({error:e.message});}});
  }
  app.use('/api/copy',(_req,res)=>res.status(410).json({error:'跟单观察盘已移除'}));
  if(legacyRangeLiveRetired)app.use('/api/live',(_req,res)=>res.status(410).json({error:'区间突破实盘已移除，请使用上场方向实盘'}));
  for(const mode of ['paper','live'])if(!allowedModes.includes(mode))app.use('/api/'+mode,(req,res)=>res.status(400).json({error:mode==='live'?'此页面仅支持模拟交易':'此页面仅支持实盘交易'}));
  app.get('/api/health', (req, res) => {res.setHeader('Cache-Control','no-store');res.json({ ok: true, now: Date.now(),service });});
  app.post('/api/service/shutdown',(req,res)=>{
    if(!service.shutdownEnabled)return res.status(503).json({error:'当前服务未启用控制台停止功能'});
    res.once('finish',()=>{setImmediate(()=>{Promise.resolve().then(onShutdown).catch(error=>console.error(safeError(error)));});});
    res.json({ok:true,instanceId:service.instanceId,message:'正在停止服务'});
  });
  if(chart?.range?.configure){
    app.get('/api/chart-settings',(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json(chart.range.settings());});
    app.post('/api/chart-settings',(req,res,next)=>{
      try{const settings=chart.range.configure(req.body);chart.range.poll(false);res.json(settings);}
      catch(error){next(error);}
    });
  }
  app.get('/api/state', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ...engine.snapshot(), controlToken: token }); });
  if(engine instanceof BollingerEngine){
    app.post('/api/bollinger-settings',(req,res,next)=>{
      try{res.json(engine.configureBollinger(req.body));}catch(error){next(error);}
    });
    app.get('/api/bollinger-history',(req,res,next)=>{
      res.setHeader('Cache-Control','no-store');
      if(engine.canRunBackground()===false)return res.status(202).json({pending:true});
      try{
        engine.bollingerRepair.marketStore=chart?.store??engine.marketStore;
        res.json(engine.bollingerRepair.read(engine.store.bollingerSettings(),chart?.feed?.spec?.seconds??engine.spot?.windowSeconds??60));
      }
      catch(error){next(error);}
    });
  }
  for(const mode of allowedModes.length===1?allowedModes:[])app.get(`/api/${mode}/report`,(req,res,next)=>{
    try {res.setHeader('Cache-Control','no-store');res.json(tradingReport(engine.store,mode,{startDate:req.query.startDate,endDate:req.query.endDate}));}
    catch(error){next(error);}
  });
  app.get('/api/history', (req, res, next) => {
    try {
      const mode = req.query.mode || 'paper';
      if (!allowedModes.includes(mode)) return res.status(400).json({ error: '未知交易模式' });
      const config=engine.store.account(mode).config,followPreviousAtOpen=config.followPreviousAtOpen,reverseSignal=config.reverseSignal;
      const entryDelay = config.entryDelay;
      const data = history.readCached({entryDelay,followPreviousAtOpen,reverseSignal});
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...data, mode,entryDelay,followPreviousAtOpen,reverseSignal,items: data.items.map(item => {
        const order = engine.store.orderForRound(mode,item.round);
        if(engine instanceof PreviousDirectionEngine){
          const filled=order?.shares>0;
          const initialSignal=filled?{direction:order.direction,observedAt:order.createdAt,rule:order.signalRule}:null;
          return {...item,initialSignal,reversal:filled&&item.status==='resolved'?order.direction!==item.result:null,entryBlock:engine.store.entryBlock(mode,item.round),trade:order?{direction:order.direction,status:order.status,pnl:order.pnl,prediction:order.prediction}:null};
        }
        const momentum=engine instanceof MomentumEngine;
        const initialSignal=momentum&&order?{direction:order.direction,observedAt:order.momentumSignal?.latestAt??order.rangeSignal?.priceAt??order.createdAt,price:order.signalPrice,referencePrice:order.referencePrice,rule:order.signalRule}:momentum?null:item.initialSignal;
        return { ...item,initialSignal,reversal:momentum?(order&&item.status==='resolved'?order.direction!==item.result:null):item.reversal, entryBlock:engine.store.entryBlock(mode,item.round),trade: order ? { direction: order.direction, status: order.status, pnl: order.pnl, prediction:order.prediction } : null };
      }) });
    }
    catch (error) { next(error); }
  });
  app.get('/api/events', (req, res) => {
    serveUiStream(req,res,engine,{chart,prices:req.query.chart==='1'});
  });
  app.get('/api/chart-events',(req,res)=>{
    serveUiStream(req,res,engine,{chart,state:false});
  });
  app.get('/api/:mode/entry-block/:round',(req,res,next)=>{
    try{
      if(!/^\d+$/.test(req.params.round))throw new Error('无效场次');
      const round=Number(req.params.round);
      if(!Number.isSafeInteger(round)||round<=0||round%300!==0)throw new Error('无效场次');
      res.setHeader('Cache-Control','no-store');
      res.json({block:engine.store.entryBlock(req.params.mode,round,{withBook:true})});
    }catch(error){next(error);}
  });
  app.param('mode', (req, res, next, mode) => {
    if (!allowedModes.includes(mode)) return res.status(400).json({ error: '未知交易模式' });
    next();
  });
  for (const kind of ['orders','logs']) app.get(`/api/:mode/${kind}`, (req,res,next) => {
    try {
      const integer = (key, fallback, min, max) => {
        const raw = req.query[key];
        if (raw === undefined) return fallback;
        if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new Error(`无效分页参数：${key}`);
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`无效分页参数：${key}`);
        return value;
      };
      const page = integer('page',1,1,Number.MAX_SAFE_INTEGER);
      const pageSize = integer('pageSize',20,1,50);
      const anchor = integer('anchor',null,0,Number.MAX_SAFE_INTEGER);
      const status = req.query.status ?? 'all';
      if (typeof status !== 'string' || !['all','open','placing','confirming','uncertain','won','lost','void','rejected'].includes(status))
        throw new Error('无效交易状态');
      res.setHeader('Cache-Control','no-store');
      const started=performance.now(),data=engine.store.historyPage(req.params.mode,kind,{page,pageSize,status,anchor});
      res.setHeader('Server-Timing',`db;dur=${(performance.now()-started).toFixed(2)};desc="SQLite pagination"`);
      res.json(data);
    } catch (error) { next(error); }
  });
  for(const kind of ['orders','logs'])app.post('/api/:mode/'+kind+'/visibility',(req,res,next)=>{
    try{
      if(typeof req.body?.hidden!=='boolean')throw new Error('hidden 必须为布尔值');
      const changed=engine.store.setHistoryHidden(req.params.mode,kind,req.body.hidden);
      engine.broadcast();res.json({ok:true,changed});
    }catch(error){next(error);}
  });
  app.post('/api/:mode/start', async (req, res, next) => {
    try { await engine.start(req.params.mode); res.json({ ok: true }); } catch (e) { next(e); }
  });
  app.post('/api/:mode/stop', (req, res) => { engine.stop(req.params.mode); res.json({ ok: true }); });
  app.post('/api/:mode/config', (req, res, next) => {
    try { engine.configure(req.params.mode, req.body); res.json({ ok: true }); } catch (e) { next(e); }
  });
  app.post('/api/paper/reset', (req, res, next) => {
    try { engine.resetPaper(); res.json({ ok: true }); } catch (e) { next(e); }
  });
  for(const kind of ['orders','logs']) app.post(`/api/paper/${kind}/clear`,(req,res,next)=>{
    try {
      const cleared=kind==='orders'?engine.store.clearPaperOrders():engine.store.clearPaperLogs();
      engine.broadcast();res.json({ok:true,cleared});
    }catch(error){next(error);}
  });
  let walletConnectTask=null;
  app.post('/api/live/connect', async (req, res, next) => {
    const automatic=req.body?.automatic===true;
    if(automatic&&engine.venue.readiness().authenticated)return res.json({ok:true});
    if(automatic&&(engine.canRunBackground?.()===false||engine.closing))
      return res.status(202).json({deferred:true});
    if(!walletConnectTask){
      const allowChange=!engine.store.account('live').running&&!engine.store.pending('live').length&&!engine.redemption?.task;
      walletConnectTask=Promise.resolve().then(()=>engine.venue.refreshWallet({allowChange,ifConfigured:automatic}))
        .finally(()=>{walletConnectTask=null;engine.broadcast();});
    }
    try { await walletConnectTask; res.json({ok:true}); } catch(error) { next(error); }
  });
  app.post('/api/live/reconcile', (req, res, next) => {
    try { engine.attachOrderId(req.body?.id, req.body?.venueOrderId); res.json({ ok: true }); } catch (e) { next(e); }
  });
  app.get('/api/:mode/export', (req, res) => {
    const keys = ['id', 'isHide', 'strategyVersion', 'configId', 'entryReason', 'round', 'createdAt', 'settledAt', 'direction', 'budget', 'cost', 'price', 'shares', 'fee', 'feeEstimated', 'status', 'pnl', 'venueOrderId',
      'predictionOutcome','predictionWon','predictionOpen','predictionClose','predictionAt','predictionMatches','predictionSource','predictionPriceAt'];
    if(engine instanceof MomentumEngine)keys.push('openingSource','oracleWindow','previousAt','previousPrice','latestAt','latestPrice');
    if(engine instanceof RangeEngine)keys.push('streakFirstRound','streakLastRound','streakRoundsRequired','streakMarketDirection','streakBuyDirection','streakObservedAt','resumeRounds','executionMaxPrice','boundaryPauseRound','boundaryConfirmCount','boundaryConfirmLastRound','boundaryConfirmLastClose','boundaryConfirmLastSource','boundaryConfirmLower','boundaryConfirmUpper','boundaryPauseSide','boundaryPausedAt','boundaryResumeSide','boundaryResumedAt','boundaryResumePrice','boundaryResumeThreshold','edgePercent','rp01Enabled','rp01ReleaseId','phase','lower','upper','upCount','downCount','windowStart','windowEnd','formedAt','breakoutSince','levelTimeframeMinutes','levelLookbackHours','levelLagMinutes','levelWindowStart','levelWindowEnd','supportSource','resistanceSource','directionRule','decisionUpCount','decisionDownCount','tiePreviousRound','tiePreviousDirection','tiePreviousSource','actualLower','actualUpper','lockedDirectionRule','lockedPreviousRound','lockedPreviousDirection','lockedPreviousSource','directionSelectedAt','tradeFromRound','formedFrom');
    const cell = value => `"${String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
    const rows = engine.store.orders(req.params.mode, -1).map(order=>({...order,...order.momentumSignal,...order.rangeSignal,
      id:order.id,round:order.round,createdAt:order.createdAt,direction:order.direction,price:order.price,
      streakFirstRound:order.streakSignal?.firstRound,streakLastRound:order.streakSignal?.lastRound,streakRoundsRequired:order.streakSignal?.roundsRequired,streakMarketDirection:order.streakSignal?.marketDirection,streakBuyDirection:order.streakSignal?.direction,streakObservedAt:order.streakSignal?.observedAt,
      predictionOutcome:order.prediction?.outcome,predictionWon:order.prediction?.won,
      predictionOpen:order.prediction?.open,predictionClose:order.prediction?.close,
      predictionAt:order.prediction?.observedAt,predictionMatches:order.prediction?.matches,
      predictionSource:order.prediction?.source,predictionPriceAt:order.prediction?.priceAt}));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pulse-${req.params.mode}-orders.csv"`);
    res.send('\uFEFF' + [keys.join(','), ...rows.map(o => keys.map(k => cell(o[k])).join(','))].join('\r\n'));
  });
  app.get('/api/:mode/logs/export',(req,res)=>{
    const keys=['id','is_hide','time','mode','level','message'];
    const cell=value=>`"${String(value ?? '').replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;
    const rows=engine.store.logs(req.params.mode,-1);
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="pulse-${req.params.mode}-logs.csv"`);
    res.send('\uFEFF'+[keys.join(','),...rows.map(row=>keys.map(key=>cell(row[key])).join(','))].join('\r\n'));
  });
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(400).json({ error: safeError(error) });
  });
  return app;
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const store = new RangeStore(resolve(root, 'data/trading.sqlite'));
  const priceFeed=new PolymarketPriceFeed();
  const archive=store.pending().length?new Engine(store,new Polymarket({priceFeed,officialOpeningOnly:true,deferOpeningPrice:true}),{modes:[]}):null;
  const rangeStore=new RangeStore(resolve(root,'data/range.sqlite'));
  rangeStore.seedFrom([store]);
  const rangeVenue=new Polymarket({priceFeed,officialOpeningOnly:true,deferOpeningPrice:true});
  const rangeEngine=new RangeAdaptiveEngine(rangeStore,rangeVenue);
  // Retain market data for the chart and settle any archived positions without placing new orders.
  rangeEngine.modes=[];
  const previousStore=new Store(resolve(root,'data/previous-direction.sqlite'));
  const previousVenue=new Polymarket({priceFeed,officialOpeningOnly:true,deferOpeningPrice:true});
  const previousEngine=new PreviousDirectionEngine(previousStore,previousVenue,{marketStore:rangeStore});
  const previousLiveStore=new Store(resolve(root,'data/previous-direction-live.sqlite'));
  const previousLiveVenue=new Polymarket({priceFeed,officialOpeningOnly:true,deferOpeningPrice:true});
  const previousLiveEngine=new PreviousDirectionEngine(previousLiveStore,previousLiveVenue,{mode:'live',marketStore:rangeStore,previousMarketStore:previousStore});
  previousLiveEngine.redemption=new LiveRedemption(previousLiveEngine);
  const lossFollowStore=new Store(resolve(root,'data/loss-follow.sqlite'));
  const lossFollowVenue=new Polymarket({priceFeed,officialOpeningOnly:true,deferOpeningPrice:true});
  const lossFollowEngine=new LossFollowEngine(lossFollowStore,lossFollowVenue,{source:previousEngine,marketStore:rangeStore});
  const bollingerStore=new BollingerStore(resolve(root,'data/previous-bollinger.sqlite'),{sourceConfig:previousStore.account('paper').config});
  const bollingerVenue=new Polymarket({priceFeed,officialOpeningOnly:true,deferOpeningPrice:true});
  const bollingerEngine=new BollingerEngine(bollingerStore,bollingerVenue,{marketStore:rangeStore,previousMarketStore:previousStore});
  const levelLimitedStore=new LevelLimitedStore(resolve(root,'data/previous-level-limited.sqlite'),{
    sourceConfig:previousStore.account('paper').config,chartSettings:rangeStore.chartSettings(),levelLagMinutes:rangeStore.rangeConfig().levelLagMinutes});
  const limitedRange=independentLevelRange(levelLimitedStore,rangeStore,priceFeed);
  const levelLimitedEngine=new LevelLimitedEngine(levelLimitedStore,new Polymarket({priceFeed,officialOpeningOnly:true,deferOpeningPrice:true}),
    {marketStore:rangeStore,previousMarketStore:previousStore,levels:limitedRange});
  rangeEngine.extraLevelHistoryStart=()=>Math.floor(Date.now()/300000)*300-
    (levelLimitedStore.chartSettings().levelLookbackMinutes+levelLimitedStore.levelLagMinutes())*60;
  const tradingEngines=[previousLiveEngine,previousEngine,lossFollowEngine,bollingerEngine,levelLimitedEngine];
  let closing=false;
  const chartOpening=new ChartOpening({onSpec:(spec,round)=>{if(!closing)priceFeed.connect(spec,round);}});
  const chartRange=new ChartRange(rangeEngine,priceFeed);
  for(const engine of tradingEngines)engine.includeSnapshotTicks=false;
  const backgroundEngines=[rangeEngine,...(archive?[archive]:[])];
  const engines=[...tradingEngines,...backgroundEngines];
  const canRunBackground=()=>!tradingEngines.some(engine=>engine.hasExecutionPriority());
  for(const engine of engines){
    engine.canRunBackground=canRunBackground;
    if(engine.history)engine.history.canRefresh=canRunBackground;
  }
  const app = createApp(previousEngine,{onShutdown:close,previousEngine,previousLiveEngine,lossFollowEngine,bollingerEngine,levelLimitedEngine,allowedModes:[],legacyRangeLiveRetired:true,chart:{feed:priceFeed,opening:chartOpening,range:chartRange,store:rangeStore}});
  app.get(['/','/paper','/momentum','/momentum/'],(_req,res)=>res.redirect('/previous'));
  app.use('/copy',(_req,res)=>res.status(410).json({error:'跟单观察盘已移除'}));
  app.get(['/live','/live/'],(_req,res)=>res.redirect('/previous-live'));
  app.use('/live',(_req,res)=>res.status(410).json({error:'区间突破实盘已移除，请使用上场方向实盘'}));
  app.get(['/range','/range/'],(_req,res)=>res.redirect('/previous'));
  app.use('/range',(_req,res)=>res.status(410).json({error:'区间突破模拟已移除，请使用上场方向模拟'}));
  const production = process.argv.includes('--production');
  let vite;
  if (production) {
    app.use(express.static(resolve(root, 'dist')));
    app.use((req, res) => res.sendFile(resolve(root, 'dist/index.html')));
  } else {
    const { createServer } = await import('vite');
    vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }
  const port = Number(process.env.PORT || 3100);
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Pulse BTC 5M · http://127.0.0.1:${port}`);
    console.log('上场方向模拟盘 /previous · 买入价格可配置 · 策略默认暂停');
    console.log('上场方向实盘 /previous-live · 策略默认暂停');
  });
  server.on('error', error => { console.error(safeError(error)); process.exitCode = 1; });
  const tick=()=>{for(const current of canRunBackground()?engines:tradingEngines.filter(engine=>engine.hasExecutionPriority()))void current.tick().catch(error=>console.error(`本次策略检查异常，下次继续运行：${safeError(error)}`));};
  const timer = setInterval(tick, 1000);
  const chartTimer=setInterval(()=>{
    try{
      if(chartOpening.listenerCount('opening')){
        if(!chartOpening.current()){
          const round=Math.floor(Date.now()/300000)*300;
          for(const engine of [...tradingEngines,rangeEngine]){
            const spot=engine.spot;
            if(spot?.round===round&&spot.sourceId==='polymarket'&&spot.openingSource==='polymarket_official')
              chartOpening.publish(round,spot.currentOpen);
            if(chartOpening.current())break;
          }
          void chartOpening.poll();
        }
        if(priceFeed.spec)priceFeed.connect(priceFeed.spec,priceFeed.round);
      }
      chartRange.poll(canRunBackground());
      limitedRange.poll(canRunBackground());
    }catch(error){console.error(safeError(error));}
  },1000);
  const redemptionTimer=setInterval(()=>previousLiveEngine.redemption.tick(),2500);
  tick();
  async function close() {
    if (closing) return; closing = true;for(const current of engines)current.closing=true;
    clearInterval(timer);clearInterval(redemptionTimer);clearInterval(chartTimer);
    priceFeed.close();
    for(const current of engines)for(const mode of current.modes)current.stop(mode);
    server.close(); server.closeAllConnections();
    if (vite) await vite.close();
    // Outstanding venue requests have a 10s deadline. Preserve reservations until
    // the process exits so a restart never treats them as a new opportunity.
    const deadline = Date.now() + 25000;
    while ((engines.some(current=>current.history?.inflight||current.busy||current.entryBusy||current.spotTask||current.displayBalanceTask||current.marketPrefetchTask||current.voteTask||current.backfillTask||current.settlementTask||current.redemption?.task||current.bollingerRepair?.task||current.roundPredictionTasks.size)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    priceFeed.close();
    store.close();previousStore.close();previousLiveStore.close();lossFollowStore.close();bollingerStore.close();levelLimitedStore.close();rangeStore.close();process.exit(0);
  }
  process.on('SIGINT', close); process.on('SIGTERM', close);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(safeError(e)); process.exitCode = 1; });
}
