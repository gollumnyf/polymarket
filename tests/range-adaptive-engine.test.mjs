import test from 'node:test';
import assert from 'node:assert/strict';
import {RangeAdaptiveEngine} from '../server/range-adaptive-engine.mjs';
import {RangeLiveEngine} from '../server/range-live-engine.mjs';
import {RangeStore} from '../server/range-store.mjs';

const round=1800000000;
function fixture(t){
  const store=new RangeStore(':memory:');let now=(round+59)*1000;
  const a=store.account('paper');store.saveAccount({...a,balance:900,losses:2,cycle:3,config:{...a.config,baseAmount:10,entryWindow:120}});
  const engine=new RangeAdaptiveEngine(store,{readiness:()=>({enabled:false})},{now:()=>now});
  engine.adaptiveSampler={sample:()=>({opening:100,price:100.02,f:{regime:'range',zone:'middle',trend:'UP',early:'UP',position:.6,efficiency:.1,noise:.1,move:.2,lower:99.9,upper:100.1,streak:1,last:'UP'}})};
  const fresh=()=>{engine.spot={sourceId:'polymarket',source:'Polymarket',round,conditionId:'c',price:100.02,currentOpen:100,at:now,windowSeconds:60,direction:'UP'};engine.market={round,conditionId:'c',active:true,fetchedAt:now,slug:'btc-updown-5m-'+round,feeSchedule:{rate:.07,exponent:1},outcomes:[{direction:'UP',assetId:'u',index:0},{direction:'DOWN',assetId:'d',index:1}]};engine.books={UP:{fetchedAt:now,tickSize:.01,minOrderSize:5,asks:[{price:.5,size:1000}],bids:[]}};};fresh();
  t.after(()=>store.close());return {engine,store,setNow:x=>{now=x;fresh();},now:()=>now};
}
test('RA-01.1 keeps balance and loss accounting while using base stake in protection and deduping orders',async t=>{
  const c=fixture(t);assert.equal(c.store.account('paper').balance,900);assert.equal(c.store.account('paper').losses,2);assert.equal(c.store.account('paper').config.entryDelay,60);assert.equal(c.store.account('paper').config.entryWindow,65);
  await c.engine.start('paper');await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),0);
  c.setNow((round+60)*1000);assert.equal(c.engine.snapshot().accounts.paper.nextAmount,10);await c.engine.attempt('paper');const o=c.store.orders('paper')[0];assert(o);assert.equal(o.signalRule,'range_adaptive_ra01');assert.equal(o.budget,10);assert.equal(o.doubling,0);assert.equal(o.direction,'UP');assert.equal(o.price,.5);assert.match(o.entryReason,/RA-01\.1.*连续两笔失利保护/);
  assert.equal(c.store.db.prepare('SELECT rule FROM range_adaptive_order_signals WHERE order_id=?').get(o.id).rule,'aligned');
  await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),1);await assert.rejects(()=>c.engine.start('live'));
});
test('RA-01.1 streak reversals require the fixed 60-second move to agree',async t=>{
  const c=fixture(t),sample=c.engine.adaptiveSampler.sample;
  let early='DOWN';c.engine.adaptiveSampler.sample=()=>{const s=sample();return {...s,price:early==='UP'?100.02:early==='DOWN'?99.98:100,f:{...s.f,regime:'trend',streak:3,last:'DOWN',early}};};
  await c.engine.start('paper');c.setNow((round+60)*1000);await c.engine.attempt('paper');
  assert.equal(c.engine.signal().code,'RA_STREAK_NOT_CONFIRMED');assert.equal(c.store.orderCount('paper'),0);
  early=null;c.setNow((round+360)*1000);assert.match(c.engine.signal().message,/持平/);
  early='UP';c.setNow((round+660)*1000);assert.equal(c.engine.signal().direction,'UP');assert.equal(c.engine.entryGuard(),null);
});
test('RA-01.1 protection survives amount cycle resets and uses official outcomes ahead of predictions',t=>{
  const c=fixture(t),a={...c.store.account('paper'),losses:0};
  const book={};
  for(const [i,status] of ['lost','open'].entries()){
    const r=round-600+i*300,id='prior-'+i;
    c.store.reserveOrder({id,mode:'paper',session:a.session,round:r,end:r+300,status:'placing',direction:'UP',budget:10,doubling:0,createdAt:r*1000,signalRule:'range_adaptive_ra01'},book);
    c.store.saveOrder({...c.store.order(id),status});
  }
  c.store.savePrediction({orderId:'prior-1',open:100,close:99,outcome:'DOWN',won:false,source:'polymarket_endpoints',observedAt:round*1000});
  assert.equal(c.engine.executionAccount(a).stakeLosses,0);
  c.store.saveOrder({...c.store.order('prior-1'),status:'won'});
  assert.equal(c.engine.executionAccount(a).stakeLosses,undefined);
});
test('RA-01 refuses old books, price above half and late entry; signals freeze at decision point',async t=>{
  const c=fixture(t);await c.engine.start('paper');c.setNow((round+60)*1000);c.engine.books.UP.fetchedAt=(round+59)*1000;await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),0);
  c.setNow((round+61)*1000);c.engine.books.UP.asks[0].price=.51;await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),0);
  c.engine.adaptiveSampler.sample=()=>{throw Error('must not resample frozen signal');};assert.equal(c.engine.signal().direction,'UP');
  c.setNow((round+66)*1000);await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),0);assert.equal(c.engine.signal().code,'RA_CLOSED');
});
test('live keeps legacy direction, original entry window and legacy quote policy',t=>{
  const c=fixture(t),store=new RangeStore(':memory:');t.after(()=>store.close());const a=store.account('live');store.saveAccount({...a,config:{...a.config,entryWindow:120}});
  c.setNow((round+60)*1000);c.engine.legacySignal=()=>({direction:'DOWN',code:null,state:{tradeFromRound:0},message:'legacy',directionRule:'range_majority'});
  const live=new RangeLiveEngine(store,{readiness:()=>({enabled:false})},c.engine,{now:c.now});live.spot=c.engine.spot;live.market=c.engine.market;
  assert.equal(c.engine.signal().direction,'UP');assert.equal(live.signal().direction,'DOWN');assert.equal(store.account('live').config.entryWindow,120);assert.equal(store.account('paper').running,false);
  live.analysis=()=>({config:{streakReverseEnabled:false,executionMaxPrice:.55}});
  assert.throws(()=>live.quote({...c.engine.books.UP,asks:[{price:.5,size:1000}]},10,a.config,{rate:.07,exponent:1}),/低于/);
  assert.equal(c.engine.quote(c.engine.books.UP,10,c.store.account('paper').config,{rate:.07,exponent:1}).price,.5);
});
