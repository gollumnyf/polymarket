import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { createApp } from '../server/index.mjs';
import { get } from 'node:http';
import { startWithAmount } from '../src/api.mjs';
import { RoundHistory } from '../server/history.mjs';

test('local API validates host, origin, anti-CSRF token, modes and config before mutations', async t => {
  const store = new Store(':memory:');
  const engine = new Engine(store, { readiness: () => ({ enabled: false }), balance: async () => { throw new Error('disabled'); } });
  const server = createApp(engine).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.accounts.paper.balance, 1000);
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: base, 'X-Control-Token': state.controlToken, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('/api/paper/start', {}, { 'X-Control-Token': '' })).status, 403);
  assert.equal((await post('/api/paper/start', {}, { Origin: 'https://evil.example' })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    get(`${base}/api/state`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await post('/api/other/start', {})).status, 400);
  assert.equal((await post('/api/paper/config', { baseAmount: -5 })).status, 400);
  assert.equal((await post('/api/paper/start', {})).status, 200);
  assert.equal(store.account('paper').running, true);
  assert.equal((await post('/api/paper/stop', {})).status, 200);
  assert.equal(store.account('paper').running, false);
  assert.equal((await post('/api/live/start', {})).status, 400);
});

test('direct-start flow commits entered 2 to the real API before enabling the engine', async t => {
  const store = new Store(':memory:');
  const engine = new Engine(store, { readiness: () => ({ enabled: false }) });
  const server = createApp(engine).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await (await fetch(`${base}/api/state`)).json();
  const localFetch = (path, options = {}) => fetch(base + path, {
    ...options, headers: { ...options.headers, Origin: base },
  });
  const updated = await startWithAmount('paper', 2, initial.accounts.paper.config, initial.controlToken, localFetch);
  assert.equal(store.account('paper').config.baseAmount, 2);
  assert.equal(store.account('paper').running, true);
  assert.equal(updated.accounts.paper.nextAmount, 2);
});

test('same-direction settings save as booleans independently per mode and reject string values',async t=>{
  const store=new Store(':memory:');
  const engine=new Engine(store,{readiness:()=>({enabled:false})});
  const server=createApp(engine).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const state=await(await fetch(`${base}/api/state`)).json();
  assert.equal(state.accounts.paper.config.sameDirectionOnly,false);
  const post=value=>fetch(`${base}/api/paper/config`,{method:'POST',headers:{Origin:base,
    'Content-Type':'application/json','X-Control-Token':state.controlToken},
    body:JSON.stringify({...state.accounts.paper.config,sameDirectionOnly:value})});
  assert.equal((await post(true)).status,200);
  const saved=await(await fetch(`${base}/api/state`)).json();
  assert.equal(saved.accounts.paper.config.sameDirectionOnly,true);
  assert.equal(saved.accounts.live.config.sameDirectionOnly,false);
  assert.equal((await post('true')).status,400);
  assert.equal(store.account('paper').config.sameDirectionOnly,true);
});

test('follow-at-open configuration persists separately and the history API uses followed forecasts as the entry signal',async t=>{
  const store=new Store(':memory:');
  const historical=1799999700;
  store.saveRoundPrediction({round:historical-300,conditionId:'prev',open:100,close:99,outcome:'DOWN',
    source:'polymarket_last_second',oracleWindow:60,priceAt:historical*1000-1000,observedAt:historical*1000});
  const venue={readiness:()=>({enabled:false}),fetch:async()=>({ok:true,json:async()=>[]})};
  const history=new RoundHistory(venue,{store,now:()=>1800000010000});
  history.cache.set(historical,{round:historical,end:historical+300,slug:`btc-updown-5m-${historical}`,open:100,close:102,status:'resolved',result:'UP'});
  const server=createApp(new Engine(store,venue),{history}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const base=`http://127.0.0.1:${server.address().port}`,state=await(await fetch(`${base}/api/state`)).json();
  const post=(value,entryDelay=5)=>fetch(`${base}/api/paper/config`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Control-Token':state.controlToken},body:JSON.stringify({...state.accounts.paper.config,followPreviousAtOpen:value,sameDirectionOnly:true,entryDelay})});
  assert.equal((await post(true)).status,200);assert.equal((await post('true')).status,400);
  const data=await(await fetch(`${base}/api/history?mode=paper`)).json();
  assert.equal(data.followPreviousAtOpen,true);assert.equal(data.entryDelay,5);
  assert.equal(data.items.at(-1).initialSignal.targetSeconds,5);
  assert.equal(data.items.at(-1).initialSignal.direction,'DOWN');assert.equal(data.items.at(-1).reversal,true);
  assert.equal((await post(true,20)).status,200);
  const delayed=await(await fetch(`${base}/api/history?mode=paper`)).json();
  assert.equal(delayed.entryDelay,20);assert.equal(delayed.items.at(-1).initialSignal.targetSeconds,20);
  assert.equal(delayed.items.at(-1).initialSignal.direction,'DOWN');assert.equal(delayed.items.at(-1).reversal,true);
  assert.equal(store.account('live').config.followPreviousAtOpen,false);
});

test('reverse configuration and historical entry direction are mode-specific, use the configured delay and preserve raw signals',async t=>{
  const store=new Store(':memory:'),round=1799999700;
  store.saveInitialSignal({round,targetSeconds:10,observedAt:(round+10)*1000,direction:'UP',price:101,referencePrice:100,source:'polymarket',rule:'current_round_open',oracleWindow:60});
  const venue={readiness:()=>({enabled:false}),fetch:async()=>({ok:true,json:async()=>[]})};
  const history=new RoundHistory(venue,{store,now:()=>1800000010000});
  history.cache.set(round,{round,end:round+300,slug:`btc-updown-5m-${round}`,open:100,close:102,status:'resolved',result:'UP'});
  const server=createApp(new Engine(store,venue),{history}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const base=`http://127.0.0.1:${server.address().port}`,state=await(await fetch(`${base}/api/state`)).json();
  const post=reverseSignal=>fetch(`${base}/api/paper/config`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Control-Token':state.controlToken},body:JSON.stringify({...state.accounts.paper.config,entryDelay:10,reverseSignal})});
  assert.equal((await post(true)).status,200);assert.equal((await post('true')).status,400);
  const paper=await(await fetch(`${base}/api/history?mode=paper`)).json(),item=paper.items.at(-1);
  assert.equal(paper.reverseSignal,true);assert.equal(paper.entryDelay,10);assert.equal(item.initialSignal.direction,'DOWN');
  assert.equal(item.initialSignal.marketDirection,'UP');assert.equal(item.initialSignal.rule,'current_round_reverse');assert.equal(item.reversal,true);
  assert.equal(store.initialSignal(round,10).direction,'UP');assert.equal(store.account('live').config.reverseSignal,false);
  assert.equal((await post(false)).status,200);
  const normal=await(await fetch(`${base}/api/history?mode=paper`)).json();
  assert.equal(normal.reverseSignal,false);assert.equal(normal.items.at(-1).initialSignal.direction,'UP');assert.equal(normal.items.at(-1).reversal,false);
  assert.equal(store.orderCount('paper'),0);assert.equal(store.account('paper').running,false);
});

test('rejection evidence is available by exact mode and round with saved book levels and enriches untraded history',async t=>{
  const store=new Store(':memory:'),round=1799999700;
  const block=store.saveEntryDiagnostic({mode:'paper',round,code:'MAX_PRICE_BELOW_BEST_ASK',message:'卖一 0.60 > 上限 0.55；预算 20 pUSD 无法成交',at:(round+10)*1000,direction:'UP',budget:20,bestAsk:.6,maxPrice:.55},
    {asks:[{price:.6,size:10}],bids:[{price:.59,size:20}]});store.saveEntryBlock('paper',block);
  const venue={readiness:()=>({enabled:false}),fetch:async()=>({ok:true,json:async()=>[]})};
  const history=new RoundHistory(venue,{store,now:()=>1800000010000});
  history.cache.set(round,{round,end:round+300,slug:`btc-updown-5m-${round}`,open:100,close:102,status:'resolved',result:'UP'});
  const server=createApp(new Engine(store,venue),{history}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(`${base}/api/paper/entry-block/${round}`),body=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(body.block.bestAsk,.6);
  assert.deepEqual(body.block.book.asks,[{price:.6,size:10}]);assert.equal(body.block.evidenceAvailable,true);
  assert.equal((await(await fetch(`${base}/api/live/entry-block/${round}`)).json()).block,null);
  assert.equal((await fetch(`${base}/api/paper/entry-block/invalid`)).status,400);
  assert.equal((await fetch(`${base}/api/paper/entry-block/${round+1}`)).status,400);
  const data=await(await fetch(`${base}/api/history?mode=paper`)).json();assert.equal(data.items.at(-1).entryBlock.code,'MAX_PRICE_BELOW_BEST_ASK');assert.equal(data.items.at(-1).trade,null);
  assert.equal(store.orderCount('paper'),0);assert.equal(store.account('paper').running,false);
});

test('history read endpoint is separate from account orders and never enables a strategy', async t => {
  const store = new Store(':memory:');
  const engine = new Engine(store, { readiness: () => ({ enabled: false }) });
  const items = Array.from({ length: 20 }, (_, i) => ({ round: 1800000000 - (20 - i) * 300, result: i % 2 ? 'UP' : 'DOWN' }));
  const server = createApp(engine, { history: { readCached: () => ({ items, error: null }) } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); store.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/history`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).items.length, 20);
  assert.equal(store.account('paper').running, false); assert.equal(store.orders('paper').length, 0);
});

test('history follows each mode entry delay and changes classification immediately after saving a new delay', async t => {
  const store=new Store(':memory:');
  const historical=1799999700;
  store.tick((historical+5)*1000,99); store.tick((historical+10)*1000,101);
  store.saveAccount({...store.account('paper'),config:{...store.account('paper').config,entryDelay:10}});
  const venue={readiness:()=>({enabled:false}),fetch:async()=>({ok:true,json:async()=>[]})};
  const history=new RoundHistory(venue,{store,now:()=>1800000010000});
  history.cache.set(historical,{round:historical,end:historical+300,slug:`btc-updown-5m-${historical}`,
    open:100,close:102,change:2,changePercent:2,status:'resolved',result:'UP'});
  const engine=new Engine(store,venue);
  const server=createApp(engine,{history}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const [paper,live]=await Promise.all(['paper','live'].map(async mode=>(await fetch(`${base}/api/history?mode=${mode}`)).json()));
  assert.equal(paper.entryDelay,10); assert.equal(paper.items.at(-1).initialSignal.targetSeconds,10);
  assert.equal(paper.items.at(-1).reversal,false);
  assert.equal(live.entryDelay,5); assert.equal(live.items.at(-1).reversal,true);
  const state=await(await fetch(`${base}/api/state`)).json();
  const updated=await fetch(`${base}/api/paper/config`,{method:'POST',headers:{Origin:base,
    'Content-Type':'application/json','X-Control-Token':state.controlToken},
    body:JSON.stringify({...store.account('paper').config,entryDelay:20})});
  assert.equal(updated.status,200);
  const next=await(await fetch(`${base}/api/history?mode=paper`)).json();
  assert.equal(next.entryDelay,20); assert.equal(next.items.at(-1).initialSignal,null);
  assert.equal(next.items.at(-1).reversal,null);
});

test('paginated orders and CSV expose persisted timestamps without including historical rows in state', async t => {
  const store = new Store(':memory:');
  const createdAt = 1800000005000, settledAt = 1800000312000;
  store.reserveOrder({id:'timestamps',mode:'paper',round:1800000000,session:store.account('paper').session,
    direction:'UP',status:'open',createdAt});
  store.saveOrder({...store.order('timestamps'),status:'won',settledAt,pnl:3});
  const engine = new Engine(store,{readiness:() => ({enabled:false})});
  const server = createApp(engine).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => { server.closeAllConnections(); server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.accounts.paper.orders,undefined);
  assert.equal(state.accounts.paper.logs,undefined);
  assert.equal(state.accounts.paper.activeOrders.length,0);
  const page = await (await fetch(`${base}/api/paper/orders`)).json();
  assert.equal(page.items[0].createdAt,createdAt);
  assert.equal(page.items[0].settledAt,settledAt);
  const csv = await (await fetch(`${base}/api/paper/export`)).text();
  assert.ok(csv.split('\n')[0].includes('createdAt,settledAt'));
  assert.ok(csv.includes(`"${createdAt}","${settledAt}"`));
});

test('orders and logs are paginated in SQLite, isolate modes, validate limits and keep older pages stable on insert', async t => {
  const store = new Store(':memory:');
  store.transaction(() => {
    for (const mode of ['paper','live']) for (let i=0;i<55;i++) {
      store.reserveOrder({id:`${mode}-${i}`,mode,round:1800000000+i*300,session:store.account(mode).session,
        direction:'UP',status:i===0?'open':i===1?'uncertain':i%2?'won':'lost',createdAt:1800000005000+i*300000});
      store.log(mode,'info',`${mode} ${i}`);
    }
    store.log('system','info','shared system log');
  });
  const engine = new Engine(store,{readiness:() => ({enabled:false})});
  const server = createApp(engine).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => { server.closeAllConnections(); server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async path => {
    const response = await fetch(base+path);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    return response.json();
  };
  const first = await get('/api/paper/orders');
  assert.equal(first.items.length,20); assert.equal(first.total,55); assert.equal(first.pages,3);
  assert.equal(first.items[0].id,'paper-54'); assert.ok(first.items.every(o=>o.mode==='paper'));
  const secondPath = `/api/paper/orders?page=2&anchor=${first.anchor}`;
  const second = await get(secondPath);
  assert.equal(second.items[0].id,'paper-34');
  store.reserveOrder({id:'new-paper',mode:'paper',round:1800090000,session:store.account('paper').session,status:'open',direction:'DOWN'});
  assert.deepEqual((await get(secondPath)).items.map(o=>o.id),second.items.map(o=>o.id));
  assert.equal((await get('/api/paper/orders')).items[0].id,'new-paper');
  const last = await get(`/api/paper/orders?page=99999&anchor=${first.anchor}`);
  assert.equal(last.page,3); assert.equal(last.items.length,15);
  assert.equal(new Set([...first.items,...second.items,...last.items].map(o=>o.id)).size,55);
  const pending = await get('/api/paper/orders?status=open');
  assert.equal(pending.total,3); assert.ok(pending.items.every(o=>['open','uncertain'].includes(o.status)));
  const winners = await get('/api/paper/orders?status=won&pageSize=10');
  assert.equal(winners.items.length,10); assert.ok(winners.items.every(o=>o.status==='won'));
  assert.equal((await get('/api/live/orders')).total,55);
  const logs = await get('/api/paper/logs?pageSize=10');
  assert.equal(logs.items.length,10); assert.equal(logs.total,56);
  assert.equal(logs.items[0].mode,'system'); assert.ok(logs.items.every(l=>l.mode!=='live'));
  const logSecondPath = `/api/paper/logs?page=2&pageSize=10&anchor=${logs.anchor}`;
  const logSecond = await get(logSecondPath);
  store.log('paper','info','new log');
  assert.deepEqual((await get(logSecondPath)).items.map(l=>l.id),logSecond.items.map(l=>l.id));
  assert.equal((await get('/api/paper/orders?anchor=0')).total,0);
  const state = await get('/api/state');
  assert.equal(state.accounts.paper.orderCount,56); assert.equal(state.accounts.paper.activeOrders.length,3);
  assert.ok(!('orders' in state.accounts.paper)); assert.ok(!('logs' in state.accounts.paper));
  for (const suffix of ['page=0','page=-1','page=1.5','page=1&page=2','pageSize=0','pageSize=51',
    'anchor=-1','anchor=9007199254740992','status=unknown',"status=won%27%20OR%201=1--"]) {
    assert.equal((await fetch(`${base}/api/paper/orders?${suffix}`)).status,400,suffix);
  }
  assert.equal((await fetch(`${base}/api/other/logs`)).status,400);
});

test('paper clear endpoints isolate datasets, protect pending orders and financial state, and retain round deduplication',async t=>{
  const store=new Store(':memory:');
  const round=1800000000;
  const engine=new Engine(store,{readiness:()=>({enabled:false})},{now:()=>round*1000+10000});
  const book={fetchedAt:round*1000,tickSize:.01,minOrderSize:5,asks:[{price:.5,size:20}],bids:[{price:.49,size:30}]};
  for(const [id,mode,status,start] of [['completed','paper','lost',round],['pending','paper','open',round-300],['real','live','won',round]]){
    store.reserveOrder({id,mode,status,round:start,end:start+300,session:store.account(mode).session,
      direction:'UP',cost:5,budget:5,shares:9.6,createdAt:start*1000,tradeIds:[`trade-${id}`]},book);
    store.savePrediction({orderId:id,open:100,close:99,outcome:'DOWN',won:false,source:'polymarket_event_metadata',observedAt:(start+300)*1000});
  }
  store.saveAccount({...store.account('paper'),running:true,pnl:-5,balance:990,losses:1});
  store.log('paper','info','paper history');store.log('live','info','real history');store.log('system','warning','shared history');
  const before=store.account('paper');
  const server=createApp(engine).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const state=await(await fetch(`${base}/api/state`)).json();
  const post=(path,headers={})=>fetch(base+path,{method:'POST',headers:{Origin:base,
    'Content-Type':'application/json','X-Control-Token':state.controlToken,...headers},body:'{}'});
  assert.equal((await post('/api/paper/orders/clear',{'X-Control-Token':''})).status,403);
  assert.equal(store.orderCount('paper'),2);
  const removed=await post('/api/paper/orders/clear');assert.equal(removed.status,200);assert.equal((await removed.json()).cleared,1);
  assert.equal(store.order('completed'),null);assert.equal(store.order('pending').status,'open');
  assert.equal(store.order('real').status,'won');assert.deepEqual(store.account('paper'),before);
  for(const table of ['order_trade_ids','order_events','order_books','order_book_levels','order_predictions'])
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE order_id='completed'`).get().n,0,table);
  assert.equal(store.logs('paper').length,2);
  const exportBefore=await(await fetch(`${base}/api/paper/logs/export`)).text();
  assert.ok(exportBefore.includes('paper history'));assert.ok(exportBefore.includes('shared history'));assert.ok(!exportBefore.includes('real history'));
  const cleared=await post('/api/paper/logs/clear');assert.equal(cleared.status,200);assert.equal((await cleared.json()).cleared,2);
  assert.equal(store.logs('paper').length,0);assert.equal(store.logs('live').length,2);
  const page=await(await fetch(`${base}/api/paper/logs?page=3`)).json();
  assert.equal(page.total,0);assert.equal(page.page,1);
  assert.equal((await(await fetch(`${base}/api/paper/orders`)).json()).total,1);
  assert.equal((await post('/api/live/orders/clear')).status,404);
  assert.equal((await post('/api/live/logs/clear')).status,404);
  await engine.attempt('paper');assert.equal(store.orderCount('paper'),1);assert.match(engine.status.paper,/本场已执行/);
  assert.equal(store.reserveOrder({id:'repeat',mode:'paper',round,session:before.session,status:'placing'}),false);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  store.log('system','info','new shared');store.log('paper','info','new paper');
  assert.equal(store.historyPage('paper','logs').total,2);assert.deepEqual(store.account('paper'),before);
});

test('history API returns saved results while the official backfill is still pending',async t=>{
  const store=new Store(':memory:');
  let release;
  const upstream=new Promise(resolve=>{release=resolve;});
  const venue={readiness:()=>({enabled:false}),fetch:async()=>upstream};
  const history=new RoundHistory(venue,{store,now:()=>1800000010000});
  const round=1799999700;
  store.saveHistoricalRound({round,end:round+300,slug:'btc-updown-5m-'+round,status:'resolved',result:'UP',open:100,close:101},1000);
  const server=createApp(new Engine(store,venue),{history}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{release({ok:true,json:async()=>[]});await history.inflight;server.closeAllConnections();server.close();store.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const get=()=>fetch(base+'/api/history',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
  const first=await get();
  assert.equal(first.items.at(-1).result,'UP');
  assert.equal(first.refreshing,true);
  release({ok:true,json:async()=>[]});
  await history.inflight;
  const next=await get();
  assert.equal(next.items.at(-1).result,'UP');
  assert.equal(next.refreshing,false);
});

test('price SSE emits batches even while the execution engine sends no snapshots',async t=>{
  const {EventEmitter}=await import('node:events');
  const {mergeChartPrices}=await import('../src/chart-prices.mjs');
  const store=new Store(':memory:'),priceFeed=new EventEmitter();
  const venue={priceFeed,readiness:()=>({enabled:false})};
  const engine=new Engine(store,venue);
  const server=createApp(engine).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const abort=new AbortController();
  t.after(()=>{abort.abort();server.closeAllConnections();server.close();store.close();});
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/events',{signal:abort.signal});
  const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
  const first=await reader.read();assert.ok(first.value.startsWith('data: '));
  assert.equal(priceFeed.listenerCount('price'),1);
  const points=[{time:1000,price:101},{time:2000,price:102}];
  priceFeed.emit('price',points.at(-1),points);
  const packet=await reader.read();assert.equal(packet.value,'event: chart-prices\ndata: '+JSON.stringify(points)+'\n\n');
  assert.deepEqual(mergeChartPrices([{time:0,price:100},{time:1000,price:100}],points),[{time:0,price:100},...points]);
  abort.abort();
});
