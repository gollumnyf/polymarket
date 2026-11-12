import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {stableRange as evaluateRange,analyzeLevels,levelWindow,LEVEL_CANDLE_MS,rangeRegime,rangeBoundary,RANGE_DEFAULTS,validateRangeConfig} from '../server/range-strategy.mjs';
import {RangeStore} from '../server/range-store.mjs';
import {RangeEngine} from '../server/range-engine.mjs';
import {RangeLiveEngine} from '../server/range-live-engine.mjs';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {createApp} from '../server/index.mjs';
import {apiPath} from '../src/api.mjs';

const round=1800000000,end=round*1000,config={...RANGE_DEFAULTS,lookbackHours:1,levelLagMinutes:0};
function waveBars(until=end){return Array.from({length:720},(_,i)=>{
  const price=100+0.2*Math.sin(i*Math.PI/60),bucket=until-3600000+i*5000;
  return {bucket,open:price,close:price,low:price,high:price,firstAt:bucket,lastAt:bucket+4000,maxGapMs:1000,samples:5};
});}
function levelBars(until=end){const {start}=levelWindow(until,4,0);return Array.from({length:2880},(_,i)=>{
  const bucket=start+i*5000,candle=Math.floor(i/180),price=100;
  return {bucket,open:price,close:price,low:i%180===90?(candle%4===2?99.8:99.9):price,
    high:i%180===90?(candle%4===1?100.2:100.1):price,firstAt:bucket,lastAt:bucket+4000,maxGapMs:1000,samples:5};
});}
const stableRange=(bars,settings,now)=>evaluateRange(bars,settings,now,levelBars(now));
const combinedBars=()=>[...levelBars().slice(0,-720),...waveBars()];

test('every five-minute close recomputes forty-eight rolling five-minute candles over four hours',()=>{
  const first=analyzeLevels(levelBars(),config,end),nextTime=end+300000,next=analyzeLevels(levelBars(nextTime),config,nextTime);
  assert.equal(first.ready,true);assert.equal(first.candles.length,48);assert.equal(first.lower,100);assert.equal(first.upper,100);
  assert.equal(next.start,first.start+300000);assert.equal(next.end,first.end+300000);assert.equal(next.end-next.start,4*3600000);
  assert.equal(next.candles[0].bucket,next.start);assert.equal(next.candles[1].bucket,next.start+300000);
  assert.deepEqual(analyzeLevels(levelBars(),config,end+299999),first);
});

test('lagged level window excludes the latest three candles while keeping a full four-hour sample',()=>{
  const shifted={...config,levelLagMinutes:15},window=levelWindow(end,4,15);
  assert.deepEqual(levelWindow(end),window);assert.equal(window.end,end-900000);assert.equal(window.start,end-15300000);
  const official=Array.from({length:51},(_,i)=>({round:window.start/1000+i*300,open:i<48?100:1,close:i<48?101:999}));
  const levels=analyzeLevels([],shifted,end,official);
  assert.equal(levels.ready,true);assert.equal(levels.candles.length,48);assert.equal(levels.lower,100);assert.equal(levels.upper,101);
  assert.equal(levels.candles.at(-1).bucket,end-1200000);assert.equal(levels.nextUpdateAt,end+300000);
  assert.deepEqual(analyzeLevels([],shifted,end+299999,official),levels);
  const next=analyzeLevels([],shifted,end+300000,official);assert.equal(next.upper,999);assert.equal(next.lower,1);
  assert.equal(next.start,window.start+300000);assert.equal(next.end,window.end+300000);
  const raw=[...levelBars(end-900000),...levelBars().filter(bar=>bar.bucket>=end-900000).map(bar=>({...bar,open:999,close:999,high:999,low:999}))];
  assert.equal(analyzeLevels(raw,shifted,end).upper,100);
  assert.equal(analyzeLevels(raw,{...shifted,levelLagMinutes:0},end).upper,999);
});

test('lag configuration validates candle alignment and zero restores the original time window',()=>{
  assert.equal(validateRangeConfig().levelLagMinutes,15);
  for(const value of [-5,1,7,15.5,1445,'15',NaN])assert.throws(()=>validateRangeConfig({levelLagMinutes:value}),/滞后/);
  for(const value of [0,5,15,60,1440])assert.equal(validateRangeConfig({levelLagMinutes:value}).levelLagMinutes,value);
  assert.deepEqual(levelWindow(end,4,0),{start:end-14400000,end});
});

test('lagged analysis backfills older missing rounds while votes still use recent markets',async t=>{
  const c=setup(t,{bars:false});c.store.saveRangeConfig({...config,levelLagMinutes:15});
  const window=levelWindow(c.now(),4,15),requests=[];
  for(let value=window.start/1000+300;value<round;value+=300)c.store.marketRound(value,100,101,60,end);
  c.venue.fetch=async url=>{const params=new URL(url).searchParams,market=Date.parse(params.get('eventStartTime'))/1000;requests.push(market);return {ok:true,json:async()=>({openPrice:99,closePrice:100})};};
  await c.engine.backfillMarketHistory();const analysis=c.engine.analysis();
  assert.deepEqual(requests,[window.start/1000]);assert.equal(analysis.candidate.levelAnalysis.ready,true);
  assert.equal(analysis.candidate.levelAnalysis.start,window.start);assert.equal(analysis.candidate.levelAnalysis.end,window.end);
  assert.equal(analysis.vote.previousRound,round-300);assert.equal(analysis.vote.expected,12);
});

test('legacy config migration enables 15 minute lag without rewriting archived order evidence; saved zero survives restart',t=>{
  const folder=mkdtempSync(join(tmpdir(),'level-lag-')),path=join(folder,'range.sqlite');let store=new RangeStore(path);
  t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  store.saveRangeConfig(config);const oldConfig=store.rangeConfig().id;
  const state=store.saveRangeState(decide(null,confirmationCandidate(),150,end,majority,oldConfig));
  store.reserveOrder({id:'pre-lag-order',mode:'paper',session:store.account('paper').session,round,status:'won',direction:'UP',signalRule:'range_regime',rangeSignal:{...state,priceAt:end,price:150}});
  store.db.exec('ALTER TABLE range_configs DROP COLUMN level_lag_minutes; ALTER TABLE range_regimes DROP COLUMN level_lag_minutes');
  store.close();store=new RangeStore(path);
  assert.equal(store.rangeConfig().levelLagMinutes,15);assert.notEqual(store.rangeConfig().id,oldConfig);assert.equal(store.rangeState(),null);
  assert.equal(store.db.prepare('SELECT level_lag_minutes FROM range_configs WHERE id=?').get(oldConfig).level_lag_minutes,0);
  assert.equal(store.order('pre-lag-order').rangeSignal.levelLagMinutes,0);
  const {id,...current}=store.rangeConfig();store.saveRangeConfig({...current,levelLagMinutes:0});store.close();store=new RangeStore(path);
  assert.equal(store.rangeConfig().levelLagMinutes,0);assert.equal(store.orderCount('paper'),1);
});

test('a single extreme defines each boundary without touches, oscillation or width gates',()=>{
  const history=levelBars();history[0].open=150;history[0].close=150;history[0].high=150;history.at(-1).open=50;history.at(-1).close=50;history.at(-1).low=50;
  const candidate=evaluateRange([],config,end,history,100);
  assert.equal(candidate.lower,50);assert.equal(candidate.upper,150);assert.equal(candidate.stable,true);assert.deepEqual(candidate.blockingReasons,[]);
  const flat=history.map(bar=>({...bar,open:100,high:100,low:100,close:100}));
  assert.equal(evaluateRange([],config,end,flat,100).stable,true);
  for(const price of [50,150])assert.equal(evaluateRange([],config,end,history,price).stable,true);
  assert.equal(evaluateRange([],config,end,history,49).breakoutDirection,'DOWN');
  assert.equal(evaluateRange([],config,end,history,151).breakoutDirection,'UP');
});

test('incomplete history remains unavailable and does not invent historical bounds',()=>{
  const bars=levelBars();bars.splice(100,130);
  const candidate=evaluateRange([],config,end,bars,100);
  assert.equal(candidate.stable,false);assert.equal(candidate.code,'RANGE_LEVEL_HISTORY_INCOMPLETE');
  assert.equal(rangeRegime(null,candidate,{complete:true,direction:'UP'},{price:200,windowSeconds:60},1,end),null);
  const short=levelBars();short.splice(100,11);assert.equal(analyzeLevels(short,config,end).ready,true);
});

test('range and breakout parameters validate independently of obsolete thresholds',()=>{
  assert.deepEqual(validateRangeConfig({lookbackHours:3}),{...RANGE_DEFAULTS,lookbackHours:3});
  for(const input of [{lookbackHours:0},{lookbackHours:25},{lookbackHours:1.5},{minRoundTrips:2},{minLevelTouches:2},{maxWidthPercent:1}])assert.throws(()=>validateRangeConfig(input));
});

test('fresh live price reclassifies a cached range immediately and detects continuing breakouts',t=>{
  const {engine,store}=setup(t,{up:5});assert.equal(engine.signal().direction,'DOWN');
  engine.spot.price=100.3;assert.equal(engine.signal().code,'RANGE_BOUNDARY_WAIT');assert.equal(engine.analysis().candidate.stable,false);
  const started=store.rangeState().breakoutSince;
  engine.spot.price=100.4;assert.equal(engine.signal().state.breakoutSince,started);
  engine.spot.price=100;const back=engine.signal();assert.equal(back.state.phase,'range');assert.equal(back.direction,'DOWN');
});

test('new round bounds and current position replace old bounds without waiting for a new observation window',()=>{
  const vote={complete:true,direction:'DOWN',up:5,down:7,expected:12},spot={price:100.3,windowSeconds:60};
  const first=evaluateRange([],config,end,levelBars(),spot.price);let state=rangeRegime(null,first,vote,spot,1,end);
  assert.equal(state.phase,'range');assert.equal(state.breakoutPendingDirection,'UP');assert.equal(state.breakoutCount,0);
  const history=levelBars(end+300000);history[0].open=100.5;history[0].close=100.5;history[0].high=100.5;
  const next=evaluateRange([],config,end+300000,history,100.3);
  state=rangeRegime(state,next,vote,spot,1,end+300000);
  assert.equal(state.upper,100.5);assert.equal(state.levelWindowEnd,end+300000);assert.equal(state.phase,'range');assert.equal(state.direction,'DOWN');
  const retained=rangeRegime(state,next,{...vote,direction:'UP',up:8,down:4},{price:100.25,windowSeconds:60},1,end+301000);
  assert.equal(retained.direction,'DOWN');
});

test('rolling bounds and locked vote evidence survive restart',t=>{
  const folder=mkdtempSync(join(tmpdir(),'rolling-range-')),path=join(folder,'range.sqlite');let store=new RangeStore(path);
  t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  const candidate=evaluateRange([],config,end,levelBars(),100),vote={complete:true,up:6,down:6,expected:12,previousRound:round-300,previousDirection:'UP',previousSource:'official'};
  const state=store.saveRangeState(rangeRegime(null,candidate,vote,{price:100,windowSeconds:60},store.rangeConfig().id,end));
  store.reserveOrder({id:'rolling-evidence',mode:'paper',session:store.account('paper').session,round,end:round+300,status:'won',direction:'DOWN',signalRule:'range_regime',rangeSignal:{...state,priceAt:end,price:100,directionRule:'tie_reverse_previous',tiePreviousRound:round-300,tiePreviousDirection:'UP',tiePreviousSource:'official'}});
  store.close();store=new RangeStore(path);assert.equal(store.rangeState().direction,'DOWN');assert.equal(store.rangeState().upper,100);
  assert.equal(store.order('rolling-evidence').rangeSignal.supportSource,'rolling_extremes');assert.equal(store.order('rolling-evidence').rangeSignal.tiePreviousRound,round-300);
});

test('unconfirmed and confirmed downside both wait at the boundary without placing orders',async t=>{
  const {engine,store,setNow,fresh}=setup(t,{votes:false});engine.spot.price=99.7;
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),0);
  for(let i=1;i<=2;i++){
    store.saveRoundPrediction({round:round+(i-1)*300,conditionId:'c',open:100,close:99.7,outcome:'DOWN',source:'polymarket_last_second',oracleWindow:60,observedAt:end+i*300000,priceAt:end+i*300000-1000});
    setNow(end+i*300000);fresh();engine.spot.price=99.7;
    assert.equal(engine.signal().code,'RANGE_BOUNDARY_WAIT');await engine.attempt('paper');
  }
  assert.equal(engine.signal().state.phase,'breakout_down');assert.equal(engine.signal().state.breakoutCount,2);
  assert.equal(store.orderCount('paper'),0);assert.equal(store.account('paper').running,true);
});

test('price moving below support during a quote cancels entry before reservation',async t=>{
  const {engine,store}=setup(t),quote=engine.quote.bind(engine);
  engine.quote=(...args)=>{const fill=quote(...args);engine.spot.price=99.7;return fill;};
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(store.orderForRound('paper',round),null);
  assert.equal(engine.entryBlocks.paper.code,'RANGE_BOUNDARY_WAIT');
  assert.equal(store.rangeState().breakoutConfirmedAt,null);
});
function secondaryBars(){return levelBars().map((bar,i)=>{
  const candle=Math.floor(i/180),high=({1:100.3,5:100.2,9:100.1})[candle]??100.01,low=({2:99.7,6:99.8,10:99.9})[candle]??99.99;
  return {...bar,high:i%180===90?high:100,low:i%180===90?low:100};
});}

function installBars(store,bars,window=60){store.transaction(()=>{
  const insert=store.db.prepare('INSERT INTO range_price_bars VALUES (?,?,?,?,?,?,?,?,?,?)');
  for(const b of bars)insert.run(window,b.bucket,b.open,b.high,b.low,b.close,b.firstAt,b.lastAt,b.maxGapMs,b.samples);
});}
function installVotes(store,up=7){for(let i=0;i<12;i++)store.saveVote({round:round-(i+1)*300,outcome:i<up?'UP':'DOWN',source:'official',open:100,close:i<up?101:99,updatedAt:end});}
function setup(t,{up=7,bars=true,votes=true,path=':memory:'}={}){
  let now=end+1000,engine;const store=new RangeStore(path);t.after(async()=>{if(engine){engine.closing=true;await engine.backfillTask;}store.close();});
  store.saveRangeConfig(config);if(bars)installBars(store,combinedBars());if(votes)installVotes(store,up);
  const feed=new EventEmitter();let liveBuys=0;
  const venue={priceFeed:feed,readiness:()=>({enabled:false}),resolution:async()=>null,buy:async()=>{liveBuys++;throw Error('must not send live orders');}};
  engine=new RangeEngine(store,venue,{now:()=>now});
  const fresh=()=>{
    if(bars&&now>=end+300000){const last=store.db.prepare('SELECT MAX(bucket) AS last FROM range_price_bars WHERE oracle_window=60').get().last;for(let bucket=last+5000;bucket<Math.floor(now/300000)*300000;bucket+=5000)installBars(store,[{bucket,open:100,high:100,low:100,close:100,firstAt:bucket,lastAt:bucket+4000,maxGapMs:1000,samples:5}]);}

    const start=Math.floor(now/300000)*300;
    engine.spot={sourceId:'polymarket',openingSource:'polymarket_official',source:'Polymarket TWAP 60s',windowSeconds:60,conditionId:'c',round:start,currentOpen:100,price:100,direction:null,at:now};
    engine.market={round:start,active:true,fetchedAt:now,slug:`btc-updown-5m-${start}`,conditionId:'c',outcomes:[{direction:'UP',index:0,assetId:'up'},{direction:'DOWN',index:1,assetId:'down'}],feeSchedule:{rate:0,exponent:1}};
    const book=()=>({fetchedAt:now,tickSize:0.01,minOrderSize:5,asks:[{price:0.49,size:1000}],bids:[{price:0.48,size:1000}]});
    engine.books={UP:book(),DOWN:book()};
  };fresh();
  return {store,engine,venue,feed,fresh,now:()=>now,setNow:value=>{now=value;},liveBuys:()=>liveBuys};
}

for(const [up,expected] of [[7,'UP'],[5,'DOWN']])test(`range entry buys its fixed ${expected} direction once at open even when current-round price is flat`,async t=>{
  const {engine,store,liveBuys}=setup(t,{up});await engine.start('paper');await engine.attempt('paper');await engine.attempt('paper');
  const order=store.orderForRound('paper',round);assert.equal(order.direction,expected);assert.equal(order.price,0.49);assert.equal(order.createdAt,end+1000);
  assert.equal(order.signalRule,'range_regime');assert.ok(order.rangeSignal.lower<100);assert.equal(order.rangeSignal.supportSource,'rolling_extremes');assert.equal(order.rangeSignal.levelTimeframeMinutes,5);assert.equal(order.rangeSignal.levelLookbackHours,4);assert.equal(store.orderCount('paper'),1);assert.equal(liveBuys(),0);
});

for(const previous of ['UP','DOWN'])test(`a stable tied window immediately buys opposite the previous ${previous} result once`,async t=>{
  const {engine,store}=setup(t,{up:6});
  if(previous==='DOWN')for(const [r,outcome] of [[round-300,'DOWN'],[round-7*300,'UP']])store.saveVote({round:r,outcome,source:'official',updatedAt:end+1});
  await engine.start('paper');await engine.attempt('paper');await engine.attempt('paper');
  const order=store.orderForRound('paper',round);assert.equal(order.direction,previous==='UP'?'DOWN':'UP');assert.equal(store.orderCount('paper'),1);
  assert.equal(order.rangeSignal.directionRule,'tie_reverse_previous');assert.equal(order.rangeSignal.tiePreviousRound,round-300);
  assert.equal(order.rangeSignal.tiePreviousDirection,previous);assert.equal(order.rangeSignal.tiePreviousSource,'official');
  assert.equal(order.rangeSignal.decisionUpCount,6);assert.equal(order.rangeSignal.decisionDownCount,6);
});

test('a just-arrived previous prediction removes the tie wait without waiting for the candle cache',async t=>{
  const {engine,store}=setup(t,{up:6});store.db.prepare('DELETE FROM range_votes WHERE round=?').run(round-300);
  await engine.start('paper');await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  store.saveRoundPrediction({round:round-300,conditionId:'prev',open:100,close:101,outcome:'UP',source:'polymarket_last_second',oracleWindow:60,observedAt:end,priceAt:end-1000});
  await engine.attempt('paper');const order=store.orderForRound('paper',round);
  assert.equal(order.direction,'DOWN');assert.equal(order.rangeSignal.tiePreviousSource,'polymarket_last_second');
});

test('a void previous round has no tie-reversal direction and never substitutes an older round',async t=>{
  const {engine,store}=setup(t,{up:6});
  for(const r of [round-300,round-7*300])store.saveVote({round:r,source:'official_void',updatedAt:end+1});
  await engine.start('paper');await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  assert.equal(store.entryBlock('paper',round).code,'RANGE_TIE_PREVIOUS_UNAVAILABLE');assert.equal(engine.analysis().vote.up,5);assert.equal(engine.analysis().vote.down,5);
  assert.equal(store.account('paper').running,true);
});

test('official previous result takes priority over its earlier prediction',t=>{
  const {engine,store}=setup(t,{up:6});
  store.saveRoundPrediction({round:round-300,conditionId:'prev',open:101,close:100,outcome:'DOWN',source:'polymarket_last_second',oracleWindow:60,observedAt:end,priceAt:end-1000});
  assert.equal(engine.signal().direction,'DOWN');assert.equal(engine.analysis().vote.previousSource,'official');
});

test('incomplete historical voting or wrong-window prices never invent a stable majority',async t=>{
  const {engine,store}=setup(t);store.db.prepare('DELETE FROM range_votes WHERE round=?').run(round-300);
  await engine.start('paper');await engine.attempt('paper');assert.equal(store.entryBlock('paper',round).code,'RANGE_VOTE_INCOMPLETE');assert.equal(store.orderCount('paper'),0);
  engine.spot.windowSeconds=30;engine.analysisCache=null;await engine.attempt('paper');assert.equal(store.entryBlock('paper',round).code,'RANGE_LEVEL_HISTORY_INCOMPLETE');
});

for(const [price,tick,allowed] of [[0.49,0.01,true],[0.499,0.001,true],[0.4999999,0.0000001,true],[0.5,0.01,false],[0.51,0.01,false],[0.495,0.01,false]])
test(`range asks obey strictly below 0.50 and actual tick: ${price} at ${tick}`,async t=>{
  const {engine,store}=setup(t);engine.books.UP.asks[0].price=price;engine.books.UP.tickSize=tick;
  await engine.start('paper');await engine.attempt('paper');assert.equal(store.orderCount('paper'),allowed?1:0);
  if(allowed){const order=store.orders('paper')[0];assert.ok(order.price<0.5);assert.ok(order.priceLimit<0.5);}
});

test('depth at exactly 0.50 cannot complete a cheaper but insufficient first level',async t=>{
  const {engine,store}=setup(t);engine.books.UP.asks=[{price:0.49,size:1},{price:0.5,size:1000}];
  await engine.start('paper');await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);assert.match(store.entryBlock('paper',round).code,/DEPTH/);
});

test('forecast loss doubles the independent range stake without waiting for official settlement',async t=>{
  const {engine,store}=setup(t),account=store.account('paper');
  store.reserveOrder({id:'prior',mode:'paper',session:account.session,round:round-300,end:round,status:'open',direction:'DOWN',conditionId:'old',cost:10,budget:10,shares:20});
  store.savePrediction({orderId:'prior',open:100,close:101,outcome:'UP',won:false,source:'polymarket_event_metadata',observedAt:end});
  await engine.start('paper');await engine.attempt('paper');assert.equal(store.orderForRound('paper',round).budget,20);assert.equal(store.account('paper').settled,0);
});

test('opening reference may still be unpublished for a range entry; late entry and stale books still block',async t=>{
  const {engine,store,setNow,fresh}=setup(t);engine.spot.currentOpen=null;
  await engine.start('paper');engine.books.UP.fetchedAt=end-6000;await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  setNow(end+121000);fresh();await engine.attempt('paper');assert.equal(store.entryBlock('paper',round).code,'ENTRY_WINDOW_CLOSED');assert.equal(store.account('paper').running,true);
});

for(const [seconds,elapsed,allowed] of [[120,119999,true],[120,120000,true],[120,120001,false],[90,90000,true],[90,90001,false]])
test(`range detection cutoff ${seconds}s is inclusive at elapsed ${elapsed}ms`,async t=>{
  const {engine,store,setNow,fresh}=setup(t);
  assert.equal(store.account('paper').config.entryWindow,120);
  engine.configure('paper',{...store.account('paper').config,entryWindow:seconds});
  assert.equal(store.account('paper').config.entryWindow,seconds);engine.signal();
  setNow(end+elapsed);fresh();await engine.start('paper');await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),allowed?1:0);
  if(!allowed)assert.equal(store.entryBlock('paper',round).code,'ENTRY_WINDOW_CLOSED');
});

test('raw quote backfill is read-only for other accounts, deduplicates data and keeps oracle windows separate',t=>{
  const source=new Store(':memory:'),target=new RangeStore(':memory:');t.after(()=>{source.close();target.close();});
  source.saveAccount({...source.account('paper'),balance:777,running:true});
  source.tick(end-1000,101,'polymarket',60);source.tick(end-2000,100,'polymarket',60);source.tick(end-3000,1,'binance',null);source.tick(end-4000,999,'polymarket',30);
  target.seedFrom([source,source],end);const bars=target.rangeBars(60,end-5000,end);
  assert.equal(bars.length,1);assert.equal(bars[0].open,100);assert.equal(bars[0].close,101);assert.equal(bars[0].samples,2);
  assert.equal(source.account('paper').balance,777);assert.equal(source.account('paper').running,true);assert.equal(target.account('paper').balance,1000);assert.equal(target.orderCount('paper'),0);
});

test('new range APIs isolate configuration, account, token, pagination and CSV from other trading pages',async t=>{
  const {engine:range,store,venue}=setup(t),originalStore=new Store(':memory:');t.after(()=>originalStore.close());
  const app=createApp(new Engine(originalStore,venue),{rangeEngine:range}),server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.close();server.closeAllConnections();});
  const base=`http://127.0.0.1:${server.address().port}`,read=async path=>(await fetch(base+path)).json();
  const root=await read('/api/state'),state=await read('/range/api/state');assert.equal(state.strategy,'range_breakout');assert.notEqual(root.controlToken,state.controlToken);
  const post=(path,body={},token=state.controlToken)=>fetch(base+path,{method:'POST',headers:{Origin:base,'X-Control-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/range/api/paper/start',{},root.controlToken)).status,403);assert.equal((await post('/range/api/live/start')).status,400);
  const oldBase=store.account('paper').config.baseAmount;
  assert.equal((await post('/range/api/paper/config',{...store.account('paper').config,baseAmount:7,rangeConfig:{lookbackHours:0}})).status,400);assert.equal(store.account('paper').config.baseAmount,oldBase);
  assert.equal((await post('/range/api/paper/config',{...store.account('paper').config,baseAmount:7,rangeConfig:config})).status,200);
  assert.equal((await post('/range/api/paper/start')).status,200);await range.attempt('paper');assert.equal(originalStore.orderCount('paper'),0);
  const page=await read('/range/api/paper/orders?pageSize=1');assert.equal(page.items[0].budget,7);assert.ok(page.items[0].rangeSignal);
  const csv=await(await fetch(base+'/range/api/paper/export')).text(),lines=csv.replace(/^\uFEFF/,'').trim().split('\r\n');
  assert.ok(lines[1].includes(`"${page.items[0].id}"`));const columns=lines[0].split(','),values=lines[1].split(',');assert.equal(values[columns.indexOf('price')],'"0.49"');
  assert.equal(apiPath('paper/orders','/range'),'/range/api/paper/orders');
});

test('historical direction loading counts market UP/DOWN, prioritizes official outcomes and fills missing rounds asynchronously',async t=>{
  const {engine,store,venue}=setup(t,{votes:false});
  const events=Array.from({length:12},(_,i)=>{const start=round-(i+1)*300,slug=`btc-updown-5m-${start}`;return {slug,eventMetadata:{priceToBeat:100,finalPrice:i<7?101:99},markets:[{slug,conditionId:`c${i}`,outcomes:['Up','Down']}]};});
  venue.fetch=async()=>({ok:true,json:async()=>events});venue.public={fetchResolutions:async()=>events.map((event,i)=>({conditionId:`c${i}`,status:'resolved',payouts:i<7?['1','0']:['0','1']}))};
  engine.pollVoteHistory();await engine.voteTask;const vote=engine.analysis().vote;
  assert.equal(vote.up,7);assert.equal(vote.down,5);assert.equal(vote.complete,true);assert.equal(vote.official,12);
  await engine.start('paper');await engine.attempt('paper');assert.equal(store.orders('paper')[0].direction,'UP');
});

const confirmationCandidate=(overrides={})=>({lower:100,upper:200,start:end-14400000,end,widthPercent:66.6667,breakoutPercent:0.1,breakoutRounds:2,
  levelAnalysis:{ready:true,start:end-14400000,end,timeframeMinutes:5,lookbackHours:4},...overrides});
const majority={complete:true,up:8,down:4,expected:12,direction:'UP'};
const decide=(previous,candidate,price,at=end,vote=majority,id=1)=>rangeRegime(previous,candidate,vote,{price,windowSeconds:60},id,at);
const closes=(prices)=>prices.map((close,i)=>({round:round+i*300,close,source:'polymarket_last_second'}));

for(const side of ['UP','DOWN'])test(side+' confirmation requires strict distance and two distinct completed closes',()=>{
  const direction=side==='UP'?'UP':'DOWN',edge=side==='UP'?'DOWN':'UP',boundary=side==='UP'?200:100,line=side==='UP'?200.1:99.9,far=side==='UP'?201:99;
  let state=decide(null,confirmationCandidate(),boundary);
  state=decide(state,confirmationCandidate(),line);assert.equal(state.direction,edge);assert.equal(state.breakoutPendingDirection,undefined);
  state=decide(state,confirmationCandidate(),far);assert.equal(state.breakoutCount,0);assert.equal(state.direction,edge);
  for(let i=0;i<4;i++)state=decide(state,confirmationCandidate(),far,end+1000+i);assert.equal(state.breakoutCount,0);
  const one=confirmationCandidate({completedRounds:closes([far])});
  state=decide(state,one,far,end+300000);assert.equal(state.breakoutCount,1);assert.equal(state.direction,edge);
  state=decide(state,one,far,end+300001);assert.equal(state.breakoutCount,1);
  state=decide(state,confirmationCandidate({completedRounds:closes([far,far])}),far,end+600000);
  assert.equal(state.direction,direction);assert.equal(state.phase,side==='UP'?'breakout_up':'breakout_down');assert.equal(state.tradeFromRound,round+600);
  assert.equal(state.breakoutCount,2);
});

test('rolling updated bounds cannot move the frozen confirmation line; current price is checked again',()=>{
  const state=decide(null,confirmationCandidate(),201);
  const updated=confirmationCandidate({lower:99,upper:210,completedRounds:closes([201,202]),levelAnalysis:{...confirmationCandidate().levelAnalysis,end:end+600000}});
  const confirmed=decide(state,updated,202,end+600000);
  assert.equal(confirmed.upper,210);assert.equal(confirmed.breakoutReferenceUpper,200);assert.equal(confirmed.direction,'UP');assert.equal(confirmed.breakoutCount,2);
  const returned=decide(state,updated,150,end+600000);assert.equal(returned.phase,'range');assert.equal(returned.breakoutConfirmedAt,null);
  const after=decide(confirmed,updated,150,end+601000);assert.equal(after.phase,'range');assert.equal(after.breakoutPendingDirection,null);
});

test('failed or missing closes cannot count as consecutive confirmations and corrections are rechecked',()=>{
  const state=decide(null,confirmationCandidate(),201);
  const missing=decide(state,confirmationCandidate({completedRounds:[{round:round+300,close:202,source:'official'}]}),201,end+600000);
  assert.equal(missing.breakoutCount,1);assert.equal(missing.phase,'range');
  const one=decide(state,confirmationCandidate({completedRounds:closes([201])}),201,end+300000);
  const corrected=decide(one,confirmationCandidate({completedRounds:closes([199,201])}),201,end+600000);
  assert.equal(corrected.breakoutCount,1);assert.equal(corrected.breakoutStartRound,round);
  const equal=decide(state,confirmationCandidate({completedRounds:closes([200.1,201])}),201,end+600000);
  assert.equal(equal.phase,'range');assert.equal(equal.breakoutCount,1);
  const invalid=decide(state,confirmationCandidate({completedRounds:[{round,invalid:true}]}),201,end+300000);
  assert.equal(invalid.breakoutCount,0);assert.equal(invalid.breakoutStartRound,round+300);
});

for(const side of ['UP','DOWN'])test(`${side} confirmation only uses the latest consecutive closes, including delayed backfills`,()=>{
  const far=side==='UP'?201:99,inside=150,state=decide(null,confirmationCandidate(),far);
  for(const prices of [[far,inside,far],[far,far,inside,far],[far,far,null,far],[far,far,inside]]){
    const result=decide(state,confirmationCandidate({completedRounds:closes(prices)}),far,end+prices.length*300000);
    assert.equal(result.phase,'range');assert.ok(result.breakoutCount<2);assert.equal(result.breakoutConfirmedAt,null);
  }
  const prices=[far,inside,far,far];
  const result=decide(state,confirmationCandidate({completedRounds:closes(prices)}),far,end+prices.length*300000);
  assert.equal(result.phase,side==='UP'?'breakout_up':'breakout_down');assert.equal(result.breakoutCount,2);
  assert.equal(result.tradeFromRound,round+1200);assert.equal(result.breakoutLastRound,round+900);
});

function setupLive(t){
  const source=setup(t),store=new RangeStore(':memory:'),submissions=[];
  const venue={priceFeed:new EventEmitter(),readiness:()=>({enabled:true,configured:true,authenticated:true}),balance:async()=>10000,
    buy:async(order,quote,guard)=>{assert.equal(guard(),true);submissions.push({order,quote});return {ok:true,orderId:'live-'+order.id,tradeIds:[]};}};
  const engine=new RangeLiveEngine(store,venue,source.engine,{now:source.now});
  engine.spot={...source.engine.spot};engine.market=structuredClone(source.engine.market);engine.books=structuredClone(source.engine.books);
  t.after(()=>{engine.closing=true;store.close();});return {source,store,engine,venue,submissions};
}

test('both range pages produce a valid cold-start snapshot before official price data arrives',t=>{
  const {source,engine}=setupLive(t);
  source.engine.spot=null;source.engine.analysisCache=null;engine.spot=null;
  assert.equal(source.engine.snapshot().entrySignal.code,'RANGE_OFFICIAL_PRICE_MISSING');
  assert.equal(engine.snapshot().entrySignal.code,'RANGE_OFFICIAL_PRICE_MISSING');
});

test('live follows range signals while orders, logs, stakes and reservations remain independent',async t=>{
  const {source,engine,store,submissions}=setupLive(t);
  engine.configure('live',{...store.account('live').config,baseAmount:7});
  await source.engine.start('paper');await source.engine.attempt('paper');
  await engine.start('live');await Promise.all([engine.attempt('live'),engine.attempt('live')]);
  assert.equal(submissions.length,1);
  const real=store.orderForRound('live',round),paper=source.store.orderForRound('paper',round);
  assert.equal(real.direction,paper.direction);assert.equal(real.budget,7);assert.equal(paper.budget,10);
  assert.equal(real.status,'confirming');assert.equal(real.signalRule,'range_regime');assert.equal(real.rangeSignal.lower,paper.rangeSignal.lower);
  assert.ok(submissions[0].quote.priceLimit<0.5);assert.equal(store.orderCount('paper'),0);assert.equal(source.store.orderCount('live'),0);
  assert.ok(store.logs('live').some(row=>row.message.includes('订单已提交')));
  assert.ok(!source.store.logs('paper').some(row=>row.message.includes('订单已提交')));
  assert.equal(engine.snapshot().strategy,'range_breakout');assert.equal(engine.snapshot().strategySource,'range');
  assert.deepEqual(engine.snapshot().rangeConfig,source.engine.snapshot().rangeConfig);
  assert.equal(store.account('live').losses,0);assert.equal(source.store.account('paper').losses,0);
});

test('live takes market signals even with paper paused; wallet-time direction changes cancel entry',async t=>{
  const {source,engine,store,venue,submissions}=setupLive(t);
  assert.equal(source.store.account('paper').running,false);
  await engine.start('live');
  venue.balance=async()=>{source.engine.spot.price=100.19;return 10000;};
  await engine.attempt('live');assert.equal(submissions.length,0);assert.equal(store.orderCount('live'),0);
  assert.equal(engine.entryBlocks.live.code,'RANGE_BOUNDARY_WAIT');
  await engine.attempt('live');assert.equal(submissions.length,0);
  source.engine.spot.price=100;
  venue.balance=async()=>10000;await engine.attempt('live');
  assert.equal(submissions.length,1);assert.equal(submissions[0].order.direction,'DOWN');
  assert.equal(source.store.orderCount('paper'),0);
});

test('live martingale uses its own losing streak instead of the paper account sequence',async t=>{
  const {source,engine,store,submissions}=setupLive(t);
  store.saveAccount({...store.account('live'),losses:1,config:{...store.account('live').config,baseAmount:7}});
  source.store.saveAccount({...source.store.account('paper'),losses:3});
  await engine.start('live');await engine.attempt('live');
  assert.equal(submissions[0].order.budget,14);assert.equal(submissions[0].order.doubling,1);
  assert.equal(source.store.account('paper').losses,3);assert.equal(source.store.orderCount('paper'),0);
});

test('live gates wrong oracle markets, high prices, missing wallet configuration and late entries',async t=>{
  const {source,engine,store,venue,submissions}=setupLive(t);
  venue.readiness=()=>({enabled:false,configured:false});await assert.rejects(engine.start('live'),/未启用/);
  assert.equal(store.account('live').running,false);
  venue.readiness=()=>({enabled:true,configured:true});await engine.start('live');
  engine.spot.windowSeconds=0;await engine.attempt('live');assert.equal(engine.entryBlocks.live.code,'RANGE_FOLLOW_MARKET_MISMATCH');
  engine.spot.windowSeconds=60;engine.books.UP.asks[0].price=0.5;
  await engine.attempt('live');assert.equal(engine.entryBlocks.live.code,'RANGE_PRICE_NOT_BELOW_HALF');
  source.setNow(end+121000);await engine.attempt('live');assert.equal(engine.entryBlocks.live.code,'ENTRY_WINDOW_CLOSED');
  assert.equal(submissions.length,0);assert.equal(store.account('live').running,true);
});

test('shared range settings follow paper, live capital settings stay separate and active live blocks shared edits',async t=>{
  const {source,engine,store}=setupLive(t),paper=source.store.account('paper');
  source.engine.configure('paper',{...paper.config,entryWindow:90,rangeConfig:{...config,breakoutRounds:3}});
  assert.equal(engine.snapshot().accounts.live.config.entryWindow,90);assert.equal(engine.snapshot().rangeConfig.breakoutRounds,3);
  engine.configure('live',{...store.account('live').config,baseAmount:6});assert.equal(source.store.account('paper').config.baseAmount,10);
  assert.throws(()=>engine.configure('live',{...store.account('live').config,entryWindow:80}),/跟随/);
  assert.throws(()=>engine.configure('live',{...store.account('live').config,rangeConfig:config}),/跟随/);
  await engine.start('live');
  assert.throws(()=>source.engine.configure('paper',{...source.store.account('paper').config,entryWindow:100}),/实盘正在运行/);
  assert.equal(source.store.account('paper').config.entryWindow,90);
  await assert.rejects(engine.start('paper'),/不支持/);
});

test('live and paper API history and control tokens remain isolated under shared strategy',async t=>{
  const {source,engine,store}=setupLive(t);
  store.log('live','info','live-only');source.store.log('paper','info','paper-only');
  const server=createApp(engine,{rangeEngine:source.engine,allowedModes:['live']}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port,read=async path=>(await fetch(base+path)).json();
  const live=await read('/api/state'),paper=await read('/range/api/state');
  assert.equal(live.strategy,'range_breakout');assert.equal(paper.strategy,'range_breakout');assert.notEqual(live.controlToken,paper.controlToken);
  assert.ok((await read('/api/live/logs')).items.some(row=>row.message==='live-only'));
  assert.ok(!(await read('/range/api/paper/logs')).items.some(row=>row.message==='live-only'));
  const post=(path,token)=>fetch(base+path,{method:'POST',headers:{Origin:base,'X-Control-Token':token}});
  assert.equal((await post('/api/live/start',paper.controlToken)).status,403);
  assert.equal((await post('/range/api/live/start',paper.controlToken)).status,400);
  assert.equal((await post('/api/paper/start',live.controlToken)).status,400);
});

test('configured percent and round count are independent and reject malformed inputs',()=>{
  for(const input of [{breakoutPercent:-1},{breakoutPercent:101},{breakoutPercent:'0.1'},{breakoutPercent:NaN},{breakoutRounds:0},{breakoutRounds:1.5},{breakoutRounds:49}])assert.throws(()=>validateRangeConfig(input));
  const candidate=confirmationCandidate({breakoutPercent:1,breakoutRounds:3});
  assert.equal(decide(null,candidate,200.5).breakoutPendingDirection,undefined);
  const start=decide(null,candidate,202);
  const two=decide(start,{...candidate,completedRounds:closes([202,202])},202,end+600000);assert.equal(two.phase,'range');assert.equal(two.breakoutCount,2);
  const three=decide(two,{...candidate,completedRounds:closes([202,202,202])},202,end+900000);assert.equal(three.phase,'breakout_up');
});

test('base direction and confirmation progress survive SQLite reload with frozen references and no duplicate writes',t=>{
  const folder=mkdtempSync(join(tmpdir(),'confirmation-')),path=join(folder,'range.sqlite');let store=new RangeStore(path);
  t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  store.saveRangeConfig({...RANGE_DEFAULTS,breakoutPercent:0.2,breakoutRounds:3});const id=store.rangeConfig().id;
  let state=store.saveRangeState(decide(null,confirmationCandidate(),150,end,majority,id));assert.equal(state.rangeBaseDirection,'UP');
  state=store.saveRangeState(decide(state,confirmationCandidate(),195,end+1000,majority,id));assert.equal(state.direction,'DOWN');
  store.close();store=new RangeStore(path);state=store.rangeState();assert.equal(state.rangeBaseDirection,'UP');
  state=store.saveRangeState(decide(state,confirmationCandidate(),150,end+2000,majority,id));assert.equal(state.direction,'DOWN');assert.equal(state.rangeBaseDirectionRule,'boundary_return');
  state=store.saveRangeState(decide(state,confirmationCandidate(),201,end+3000,majority,id));
  const candidate=confirmationCandidate({completedRounds:closes([201])});
  state=store.saveRangeState(decide(state,candidate,201,end+300000,majority,id));assert.equal(state.breakoutCount,1);
  store.close();store=new RangeStore(path);state=store.rangeState();assert.equal(state.breakoutCount,1);assert.equal(state.breakoutReferenceUpper,200);assert.equal(store.rangeConfig().breakoutRounds,3);
  const same=store.saveRangeState(decide(state,candidate,201,end+300000,majority,id));assert.equal(same.id,state.id);
  const confirmed=store.saveRangeState(decide(same,confirmationCandidate({completedRounds:closes([201,201])}),201,end+600000,majority,id));assert.equal(confirmed.phase,'breakout_up');
});

test('legacy edge state recovers the vote-based direction without treating its overridden trade as the base',t=>{
 const folder=mkdtempSync(join(tmpdir(),'legacy-base-')),path=join(folder,'range.sqlite');let store=new RangeStore(path);
 t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
 const state=store.saveRangeState(decide(null,confirmationCandidate(),195,end,majority,store.rangeConfig().id));
 assert.equal(state.direction,'DOWN');
 store.db.exec('ALTER TABLE range_regimes DROP COLUMN range_base_direction; ALTER TABLE range_regimes DROP COLUMN range_base_direction_rule;');
 store.close();store=new RangeStore(path);assert.equal(store.rangeState().rangeBaseDirection,'UP');assert.equal(store.rangeState().rangeBaseDirectionRule,'range_majority');
});

const officialBodies=()=>Array.from({length:48},(_,i)=>({round:round-14400+i*300,open:100,close:i===47?101:100}));
const seedBodies=(store,except=[],window=60)=>{for(const item of officialBodies())if(!except.includes(item.round))store.marketRound(item.round,item.open,item.close,window,end);};
const responseRound=url=>Date.parse(new URL(url).searchParams.get('eventStartTime'))/1000;

test('official body endpoints eliminate raw-gap restrictions and take precedence over incomplete samples',()=>{
 const official=officialBodies();const levels=analyzeLevels([],config,end,official);
 assert.equal(levels.ready,true);assert.equal(levels.officialCandles,48);assert.equal(levels.maxGapMs,14400000);assert.equal(levels.upper,101);
 const partial=levelBars().slice(0,20);partial[0]={...partial[0],open:300,high:300};
 assert.equal(analyzeLevels(partial,config,end,official).upper,101);
 assert.equal(analyzeLevels([],config,end,official.slice(1)).ready,false);
 const minimal=levelBars().filter((bar,i)=>i%60===0||i%60===59);assert.equal(analyzeLevels(minimal,config,end).ready,true);
});

test('official endpoint cache survives restart and raw history rebuilding without creating artificial ticks',t=>{
 const folder=mkdtempSync(join(tmpdir(),'endpoint-cache-')),path=join(folder,'range.sqlite');let store=new RangeStore(path);
 t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
 seedBodies(store);store.marketRound(round-300,90,95,0,end);
 store.close();store=new RangeStore(path);store.seedFrom([],end);
 assert.equal(store.marketPrices(60,round-14400,round).length,48);assert.equal(store.marketPrices(0,round-300,round)[0].close,95);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ticks').get().n,0);assert.equal(store.rangeBars(60,end-14400000,end).length,0);
 assert.equal(analyzeLevels([],config,end,store.marketPrices(60,round-14400,round)).ready,true);
});

test('missing rounds fetch immediately, deduplicate requests and become usable before the remaining queue completes',async t=>{
 const {engine,store,venue,setNow,fresh}=setup(t,{bars:false,votes:false});const missing=[round-300,round-600];seedBodies(store,missing);
 const calls=[],releases=new Map();venue.fetch=async url=>{const r=responseRound(url);calls.push(r);return new Promise(resolve=>releases.set(r,()=>resolve({ok:true,json:async()=>({openPrice:100,closePrice:102})})));};
 assert.equal(engine.analysis().candidate.levelAnalysis.validCandles,46);
 const task=engine.backfillTask;await Promise.resolve();await Promise.resolve();
 engine.analysis();engine.backfillMarketHistory();assert.deepEqual(calls.sort(),missing.sort());
 releases.get(round-300)();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(engine.analysis().candidate.levelAnalysis.validCandles,47);assert.equal(store.vote(round-300).outcome,'UP');assert.ok(engine.backfillTask);
 releases.get(round-600)();await task;
 assert.equal(engine.analysis().candidate.levelAnalysis.ready,true);assert.equal(engine.historyRepair.active,0);
 engine.backfillMarketHistory();assert.equal(calls.length,2);
 setNow(end+300000);fresh();engine.analysis();const next=engine.backfillTask;await Promise.resolve();await Promise.resolve();
 assert.equal(calls.length,3);assert.equal(calls[2],round);releases.get(round)();await next;
 assert.equal(engine.analysis().candidate.levelAnalysis.ready,true);
});

test('repair retries failures promptly, keeps running and does not fabricate missing endpoint prices',async t=>{
 const {engine,store,venue,setNow,fresh}=setup(t);engine.signal();seedBodies(store,[round-300]);
 store.saveAccount({...store.account('paper'),running:true});let calls=0;
 venue.fetch=async()=>{calls++;return calls===1?{ok:false,status:503}:{ok:true,json:async()=>({openPrice:100,closePrice:101})};};
 await engine.backfillMarketHistory();assert.equal(calls,1);assert.equal(store.marketPrices(60,round-300,round).length,0);assert.equal(store.account('paper').running,true);
 engine.backfillMarketHistory();assert.equal(calls,1);
 setNow(end+2001);fresh();await engine.backfillMarketHistory();assert.equal(calls,2);assert.equal(store.marketPrices(60,round-300,round)[0].close,101);assert.equal(store.account('paper').running,true);
});

test('missing history uses saved same-oracle bounds while new accounts wait for authentic prices',t=>{
 const {engine,store}=setup(t);const saved=engine.signal().state;
 store.db.exec('DELETE FROM range_price_bars');engine.analysisCache=null;
 const signal=engine.signal();assert.equal(signal.code,null);assert.equal(signal.usingSavedRange,true);assert.equal(signal.state.lower,saved.lower);assert.match(signal.message,/暂沿用已保存区间/);
 engine.spot.windowSeconds=0;engine.analysisCache=null;assert.equal(engine.signal().code,'RANGE_LEVEL_HISTORY_INCOMPLETE');
});

test('repair uses up to eight concurrent calls, supports oracle window zero and stops writes on shutdown',async t=>{
 const {engine,store,venue}=setup(t,{bars:false,votes:false});engine.spot.windowSeconds=0;
 let count=0;const releases=[];venue.fetch=async()=>{count++;return new Promise(resolve=>releases.push(()=>resolve({ok:true,json:async()=>({openPrice:100,closePrice:101})})));};
 const task=engine.backfillMarketHistory();await Promise.resolve();await Promise.resolve();assert.equal(count,8);
 engine.closing=true;for(const release of releases)release();await task;
 assert.equal(count,8);assert.equal(store.marketPrices(0,round-14400,round).length,0);assert.equal(engine.historyRepair.active,0);
});

test('market voting includes the immediately preceding unsettled round without reading any order data',t=>{
 const {engine,store}=setup(t,{up:6});store.db.prepare('DELETE FROM range_votes WHERE round=?').run(round-300);
 store.saveRoundPrediction({round:round-300,conditionId:'untraded',open:100,close:101,outcome:'DOWN',source:'polymarket_last_second',oracleWindow:60,observedAt:end,priceAt:end-1000});
 for(const name of ['order','orders','orderForRound','prediction','pending'])store[name]=()=>{throw Error('market voting must not read orders: '+name);};
 const vote=engine.voteSummary(config,60);
 assert.equal(vote.previousRound,round-300);assert.equal(vote.previousDirection,'UP');assert.equal(vote.previousEstimated,true);assert.equal(vote.up,6);assert.equal(vote.down,6);
});

test('unsettled actual market endpoint prices are counted without a saved vote or order',t=>{
 const {engine,store}=setup(t,{up:6});store.db.prepare('DELETE FROM range_votes WHERE round=?').run(round-300);
 store.saveHistoricalRound({round:round-300,end:round,slug:'btc-updown-5m-'+(round-300),status:'pending',open:100,close:101},end);
 const vote=engine.voteSummary(config,60);assert.equal(vote.covered,12);assert.equal(vote.previousDirection,'UP');assert.equal(vote.previousSource,'polymarket_event_metadata');assert.equal(vote.previousEstimated,true);
});

test('a published market resolution replaces the same round forecast immediately, including disagreement',t=>{
 const {engine,store}=setup(t,{up:6});store.db.prepare('DELETE FROM range_votes WHERE round=?').run(round-300);
 store.marketRound(round-300,100,101,60,end);assert.equal(engine.voteSummary(config,60).previousDirection,'UP');
 store.saveHistoricalRound({round:round-300,end:round,slug:'btc-updown-5m-'+(round-300),status:'resolved',result:'DOWN',open:100,close:101},end+1);
 const vote=engine.voteSummary(config,60);assert.equal(vote.previousDirection,'DOWN');assert.equal(vote.previousSource,'official');assert.equal(vote.previousEstimated,false);assert.equal(vote.down,7);
});

test('round opening and final-second market quote supply the untraded previous forecast',t=>{
 const {engine,store}=setup(t,{up:6});store.db.prepare('DELETE FROM range_votes WHERE round=?').run(round-300);
 store.saveRoundOpening({round:round-300,conditionId:'untraded',open:100,oracleWindow:60,source:'polymarket_official',observedAt:end-300000});
 store.tick(end-1000,101,'polymarket',60);
 const vote=engine.voteSummary(config,60);assert.equal(vote.previousDirection,'UP');assert.equal(vote.previousSource,'polymarket_last_second');assert.equal(vote.estimated,1);
});

test('signal distinguishes initial locked evidence from the latest untraded previous market round',t=>{
 const {engine,store,setNow,fresh}=setup(t,{up:6});engine.signal();
 setNow(end+300001);fresh();store.saveRoundPrediction({round,conditionId:'untraded',open:100,close:99,outcome:'DOWN',source:'polymarket_last_second',oracleWindow:60,observedAt:end+300000,priceAt:end+299000});
 const signal=engine.signal();assert.equal(signal.state.lockedPreviousRound,round-300);assert.equal(signal.vote.previousRound,round);assert.equal(signal.vote.previousDirection,'DOWN');
 assert.match(signal.message,new RegExp('当时上一场 #'+(round-300)));assert.match(signal.message,new RegExp('当前上一场 #'+round+'：DOWN'));assert.match(signal.message,/未结算，场次预计结果/);assert.equal(signal.direction,'DOWN');
});


test('boundary bands include both thresholds and outside; only the strict middle resumes',()=>{
  const state={lower:100,upper:200};
  for(const price of [90,100,120,180,200,210])assert.equal(rangeBoundary(state,price).paused,true);
  for(const price of [120.00001,150,179.99999])assert.equal(rangeBoundary(state,price).paused,false);
  const frozen={lower:0,upper:1000,breakoutReferenceLower:100,breakoutReferenceUpper:200};
  assert.equal(rangeBoundary(frozen,201).paused,true);assert.equal(rangeBoundary(frozen,150).paused,false);
  assert.equal(rangeBoundary({lower:100,upper:100},100).code,'RANGE_BOUNDARY_INVALID');
});

for(const side of ['lower','upper'])test(side+' boundary waits and resumes the existing stake once in the middle',async t=>{
  const c=setup(t);await c.engine.start('paper');
  c.store.saveAccount({...c.store.account('paper'),losses:2,pnl:-30,cyclePnl:-30});
  const before=c.store.account('paper'),bounds=c.engine.signal().boundary;
  c.engine.spot.price=side==='lower'?bounds.middleLower:bounds.middleUpper;
  await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),0);
  assert.equal(c.engine.entryBlocks.paper.code,'RANGE_BOUNDARY_WAIT');
  assert.equal(c.store.account('paper').running,true);assert.equal(c.store.account('paper').losses,2);
  c.engine.spot.price=(bounds.middleLower+bounds.middleUpper)/2;
  await c.engine.attempt('paper');await c.engine.attempt('paper');
  const order=c.store.orderForRound('paper',round);
  assert.equal(order.budget,40);assert.equal(order.direction,side==='lower'?'UP':'DOWN');assert.equal(order.rangeSignal.boundaryResumeSide,side);assert.equal(c.store.orderCount('paper'),1);
  assert.equal(c.store.account('paper').cycle,before.cycle);assert.equal(c.store.account('paper').pnl,-30);
});

test('returning to the middle after the entry deadline waits for another round',async t=>{
  const c=setup(t);await c.engine.start('paper');c.engine.spot.price=100.3;await c.engine.attempt('paper');
  c.setNow(end+121000);c.fresh();await c.engine.attempt('paper');
  assert.equal(c.store.orderCount('paper'),0);assert.equal(c.store.account('paper').running,true);
  c.setNow(end+301000);c.fresh();await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),1);
});

test('retired RP-01 cannot block or reset an account and its API cannot enable it',async t=>{
  const c=setup(t);await c.engine.start('paper');
  c.store.db.prepare("INSERT INTO range_protection_state VALUES ('RP-01',1,'UP',60,?,NULL,99,99,0,?)").run(round,end);
  c.store.db.prepare('UPDATE range_configs SET rp01_enabled=1').run();
  c.store.saveAccount({...c.store.account('paper'),losses:2,pnl:-30,cyclePnl:-30});
  c.engine.snapshot();assert.equal(c.engine.signal().direction,'UP');assert.equal(c.store.account('paper').losses,2);
  assert.equal(Object.hasOwn(c.store.rangeConfig(),'rp01Enabled'),false);
  assert.throws(()=>validateRangeConfig({rp01Enabled:true}));
  const server=createApp(c.engine,{allowedModes:['paper']}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port,state=await(await fetch(base+'/api/state')).json();
  assert.equal(Object.hasOwn(state,'rangeProtection'),false);
  const response=await fetch(base+'/api/paper/rp01',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Control-Token':state.controlToken},body:JSON.stringify({enabled:true})});
  assert.equal(response.status,404);
  await c.engine.attempt('paper');assert.equal(c.store.orderForRound('paper',round).budget,40);
});

test('historical stake reset still prevents an old settlement from advancing the current cycle',async t=>{
  const c=setup(t);await c.engine.start('paper');const account=c.store.account('paper');
  c.store.db.prepare('INSERT INTO range_protection_accounts VALUES (?,?,?,?,?)').run('paper',account.session,1,1,round);
  c.store.saveAccount({...account,losses:0,pnl:-30,cyclePnl:0});
  const old={id:'legacy-reset-order',mode:'paper',session:account.session,round:round-300,end:round,direction:'UP',status:'open',cost:40,budget:40,shares:80,createdAt:end-299000};
  c.store.reserveOrder(old);
  assert.equal(c.engine.projectAccount(c.store.account('paper'),c.store.pending('paper')).riskPnl,-70);
  c.engine.spot.price=100.3;c.venue.resolution=async()=>({payout:0});await c.engine.settlePending();
  assert.equal(c.store.account('paper').pnl,-70);assert.equal(c.store.account('paper').losses,0);
  assert.equal(c.store.account('paper').cycle,account.cycle);assert.equal(c.store.account('paper').running,true);
});

for(const side of ['lower','upper'])test('live '+side+' boundary follows source and resumes its independent stake',async t=>{
  const {source,engine,store,submissions}=setupLive(t);await engine.start('live');
  store.saveAccount({...store.account('live'),losses:2,pnl:-21,config:{...store.account('live').config,baseAmount:7}});
  const bounds=source.engine.signal().boundary;source.engine.spot.price=side==='lower'?bounds.middleLower:bounds.middleUpper;
  await engine.attempt('live');assert.equal(submissions.length,0);assert.equal(store.account('live').running,true);
  source.engine.spot.price=(bounds.middleLower+bounds.middleUpper)/2;
  await engine.attempt('live');assert.equal(submissions.length,1);assert.equal(submissions[0].order.budget,28);assert.equal(submissions[0].order.direction,side==='lower'?'UP':'DOWN');
  assert.equal(source.store.orderCount('paper'),0);assert.equal(store.account('live').pnl,-21);
});


test('configurable edge percentages validate and use inclusive boundaries with a strict middle',()=>{
  assert.equal(validateRangeConfig().edgePercent,20);
  for(const value of [-1,50,100,NaN,Infinity,'20',null])assert.throws(()=>validateRangeConfig({edgePercent:value}),/边界比例/);
  for(const edgePercent of [0,10,25,35.5,49.99]){
    assert.equal(validateRangeConfig({edgePercent}).edgePercent,edgePercent);
    const state={lower:100,upper:200,edgePercent},b=rangeBoundary(state,150);
    assert.equal(b.middleLower,100+edgePercent);assert.equal(b.middleUpper,200-edgePercent);
    assert.equal(b.paused,false);assert.equal(rangeBoundary(state,b.middleLower).paused,true);assert.equal(rangeBoundary(state,b.middleUpper).paused,true);
  }
  assert.match(rangeBoundary({lower:100,upper:200,edgePercent:10},105).message,/10%.*中间 80%/);
});

test('changing only the edge percentage preserves locked direction and updates paper and live signals',async t=>{
  const {source,engine}=setupLive(t),first=source.engine.signal(),lower=first.boundary.lower,upper=first.boundary.upper;
  source.engine.spot.price=lower+(upper-lower)*0.15;
  assert.equal(source.engine.signal().code,'RANGE_BOUNDARY_WAIT');assert.equal(engine.signal().code,'RANGE_BOUNDARY_WAIT');
  source.engine.configure('paper',{...source.store.account('paper').config,rangeConfig:{...config,edgePercent:10}});
  const next=source.engine.signal();assert.equal(next.code,null);assert.equal(next.direction,first.direction);
  assert.equal(next.state.rangeBaseDirection,first.state.rangeBaseDirection);assert.equal(next.state.formedAt,first.state.formedAt);
  assert.equal(engine.signal().boundary.edgePercent,10);assert.equal(engine.signal().direction,first.direction);
  await source.engine.start('paper');await source.engine.attempt('paper');
  const order=source.store.orderForRound('paper',round);assert.equal(order.rangeSignal.edgePercent,10);
});

test('edge percentage persists across restart and migration keeps historical default evidence',t=>{
  const folder=mkdtempSync(join(tmpdir(),'range-edge-')),path=join(folder,'range.sqlite');let store=new RangeStore(path);
  t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  const state=store.saveRangeState(decide(null,confirmationCandidate(),150,end,majority,store.rangeConfig().id));
  store.reserveOrder({id:'edge-history',mode:'paper',session:store.account('paper').session,round,end:round+300,status:'won',direction:'UP',signalRule:'range_regime',rangeSignal:{...state,priceAt:end,price:150}});
  // Emulate the database schema before configurable edges were introduced.
  store.db.exec('ALTER TABLE range_configs DROP COLUMN edge_percent; ALTER TABLE range_regimes DROP COLUMN edge_percent');
  store.close();store=new RangeStore(path);
  assert.equal(store.rangeConfig().edgePercent,20);assert.equal(store.order('edge-history').rangeSignal.edgePercent,20);
  const {id,...old}=store.rangeConfig();store.saveRangeConfig({...old,edgePercent:12.5});
  store.close();store=new RangeStore(path);
  assert.equal(store.rangeConfig().edgePercent,12.5);assert.equal(store.rangeState().edgePercent,12.5);
  assert.equal(store.order('edge-history').rangeSignal.edgePercent,20);
});


for(const side of ['lower','upper'])test(side+' boundary return overrides an opposite vote and stays locked without duplicate transitions',()=>{
  const candidate=confirmationCandidate(),vote={...majority,direction:side==='lower'?'DOWN':'UP',up:side==='lower'?4:8,down:side==='lower'?8:4};
  let state=decide(null,candidate,150,end,vote);
  state=decide(state,candidate,side==='lower'?110:190,end+1000,vote);
  assert.equal(state.boundaryPauseSide,side);assert.equal(state.boundaryPausedAt,end+1000);
  state=decide(state,candidate,side==='lower'?120:180,end+2000,vote);assert.equal(state.boundaryPauseSide,side);
  const resumed=decide(state,candidate,150,end+3000,vote);
  assert.equal(resumed.direction,side==='lower'?'UP':'DOWN');assert.equal(resumed.rangeBaseDirectionRule,'boundary_return');
  assert.equal(resumed.boundaryPauseSide,null);assert.equal(resumed.boundaryResumeSide,side);assert.equal(resumed.boundaryResumedAt,end+3000);
  assert.equal(resumed.boundaryResumePrice,150);assert.equal(resumed.boundaryResumeThreshold,side==='lower'?120:180);
  const repeated=decide(resumed,candidate,151,end+4000,{complete:false});
  assert.equal(repeated.direction,resumed.direction);assert.equal(repeated.boundaryResumedAt,resumed.boundaryResumedAt);
});

test('crossing directly from one paused boundary to the other uses the latest side on return',()=>{
  const candidate=confirmationCandidate();let state=decide(null,candidate,110);
  state=decide(state,candidate,190,end+1000);assert.equal(state.boundaryPauseSide,'upper');
  state=decide(state,candidate,150,end+2000);assert.equal(state.direction,'DOWN');
  state=decide(state,candidate,110,end+3000);state=decide(state,candidate,150,end+4000);
  assert.equal(state.direction,'UP');assert.equal(state.boundaryResumeSide,'lower');
});

for(const side of ['UP','DOWN'])test(side+' confirmed breakout records its boundary and returns with the opposite direction',()=>{
  const far=side==='UP'?201:99,candidate=confirmationCandidate();let state=decide(null,candidate,far);
  state=decide(state,{...candidate,completedRounds:closes([far,far])},far,end+600000);
  assert.equal(state.phase,side==='UP'?'breakout_up':'breakout_down');
  state=decide(state,candidate,150,end+601000,{complete:false});
  assert.equal(state.phase,'range');assert.equal(state.direction,side==='UP'?'DOWN':'UP');assert.equal(state.lockedDirectionRule,'boundary_return');
});

test('boundary return works without historical votes, but missing and stale prices cannot trigger it',async t=>{
  const c=setup(t,{votes:false});await c.engine.start('paper');c.engine.spot.price=99.7;await c.engine.attempt('paper');
  assert.equal(c.store.rangeState().boundaryPauseSide,'lower');assert.equal(c.store.orderCount('paper'),0);
  c.engine.spot.price=100;c.engine.spot.at=c.now()-6001;assert.equal(c.engine.signal().code,'RANGE_PRICE_STALE');
  assert.equal(c.store.rangeState().boundaryPauseSide,'lower');assert.equal(c.store.rangeState().boundaryResumedAt,null);
  c.fresh();await c.engine.attempt('paper');
  const order=c.store.orderForRound('paper',round);assert.equal(order.direction,'UP');assert.equal(order.rangeSignal.directionRule,'boundary_return');
  assert.match(c.engine.signal().message,/下支撑侧向上.*买 UP/);
});

test('paused side and resumed direction persist across SQLite restart without rewriting old order evidence',t=>{
  const folder=mkdtempSync(join(tmpdir(),'boundary-return-')),path=join(folder,'range.sqlite');let store=new RangeStore(path);
  t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  const id=store.rangeConfig().id,candidate=confirmationCandidate();
  store.saveRangeState(decide(null,candidate,190,end,majority,id));store.close();store=new RangeStore(path);
  assert.equal(store.rangeState().boundaryPauseSide,'upper');
  const state=store.saveRangeState(decide(store.rangeState(),candidate,150,end+1000,majority,id));
  store.reserveOrder({id:'return-evidence',mode:'paper',session:store.account('paper').session,round,end:round+300,status:'won',direction:'DOWN',signalRule:'range_regime',rangeSignal:{...state,price:150,priceAt:end+1000,directionRule:state.lockedDirectionRule}});
  store.close();store=new RangeStore(path);
  const repeated=store.saveRangeState(decide(store.rangeState(),candidate,151,end+2000,{complete:false,expected:12},id));
  assert.equal(repeated.direction,'DOWN');assert.equal(repeated.boundaryResumedAt,end+1000);
  const old=store.order('return-evidence').rangeSignal;assert.equal(old.boundaryResumeSide,'upper');assert.equal(old.boundaryResumeThreshold,180);assert.equal(old.boundaryResumePrice,150);
});

test('a new boundary return direction cannot place a second order in the same round',async t=>{
  const c=setup(t);await c.engine.start('paper');await c.engine.attempt('paper');
  const first=c.store.orderForRound('paper',round);assert.equal(first.direction,'UP');
  c.engine.spot.price=100.3;assert.equal(c.engine.signal().code,'RANGE_BOUNDARY_WAIT');
  c.engine.spot.price=100;assert.equal(c.engine.signal().direction,'DOWN');
  await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),1);
  assert.equal(c.store.orderForRound('paper',round).id,first.id);assert.equal(c.store.account('paper').running,true);
});


for(const side of ['lower','upper'])test('upgrade retains the active '+side+' pause without altering historical state',t=>{
  const folder=mkdtempSync(join(tmpdir(),'boundary-upgrade-')),path=join(folder,'range.sqlite');let store=new RangeStore(path);
  t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  const candidate=confirmationCandidate(),id=store.rangeConfig().id;
  const old=store.saveRangeState(decide(null,candidate,side==='lower'?110:190,end,majority,id));
  for(const name of ['boundary_pause_side','boundary_paused_at','boundary_resume_side','boundary_resumed_at','boundary_resume_price','boundary_resume_threshold'])store.db.exec('ALTER TABLE range_regimes DROP COLUMN '+name);
  store.close();store=new RangeStore(path);
  assert.equal(store.rangeState().boundaryPauseSide,side);assert.notEqual(store.rangeState().id,old.id);
  assert.equal(store.db.prepare('SELECT boundary_pause_side AS side FROM range_regimes WHERE id=?').get(old.id).side,null);
  const resumed=store.saveRangeState(decide(store.rangeState(),candidate,150,end+1000,majority,id));
  assert.equal(resumed.direction,side==='lower'?'UP':'DOWN');
});
