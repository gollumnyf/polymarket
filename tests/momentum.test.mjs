import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MomentumStore,MomentumEngine,momentumSignal} from '../server/momentum.mjs';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {createApp} from '../server/index.mjs';
import {apiPath} from '../src/api.mjs';

const start=1800000000;
function setup(t){
  let now=start*1000+1000;
  const store=new MomentumStore(':memory:');t.after(()=>store.close());
  const sample={oracleWindow:60,points:[{time:now-500,price:100.5},{time:now,price:101}]};
  const feed=new EventEmitter();let liveBuys=0;
  const venue={priceFeed:feed,latestOfficialPrices:()=>sample,readiness:()=>({enabled:false}),
    buy:async()=>{liveBuys++;throw Error('must never buy live');},resolution:async()=>null};
  const engine=new MomentumEngine(store,venue,{now:()=>now});
  engine.spot={sourceId:'polymarket',openingSource:'polymarket_official',source:'Polymarket TWAP 60s',windowSeconds:60,conditionId:'c',
    round:start,currentOpen:100,price:101,direction:'UP',at:now};
  engine.market={round:start,active:true,fetchedAt:now,slug:`btc-updown-5m-${start}`,conditionId:'c',
    outcomes:[{direction:'UP',index:0,assetId:'up'},{direction:'DOWN',index:1,assetId:'down'}],feeSchedule:{rate:0,exponent:1}};
  const book=()=>({fetchedAt:now,tickSize:0.01,minOrderSize:5,asks:[{price:'0.50',size:'1000'}],bids:[{price:'0.49',size:'1000'}]});
  engine.books={UP:book(),DOWN:book()};
  return {store,engine,sample,feed,venue,now:()=>now,setNow:value=>{now=value;},liveBuys:()=>liveBuys};
}

for(const rule of [
  {last:101,previous:100.5,want:'UP'}, {last:99,previous:99.5,want:'DOWN'},
  {last:101,previous:102,code:'OFFICIAL_DIRECTION_CONFLICT'},
  {last:99,previous:98,code:'OFFICIAL_DIRECTION_CONFLICT'},
  {last:101,previous:101,code:'OFFICIAL_LAST_MOVE_FLAT'},
  {last:100,previous:99,code:'OFFICIAL_AT_OPEN_PRICE'},
])test(`official momentum: ${rule.previous} -> ${rule.last} relative to opening 100`,async t=>{
  const {engine,store,sample,liveBuys}=setup(t);sample.points[0].price=rule.previous;sample.points[1].price=rule.last;
  await engine.start('paper');await engine.attempt('paper');await engine.attempt('paper');
  if(rule.want){const order=store.orders('paper')[0];assert.equal(order.direction,rule.want);assert.equal(order.signalRule,'official_momentum');assert.equal(order.price,0.5);assert.equal(order.momentumSignal.previousPrice,rule.previous);assert.equal(store.orderCount('paper'),1);}
  else{assert.equal(store.orderCount('paper'),0);assert.equal(store.entryBlock('paper',start).code,rule.code);}
  assert.equal(liveBuys(),0);
});

test('the first post-open tick can compare to a fresh pre-open tick, but the boundary tick itself cannot enter',async t=>{
  const {engine,store,sample,setNow}=setup(t);setNow(start*1000+100);
  engine.spot.at=start*1000+100;sample.points=[{time:start*1000-50,price:100},{time:start*1000,price:101}];
  await engine.start('paper');await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  sample.points[1].time=start*1000+100;await engine.attempt('paper');assert.equal(store.orderCount('paper'),1);
});

for(const variant of [
  ['nonofficial',s=>{s.engine.spot.sourceId='binance';},'OFFICIAL_SOURCE_REQUIRED'],
  ['local opening',s=>{s.engine.spot.openingSource='local_boundary';},'OFFICIAL_SOURCE_REQUIRED'],
  ['no opening',s=>{s.engine.spot.currentOpen=null;},'OFFICIAL_OPEN_MISSING'],
  ['wrong window',s=>{s.sample.oracleWindow=30;},'OFFICIAL_WINDOW_MISMATCH'],
  ['one tick',s=>{s.sample.points.shift();},'OFFICIAL_TWO_PRICES_REQUIRED'],
  ['duplicate timestamps',s=>{s.sample.points[0].time=s.sample.points[1].time;},'OFFICIAL_DUPLICATE_TIME'],
  ['future timestamp',s=>{s.sample.points[1].time=s.now()+1;},'OFFICIAL_FUTURE_PRICE'],
  ['stale latest',s=>{s.sample.points.forEach(p=>p.time-=7000);},'OFFICIAL_AFTER_OPEN_REQUIRED'],
  ['stale predecessor',s=>{s.sample.points[0].time=s.now()-6001;},'OFFICIAL_PREVIOUS_STALE'],
])test(`invalid official signal blocks: ${variant[0]}`,async t=>{
  const s=setup(t);variant[1](s);await s.engine.start('paper');await s.engine.attempt('paper');
  assert.equal(s.store.orderCount('paper'),0);assert.equal(s.store.entryBlock('paper',start).code,variant[2]);
});

test('a late stale quote is rejected even when still in the same round',t=>{
  const {engine,sample}=setup(t);const now=start*1000+30000;
  sample.points=[{time:now-8000,price:100},{time:now-7000,price:101}];
  assert.equal(momentumSignal(engine.spot,sample,now).code,'OFFICIAL_LATEST_STALE');
});

for(const [price,code] of [[0.49,null],[0.50,null],[0.50000000001,'MAX_PRICE_BELOW_BEST_ASK'],[0.51,'MAX_PRICE_BELOW_BEST_ASK'],[0.495,'ASK_OFF_TICK'],[0,'ASKS_EMPTY'],[1,'ASKS_EMPTY']])
test(`selected official ask ${price} obeys the inclusive 0.50 cap, valid range and tick`,async t=>{
  const {engine,store}=setup(t);engine.books.UP.asks[0].price=price;
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),code?0:1);
  if(code)assert.equal(store.entryBlock('paper',start).code,code);
});

test('actual ask depth, minimum shares, fees and stale books all gate entry without consuming a round',async t=>{
  const {engine,store,now}=setup(t);await engine.start('paper');
  engine.books.UP.asks=[{price:0.49,size:2},{price:0.51,size:1000}];await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  engine.books.UP.asks=[{price:0.5,size:1000}];engine.books.UP.minOrderSize=21;
  await engine.attempt('paper');assert.equal(store.entryBlock('paper',start).code,'BUDGET_BELOW_MINIMUM_SHARES');
  engine.books.UP.minOrderSize=20;engine.market.feeSchedule={rate:0.07,exponent:1};
  await engine.attempt('paper');assert.equal(store.entryBlock('paper',start).code,'BUDGET_BELOW_MINIMUM_SHARES');
  engine.books.UP.minOrderSize=5;engine.books.UP.fetchedAt=now()-6001;
  await engine.attempt('paper');assert.equal(store.entryBlock('paper',start).code,'BOOK_STALE');
  engine.books.UP.fetchedAt=now();await engine.attempt('paper');assert.equal(store.orderCount('paper'),1);
});

test('direction is rechecked after fill calculation and a new conflicting tick cancels the order',async t=>{
  const {engine,store,sample,now}=setup(t);const quote=engine.quote.bind(engine);
  engine.quote=(...args)=>{const result=quote(...args);sample.points=[{time:now()-1,price:102},{time:now(),price:101}];return result;};
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),0);assert.equal(store.entryBlock('paper',start).code,'OFFICIAL_DIRECTION_CONFLICT');
});

test('a fresh stream event triggers zero-delay entry and repeated events cannot buy twice',async t=>{
  const {engine,store,sample,feed,now}=setup(t);await engine.start('paper');
  feed.emit('price',{...sample.points[1],oracleWindow:60});
  feed.emit('price',{time:now(),price:101,oracleWindow:60});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(store.orderCount('paper'),1);assert.equal(store.orders('paper')[0].createdAt,start*1000+1000);
});

test('forecast loss doubles this independent account and forecast win restores the initial stake',async t=>{
  const {engine,store,now}=setup(t);const account=store.account('paper');
  store.reserveOrder({id:'previous',mode:'paper',session:account.session,round:start-300,end:start,status:'open',direction:'DOWN',conditionId:'old',budget:10,cost:10,shares:20});
  store.savePrediction({orderId:'previous',open:100,close:101,outcome:'UP',won:false,source:'polymarket_event_metadata',observedAt:now()});
  await engine.start('paper');await engine.attempt('paper');assert.equal(store.orderForRound('paper',start).budget,20);
  const next=setup(t);const a=next.store.account('paper');next.store.saveAccount({...a,losses:2});
  next.store.reserveOrder({id:'winning',mode:'paper',session:a.session,round:start-300,end:start,status:'open',direction:'UP',conditionId:'old',budget:40,cost:40,shares:80});
  next.store.savePrediction({orderId:'winning',open:100,close:101,outcome:'UP',won:true,source:'polymarket_event_metadata',observedAt:now()});
  await next.engine.start('paper');await next.engine.attempt('paper');assert.equal(next.store.orderForRound('paper',start).budget,10);
});

test('typed evidence and account state persist across restart, and clearing terminal history preserves round deduplication',async t=>{
  const {engine,store}=setup(t);await engine.start('paper');await engine.attempt('paper');const order=store.orders('paper')[0];
  const folder=mkdtempSync(join(tmpdir(),'momentum-'));let restored;t.after(()=>{restored?.close();rmSync(folder,{recursive:true,force:true});});
  const path=join(folder,'paper.sqlite'),disk=new MomentumStore(path);
  const a=disk.account('paper');disk.reserveOrder({...order,session:a.session,momentumSignal:order.momentumSignal});disk.close();
  restored=new MomentumStore(path);
  assert.equal(restored.account('paper').running,false);assert.deepEqual(restored.order(order.id).momentumSignal,order.momentumSignal);
  restored.saveOrder({...restored.order(order.id),status:'won'});assert.equal(restored.clearPaperOrders(),1);
  assert.equal(restored.db.prepare('SELECT count(*) AS n FROM momentum_order_signals').get().n,0);assert.equal(restored.hasRound('paper',start),true);
});

test('new page APIs isolate tokens, configurations, funds and live permissions from the original app',async t=>{
  const {engine:momentum,store:newStore,venue}=setup(t);
  const oldStore=new Store(':memory:');t.after(()=>oldStore.close());const old=new Engine(oldStore,venue);
  const server=createApp(old,{momentumEngine:momentum}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.close();server.closeAllConnections();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const original=await(await fetch(base+'/api/state')).json(),fresh=await(await fetch(base+'/momentum/api/state')).json();
  assert.notEqual(original.controlToken,fresh.controlToken);assert.equal(fresh.strategy,'official_momentum');
  const post=(path,token,body={})=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Control-Token':token},body:JSON.stringify(body)});
  assert.equal((await post('/momentum/api/paper/start',original.controlToken)).status,403);
  assert.equal((await post('/momentum/api/live/start',fresh.controlToken)).status,400);
  const config={...newStore.account('paper').config,baseAmount:7};
  assert.equal((await post('/momentum/api/paper/config',fresh.controlToken,config)).status,200);
  assert.equal(newStore.account('paper').config.baseAmount,7);assert.equal(oldStore.account('paper').config.baseAmount,10);
  assert.equal((await post('/momentum/api/paper/config',fresh.controlToken,{...config,maxPrice:0.51})).status,400);
  assert.equal((await post('/momentum/api/paper/start',fresh.controlToken)).status,200);
  await momentum.attempt('paper');assert.equal(newStore.orderCount('paper'),1);assert.equal(oldStore.orderCount('paper'),0);
  const page=await(await fetch(base+'/momentum/api/paper/orders?pageSize=1')).json();assert.equal(page.items.length,1);assert.ok(page.items[0].momentumSignal);
  assert.equal(apiPath('paper/orders','/momentum'),'/momentum/api/paper/orders');assert.equal(apiPath('state','/paper'),'/api/state');
});
