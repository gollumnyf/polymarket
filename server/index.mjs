import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.mjs';
import { Polymarket, safeError } from './polymarket.mjs';
import { Engine } from './engine.mjs';
import { RoundHistory } from './history.mjs';
import {MomentumEngine} from './momentum.mjs';
import {RangeEngine} from './range-engine.mjs';
import {RangeStore} from './range-store.mjs';
import {paperReport} from './reports.mjs';

export function createApp(engine, { history = new RoundHistory(engine.venue, { store: engine.store }),onShutdown=null,momentumReportStore=null,rangeEngine=null,allowedModes=['paper','live'] } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if(rangeEngine)app.use('/range',createApp(rangeEngine,{onShutdown,allowedModes:['paper']}));
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
  if(!allowedModes.includes('live'))app.use('/api/live',(req,res)=>res.status(400).json({error:'此页面仅支持模拟交易'}));
  app.get('/api/health', (req, res) => {res.setHeader('Cache-Control','no-store');res.json({ ok: true, now: Date.now(),service });});
  app.post('/api/service/shutdown',(req,res)=>{
    if(!service.shutdownEnabled)return res.status(503).json({error:'当前服务未启用控制台停止功能'});
    res.once('finish',()=>{setImmediate(()=>{Promise.resolve().then(onShutdown).catch(error=>console.error(safeError(error)));});});
    res.json({ok:true,instanceId:service.instanceId,message:'正在停止服务'});
  });
  app.get('/api/state', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ...engine.snapshot(), controlToken: token }); });
  app.get('/api/paper/report',(req,res,next)=>{
    try {res.setHeader('Cache-Control','no-store');res.json(paperReport(engine.store,{startDate:req.query.startDate,endDate:req.query.endDate}));}
    catch(error){next(error);}
  });
  if(allowedModes.includes('live'))app.get('/momentum/api/paper/report',(req,res,next)=>{
    try {res.setHeader('Cache-Control','no-store');res.json(paperReport(momentumReportStore,{startDate:req.query.startDate,endDate:req.query.endDate}));}
    catch(error){next(error);}
  });
  app.get('/api/history', async (req, res, next) => {
    try {
      const mode = req.query.mode || 'paper';
      if (!allowedModes.includes(mode)) return res.status(400).json({ error: '未知交易模式' });
      const config=engine.store.account(mode).config,followPreviousAtOpen=config.followPreviousAtOpen,reverseSignal=config.reverseSignal;
      const entryDelay = config.entryDelay;
      const data = await history.read({entryDelay,followPreviousAtOpen,reverseSignal});
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...data, mode,entryDelay,followPreviousAtOpen,reverseSignal,items: data.items.map(item => {
        const order = engine.store.orderForRound(mode,item.round);
        const momentum=engine instanceof MomentumEngine;
        const initialSignal=momentum&&order?{direction:order.direction,observedAt:order.momentumSignal?.latestAt??order.rangeSignal?.priceAt??order.createdAt,price:order.signalPrice,referencePrice:order.referencePrice,rule:order.signalRule}:momentum?null:item.initialSignal;
        return { ...item,initialSignal,reversal:momentum?(order&&item.status==='resolved'?order.direction!==item.result:null):item.reversal, entryBlock:engine.store.entryBlock(mode,item.round),trade: order ? { direction: order.direction, status: order.status, pnl: order.pnl, prediction:order.prediction } : null };
      }) });
    }
    catch (error) { next(error); }
  });
  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = state => res.write(`data: ${JSON.stringify(state)}\n\n`);
    send(engine.snapshot());
    engine.on('update', send);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => { clearInterval(heartbeat); engine.off('update', send); });
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
      res.json(engine.store.historyPage(req.params.mode,kind,{page,pageSize,status,anchor}));
    } catch (error) { next(error); }
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
  app.post('/api/live/connect', async (req, res, next) => {
    try { await engine.venue.balance(); engine.broadcast(); res.json({ ok: true }); } catch (e) { next(e); }
  });
  app.post('/api/live/reconcile', (req, res, next) => {
    try { engine.attachOrderId(req.body?.id, req.body?.venueOrderId); res.json({ ok: true }); } catch (e) { next(e); }
  });
  app.get('/api/:mode/export', (req, res) => {
    const keys = ['id', 'round', 'createdAt', 'settledAt', 'direction', 'budget', 'cost', 'price', 'shares', 'fee', 'feeEstimated', 'status', 'pnl', 'venueOrderId',
      'predictionOutcome','predictionWon','predictionOpen','predictionClose','predictionAt','predictionMatches','predictionSource','predictionPriceAt'];
    if(engine instanceof MomentumEngine)keys.push('openingSource','oracleWindow','previousAt','previousPrice','latestAt','latestPrice');
    if(engine instanceof RangeEngine)keys.push('phase','lower','upper','upCount','downCount','windowStart','windowEnd','formedAt','breakoutSince','levelTimeframeMinutes','levelLookbackHours','levelWindowStart','levelWindowEnd','supportSource','resistanceSource','directionRule','decisionUpCount','decisionDownCount','tiePreviousRound','tiePreviousDirection','tiePreviousSource','actualLower','actualUpper','lockedDirectionRule','lockedPreviousRound','lockedPreviousDirection','lockedPreviousSource','directionSelectedAt','tradeFromRound','formedFrom');
    const cell = value => `"${String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
    const rows = engine.store.orders(req.params.mode, -1).map(order=>({...order,...order.momentumSignal,...order.rangeSignal,
      id:order.id,round:order.round,createdAt:order.createdAt,direction:order.direction,price:order.price,
      predictionOutcome:order.prediction?.outcome,predictionWon:order.prediction?.won,
      predictionOpen:order.prediction?.open,predictionClose:order.prediction?.close,
      predictionAt:order.prediction?.observedAt,predictionMatches:order.prediction?.matches,
      predictionSource:order.prediction?.source,predictionPriceAt:order.prediction?.priceAt}));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pulse-${req.params.mode}-orders.csv"`);
    res.send('\uFEFF' + [keys.join(','), ...rows.map(o => keys.map(k => cell(o[k])).join(','))].join('\r\n'));
  });
  app.get('/api/:mode/logs/export',(req,res)=>{
    const keys=['id','time','mode','level','message'];
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
  const store = new Store(resolve(root, 'data/trading.sqlite'));
  const venue = new Polymarket();
  const engine = new Engine(store, venue);
  const rangeStore=new RangeStore(resolve(root,'data/range.sqlite'));
  rangeStore.seedFrom([store]);
  const rangeVenue=new Polymarket({officialOpeningOnly:true,deferOpeningPrice:true});
  const rangeEngine=new RangeEngine(rangeStore,rangeVenue);
  const engines=[engine,rangeEngine];
  // Historical reports remain available without starting the removed simulator.
  const momentumPath=resolve(root,'data/momentum.sqlite');
  const momentumReportStore=existsSync(momentumPath)?{db:new DatabaseSync(momentumPath,{readOnly:true})}:null;
  const app = createApp(engine,{onShutdown:close,rangeEngine,momentumReportStore});
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
    console.log('实盘 /live · 策略默认暂停');
    console.log('区间突破模拟盘 /range · 买价严格低于 0.50 · 策略默认暂停');
  });
  server.on('error', error => { console.error(safeError(error)); process.exitCode = 1; });
  const tick=()=>{for(const current of engines)void current.tick().catch(error=>console.error(`本次策略检查异常，下次继续运行：${safeError(error)}`));};
  const timer = setInterval(tick, 1000);
  tick();
  let closing = false;
  async function close() {
    if (closing) return; closing = true;for(const current of engines)current.closing=true;
    clearInterval(timer);
    venue.close();rangeVenue.close();
    for(const current of engines)for(const mode of current.modes)current.stop(mode);
    server.close(); server.closeAllConnections();
    if (vite) await vite.close();
    // Outstanding venue requests have a 10s deadline. Preserve reservations until
    // the process exits so a restart never treats them as a new opportunity.
    const deadline = Date.now() + 25000;
    while (engines.some(current=>current.busy||current.entryBusy||current.spotTask||current.voteTask||current.backfillTask||current.settlementTask||current.roundPredictionTasks.size) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    store.close();rangeStore.close();momentumReportStore?.db.close();process.exit(0);
  }
  process.on('SIGINT', close); process.on('SIGTERM', close);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(safeError(e)); process.exitCode = 1; });
}
