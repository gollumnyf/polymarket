import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RangeStore} from '../server/range-store.mjs';
import {RangeEngine} from '../server/range-engine.mjs';
import {RangeLiveEngine} from '../server/range-live-engine.mjs';
import {validateRangeConfig} from '../server/range-strategy.mjs';

const round=1800000000,end=round*1000;
function fixture(t,{path=':memory:',settings={},levels=true}={}){
  let now=end+1;const store=new RangeStore(path),{id,...config}=store.rangeConfig();store.saveRangeConfig({...config,...settings});
  if(levels)for(let i=4;i<=51;i++)store.marketRound(round-i*300,100,200,60,end);
  const venue={priceFeed:new EventEmitter(),readiness:()=>({enabled:false}),resolution:async()=>null};
  const engine=new RangeEngine(store,venue,{now:()=>now});
  const fresh=()=>{const r=Math.floor(now/300000)*300;engine.spot={sourceId:'polymarket',openingSource:'polymarket_official',windowSeconds:60,round:r,conditionId:'c',currentOpen:100,price:150,at:now};engine.market={round:r,conditionId:'c',active:true,fetchedAt:now,slug:'btc-updown-5m-'+r,outcomes:[{direction:'UP',index:0,assetId:'up'},{direction:'DOWN',index:1,assetId:'down'}],feeSchedule:{rate:0,exponent:1}};engine.books=Object.fromEntries(['UP','DOWN'].map(d=>[d,{fetchedAt:now,tickSize:0.01,minOrderSize:5,asks:[{price:0.8,size:1000}],bids:[{price:0.79,size:1000}]}]));};fresh();
  const vote=(r,outcome,source='official')=>store.saveVote({round:r,outcome,source,open:100,close:outcome==='UP'?101:99,updatedAt:now});
  const streak=(outcome,last=round-300,count=3)=>{for(let i=0;i<count;i++)vote(last-i*300,outcome);};
  let closed=false;const close=()=>{engine.closing=true;if(!closed){store.close();closed=true;}};t.after(close);
  return {store,engine,venue,fresh,vote,streak,close,now:()=>now,setNow:value=>{now=value;fresh();}};
}

test('streak defaults enabled at three and rejects invalid configuration',()=>{
  assert.equal(validateRangeConfig().streakReverseEnabled,true);assert.equal(validateRangeConfig().streakReverseRounds,3);
  for(const value of ['true',1,null])assert.throws(()=>validateRangeConfig({streakReverseEnabled:value}));
  for(const value of [0,1,2.5,49,'3',null])assert.throws(()=>validateRangeConfig({streakReverseRounds:value}));
});

for(const direction of ['UP','DOWN'])test(direction+' market streak buys opposite above 0.55 at open once inside a valid blue region',async t=>{
  const c=fixture(t);c.streak(direction);c.store.saveAccount({...c.store.account('paper'),losses:1,config:{...c.store.account('paper').config,slippage:0}});
  await c.engine.start('paper');await c.engine.attempt('paper');await c.engine.attempt('paper');
  const order=c.store.orderForRound('paper',round);assert.ok(order);assert.equal(order.direction,direction==='UP'?'DOWN':'UP');assert.equal(order.price,0.8);assert.equal(order.budget,20);assert.equal(order.createdAt,end+1);
  assert.match(order.entryReason,/仅统计当前开盘场次紧前/);assert.match(order.entryReason,/蓝色区域/);assert.match(order.entryReason,/马丁第 2 笔/);assert.equal(order.signalRule,'range_streak_reverse');assert.equal(order.streakSignal.samples.length,3);assert.equal(order.streakSignal.marketDirection,direction);assert.equal(c.store.orderCount('paper'),1);
  assert.ok(c.store.rangeState());assert.equal(c.store.account('paper').running,true);
});

test('only adjacent ended rounds trigger, with a configurable count',t=>{
  const c=fixture(t,{settings:{streakReverseRounds:4}});c.streak('UP');c.vote(round-1200,'DOWN');c.vote(round,'UP');
  assert.equal(c.engine.signal().streakSignal,undefined);
  c.vote(round-1500,'UP');assert.equal(c.engine.signal().streakSignal,undefined);
  c.vote(round-1200,'DOWN');assert.equal(c.engine.signal().streakSignal,undefined);
  c.vote(round-1200,'UP');assert.equal(c.engine.signal().direction,'DOWN');
});

test('missing immediately previous market cannot be replaced by a saved older streak',t=>{
  const c=fixture(t);c.streak('DOWN');assert.equal(c.engine.signal().streakSignal.direction,'UP');
  c.setNow(end+300001);
  assert.equal(c.engine.signal().streakSignal,undefined);
  c.vote(round,'UP');assert.equal(c.engine.signal().streakSignal,undefined);
  c.vote(round,'DOWN');assert.equal(c.engine.signal().streakSignal.lastRound,round);
});

test('a gap or void breaks a streak and mixed latest rounds cannot reuse an earlier trigger',t=>{
  const c=fixture(t);c.streak('UP');c.store.db.prepare('DELETE FROM range_votes WHERE round=?').run(round-600);
  assert.equal(c.engine.signal().streakSignal,undefined);c.store.saveVote({round:round-600,source:'official_void',updatedAt:c.now()});assert.equal(c.engine.signal().streakSignal,undefined);
  c.store.db.prepare('DELETE FROM range_votes WHERE round=?').run(round-600);c.vote(round-600,'UP');assert.equal(c.engine.signal().direction,'DOWN');
  for(let i=0;i<3;i++){c.vote(round+i*300,'DOWN');c.setNow(end+(i+1)*300000+1);assert.equal(c.engine.signal().streakSignal?.direction,i===2?'UP':undefined);}
  assert.equal(c.engine.signal().streakSignal.lastRound,round+600);
});

test('untraded predicted market rounds trigger and official disagreement withdraws the evidence',async t=>{
  const c=fixture(t);for(let i=1;i<=3;i++)c.store.marketRound(round-i*300,100,101,60,end);
  const first=c.engine.signal();assert.equal(first.direction,'DOWN');assert.ok(first.streakSignal.samples.every(s=>s.source==='polymarket_crypto_price'));assert.equal(c.store.orderCount('paper'),0);
  await c.engine.start('paper');await c.engine.attempt('paper');
  c.store.saveHistoricalRound({round:round-300,end:round,slug:'btc-updown-5m-'+(round-300),status:'resolved',result:'DOWN',open:100,close:99},end+2);
  assert.equal(c.engine.signal().streakSignal,undefined);assert.equal(c.store.orderForRound('paper',round).streakSignal.samples.at(-1).outcome,'UP');
  await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),1);
});

test('a corrected newest streak never falls back to an older trigger',t=>{
  const c=fixture(t);c.streak('UP');assert.equal(c.engine.signal().direction,'DOWN');
  for(let i=0;i<3;i++)c.store.marketRound(round+i*300,100,99,60,end+(i+1)*300000);
  c.setNow(end+900001);assert.equal(c.engine.signal().direction,'UP');
  c.store.saveHistoricalRound({round:round+600,end:round+900,slug:'btc-updown-5m-'+(round+600),status:'resolved',result:'UP',open:100,close:101},c.now());
  const corrected=c.engine.signal();assert.equal(corrected.streakSignal,undefined);
});

test('an official confirmation upgrades evidence without duplicate events or changing archived order data',async t=>{
  const c=fixture(t);for(let i=1;i<=3;i++)c.store.marketRound(round-i*300,100,101,60,end);
  await c.engine.start('paper');await c.engine.attempt('paper');
  for(let i=1;i<=3;i++)c.store.saveHistoricalRound({round:round-i*300,end:round-(i-1)*300,slug:'btc-updown-5m-'+(round-i*300),status:'resolved',result:'UP'},end+2);
  const signal=c.engine.signal();assert.ok(signal.streakSignal.samples.every(s=>s.source==='official'));
  const count=c.store.db.prepare('SELECT COUNT(*) AS n FROM range_streak_events').get().n;
  for(let i=0;i<5;i++)c.engine.signal();assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM range_streak_events').get().n,count);
  assert.ok(c.store.orderForRound('paper',round).streakSignal.samples.every(s=>s.source==='polymarket_crypto_price'));
});

test('disabling streak removes its override and restores price gates',t=>{
  const c=fixture(t);c.streak('UP');assert.equal(c.engine.signal().direction,'DOWN');
  const {id,...config}=c.store.rangeConfig();c.store.saveRangeConfig({...config,streakReverseEnabled:false});c.engine.analysisCache=null;
  assert.equal(c.engine.signal().streakSignal,undefined);
  assert.throws(()=>c.engine.quote(c.engine.books.DOWN,10,c.store.account('paper').config,{rate:0,exponent:1}),e=>e.code==='RANGE_PRICE_NOT_BELOW_HALF');
});

test('unrestricted pricing still enforces valid prices, ticks, depth, minimum shares and fees',t=>{
  const c=fixture(t);c.streak('UP');const book=c.engine.books.DOWN,config=c.store.account('paper').config,quote=b=>c.engine.quote(b,10,config,{rate:0.07,exponent:1});
  const expensive=quote({...book,asks:[{price:0.99,size:100}]});assert.equal(expensive.priceLimit,0.99);assert.ok(expensive.fee>0);
  assert.throws(()=>quote({...book,asks:[{price:1,size:100}]}),e=>e.code==='ASKS_EMPTY');
  assert.throws(()=>quote({...book,asks:[{price:0.805,size:100}]}),e=>e.code==='ASK_OFF_TICK');
  assert.throws(()=>quote({...book,asks:[{price:0.8,size:1}]}),e=>e.code==='ORDER_BOOK_DEPTH_EXHAUSTED');
  assert.throws(()=>quote({...book,minOrderSize:100}),e=>e.code==='BUDGET_BELOW_MINIMUM_SHARES');
  const tiny=quote({...book,tickSize:0.0000001,asks:[{price:0.9999999,size:100}]});assert.ok(tiny.priceLimit<1);assert.equal(tiny.priceLimit,0.9999999);
});

test('price-policy correction after quoting cancels entry even before reservation',async t=>{
  const c=fixture(t);c.streak('UP');const original=c.engine.quote.bind(c.engine);c.engine.quote=(...args)=>{const quote=original(...args);c.vote(round-300,'DOWN');return quote;};
  await c.engine.start('paper');await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),0);assert.equal(c.store.account('paper').running,true);
});

test('stale market data and account limits still block a streak trade',async t=>{
  const c=fixture(t);c.streak('UP');await c.engine.start('paper');c.engine.books.DOWN.fetchedAt=end-7000;
  await c.engine.attempt('paper');assert.equal(c.engine.entryBlocks.paper.code,'BOOK_STALE');c.fresh();
  c.store.saveAccount({...c.store.account('paper'),balance:0});await c.engine.attempt('paper');assert.equal(c.engine.entryBlocks.paper.code,'RISK_LIMIT');assert.equal(c.store.orderCount('paper'),0);
});

test('typed order samples survive restart while mixed latest rounds disable old triggers',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'range-streak-')),path=join(folder,'test.sqlite');
  const c=fixture(t,{path});c.streak('UP');await c.engine.start('paper');await c.engine.attempt('paper');c.close();
  const store=new RangeStore(path);t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});const engine=new RangeEngine(store,c.venue,{now:()=>end+300001});engine.spot={...c.engine.spot,round:round+300,at:end+300001};store.saveVote({round,outcome:'DOWN',source:'official',updatedAt:end+300000});
  assert.equal(engine.signal().streakSignal,undefined);assert.equal(store.orderForRound('paper',round).streakSignal.samples.length,3);assert.equal(store.account('paper').running,false);
});

test('migration enables new rule without rewriting historical config, and saved disable survives restart',t=>{
  const folder=mkdtempSync(join(tmpdir(),'streak-migration-')),path=join(folder,'test.sqlite');let store=new RangeStore(path);t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  const old=store.rangeConfig().id;store.db.exec('ALTER TABLE range_configs DROP COLUMN streak_reverse_enabled; ALTER TABLE range_configs DROP COLUMN streak_reverse_rounds');store.close();store=new RangeStore(path);
  assert.equal(store.rangeConfig().streakReverseEnabled,true);assert.equal(store.rangeConfig().streakReverseRounds,3);assert.notEqual(store.rangeConfig().id,old);
  assert.equal(store.db.prepare('SELECT streak_reverse_enabled FROM range_configs WHERE id=?').get(old).streak_reverse_enabled,0);
  const {id,...config}=store.rangeConfig();store.saveRangeConfig({...config,streakReverseEnabled:false,streakReverseRounds:4});store.close();store=new RangeStore(path);assert.equal(store.rangeConfig().streakReverseEnabled,false);assert.equal(store.rangeConfig().streakReverseRounds,4);
});

test('live follows the same unlocked price policy with separate order evidence and capital',async t=>{
  const source=fixture(t);source.streak('UP');const store=new RangeStore(':memory:');t.after(()=>store.close());const sent=[];
  const venue={priceFeed:new EventEmitter(),readiness:()=>({enabled:true,configured:true,authenticated:true}),balance:async()=>10000,buy:async(order,quote,guard)=>{assert.equal(guard(),true);sent.push({order,quote});return {ok:true,orderId:'live-'+order.id,tradeIds:[]};}};
  const engine=new RangeLiveEngine(store,venue,source.engine,{now:source.now});engine.spot={...source.engine.spot};engine.market=structuredClone(source.engine.market);engine.books=structuredClone(source.engine.books);
  engine.configure('live',{...store.account('live').config,baseAmount:7,slippage:0});await engine.start('live');await engine.attempt('live');
  assert.equal(sent.length,1);assert.equal(sent[0].order.direction,'DOWN');assert.equal(sent[0].order.budget,7);assert.equal(sent[0].quote.priceLimit,0.99);assert.equal(store.orderForRound('live',round).streakSignal.samples.length,3);assert.equal(source.store.orderCount('paper'),0);
});


test('a withdrawn unrestricted quote cannot pass the final guard just because direction stays the same',t=>{
  const c=fixture(t);c.streak('UP');const quote=c.engine.quote(c.engine.books.DOWN,10,c.store.account('paper').config,{rate:0,exponent:1});
  assert.equal(quote.streakUnrestricted,true);c.engine.signal=()=>({direction:'DOWN',code:null,directionRule:'boundary_return'});
  assert.equal(c.engine.quoteGuard(quote).code,'STREAK_POLICY_CHANGED');
});


for(const price of [90,100,120,180,200,210])test('streak cannot trade outside strict blue bounds at '+price,async t=>{
  const c=fixture(t);c.streak('UP');c.engine.spot.price=price;await c.engine.start('paper');await c.engine.attempt('paper');
  assert.equal(c.store.orderCount('paper'),0);assert.equal(c.engine.entryBlocks.paper.code,'RANGE_BOUNDARY_WAIT');
  const signal=c.engine.signal();assert.equal(signal.direction,null);assert.equal(signal.lockedStreak.direction,'DOWN');assert.equal(signal.streakSignal,undefined);
  assert.equal(c.store.account('paper').running,true);
});

test('missing range history cannot enable unrestricted streak entry',async t=>{
  const c=fixture(t,{levels:false});c.streak('UP');await c.engine.start('paper');await c.engine.attempt('paper');
  assert.equal(c.store.orderCount('paper'),0);assert.equal(c.engine.entryBlocks.paper.code,'RANGE_LEVEL_HISTORY_INCOMPLETE');assert.equal(c.engine.signal().lockedStreak.direction,'DOWN');
});

test('streak retains its direction but waits for two blue closes after a boundary pause',async t=>{
  const c=fixture(t);c.streak('UP');c.engine.spot.price=110;assert.equal(c.engine.signal().code,'RANGE_BOUNDARY_WAIT');
  c.engine.spot.price=150;assert.equal(c.engine.signal().code,'RANGE_RETURN_CONFIRMING');
  c.store.marketRound(round,149,150,60,end+300000);c.setNow(end+300001);
  assert.equal(c.engine.signal().state.boundaryConfirmCount,1);assert.equal(c.engine.signal().direction,null);
  c.store.marketRound(round+300,149,150,60,end+600000);c.setNow(end+600001);
  const ready=c.engine.signal();assert.equal(ready.direction,'DOWN');assert.equal(ready.state.boundaryPauseSide,null);
  await c.engine.start('paper');await c.engine.attempt('paper');assert.equal(c.store.orderForRound('paper',round+600).direction,'DOWN');
});

test('leaving blue area after a valid quote cancels order and final live quote guard',async t=>{
  const c=fixture(t);c.streak('UP');const quote=c.engine.quote(c.engine.books.DOWN,10,c.store.account('paper').config,{rate:0,exponent:1});
  c.engine.spot.price=190;assert.equal(c.engine.quoteGuard(quote).code,'RANGE_BOUNDARY_WAIT');
  await c.engine.start('paper');await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),0);
});
