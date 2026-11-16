import test from 'node:test';
import {createApp} from '../server/index.mjs';
import assert from 'node:assert/strict';
import {LeadStore} from '../server/lead-store.mjs';
import {LeadEngine} from '../server/lead-engine.mjs';
import {LEAD_DEFAULTS,leadConfig,leadSignal,sharesQuote} from '../server/lead-pair.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const round=1800000000,base=round*1000;
function fixture(t,path=':memory:'){
  const store=new LeadStore(path);let now=base+30000;
  const venue={readiness:()=>({enabled:false}),resolution:async()=>({payout:0})};
  const engine=new LeadEngine(store,venue,{now:()=>now});
  const fresh=()=>{engine.spot={sourceId:'polymarket',round,conditionId:'c',price:100,currentOpen:100,at:now,windowSeconds:60};engine.market={round,conditionId:'c',active:true,slug:'test',feeSchedule:{rate:0.07,exponent:1},outcomes:[{direction:'UP',assetId:'up',index:0},{direction:'DOWN',assetId:'down',index:1}]};engine.books={UP:{fetchedAt:now,tickSize:0.01,minOrderSize:1,asks:[{price:0.5,size:100}]},DOWN:{fetchedAt:now,tickSize:0.01,minOrderSize:1,asks:[{price:0.3,size:100}]}};};fresh();
  for(let i=0;i<=15;i++)for(const source of ['official','binance'])engine.sample({source,time:now-(15-i)*1000,receivedAt:now-(15-i)*1000,price:source==='binance'?100+i*0.01:100});
  t.after(()=>{engine.closing=true;store.close();});
  return {store,engine,setNow:n=>{now=n;fresh();},now:()=>now};
}
test('lead signal requires complete fresh same-window receipts, not absolute USD/USDT price difference',()=>{
  const samples=[];for(let i=0;i<=15;i++)for(const source of ['official','binance'])samples.push({source,time:i*1000,receivedAt:i*1000,price:source==='official'?100:1000+i});
  assert.equal(leadSignal(samples,15000,LEAD_DEFAULTS).direction,'UP');
  assert.equal(leadSignal(samples,20000,LEAD_DEFAULTS).direction,null);
  assert.equal(leadSignal(samples.filter(x=>x.receivedAt>0),15000,LEAD_DEFAULTS).direction,null);
  assert.throws(()=>leadConfig({delayMs:0}));assert.throws(()=>leadConfig({firstMaxPrice:1}));
});
test('equal-share quote includes fees and rejects insufficient depth, off tick and minimum size',()=>{
  const book={tickSize:0.01,minOrderSize:5,asks:[{price:0.35,size:10}]},fee={rate:0.07,exponent:1};
  assert.equal(sharesQuote(book,10,0.4,fee).cost,3.65925);
  assert.throws(()=>sharesQuote(book,11,0.4,fee),/深度/);assert.throws(()=>sharesQuote(book,4,0.4,fee),/最小/);
  assert.throws(()=>sharesQuote({...book,asks:[{price:0.355,size:10}]},10,0.4,fee),/tick/);
});
test('fixed stake enters only after delay and fresh quote, pairs equal shares once, settles aggregate PnL once',async t=>{
  const c=fixture(t);await c.engine.start('paper');await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),0);
  c.setNow(base+30500);await c.engine.attempt('paper');let order=c.store.orders('paper')[0];assert(order);assert.equal(order.budget,6);assert.equal(order.pairLegs.length,1);
  await c.engine.attempt('paper');assert.equal(c.store.legs(order.id).length,1);
  c.setNow(base+31000);await c.engine.attempt('paper');order=c.store.order(order.id);assert.equal(order.pairLegs.length,2);assert.equal(order.pairLegs[0].shares,order.pairLegs[1].shares);
  await c.engine.attempt('paper');assert.equal(c.store.legs(order.id).length,2);assert.equal(c.store.orderCount('paper'),1);
  c.setNow(base+301000);await c.engine.settleInOrder();const a=c.store.account('paper');assert.equal(a.settled,1);assert(a.pnl>0);assert.equal(a.losses,0);assert.equal(c.store.order(order.id).payout,order.shares);
  await c.engine.settleInOrder();assert.equal(c.store.account('paper').balance,a.balance);assert.equal(c.engine.snapshot().accounts.paper.nextAmount,6);
});
test('price change during delay cancels entry; pause cancels a planned fill',async t=>{
  const c=fixture(t);await c.engine.start('paper');await c.engine.attempt('paper');c.setNow(base+30500);c.engine.books.UP.asks[0].price=0.7;
  await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),0);assert.equal(c.engine.plan,null);
  c.setNow(base+31000);await c.engine.attempt('paper');c.engine.stop('paper');c.setNow(base+31500);await c.engine.attempt('paper');assert.equal(c.store.orderCount('paper'),0);
});
test('unprofitable hedge is not bought, unpaired loss never doubles the next stake',async t=>{
  const c=fixture(t);await c.engine.start('paper');await c.engine.attempt('paper');c.setNow(base+30500);await c.engine.attempt('paper');c.engine.books.DOWN.asks[0].price=0.7;await c.engine.attempt('paper');
  assert.equal(c.store.orders('paper')[0].pairLegs.length,1);c.setNow(base+301000);await c.engine.settleInOrder();assert(c.store.account('paper').pnl<0);assert.equal(c.engine.snapshot().accounts.paper.nextAmount,6);
});
test('legs and reasons persist across restart; fresh starts paused, never enables live',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lead-restart-')),path=join(dir,'test.sqlite');let store=new LeadStore(path);
  try{store.reserveOrder({id:'x',mode:'paper',round,session:store.account('paper').session,status:'open',direction:'UP',shares:10,cost:5});store.saveLeg({id:'x'},1,{shares:10,cost:5,fee:0,price:0.5},{fetchedAt:base,asks:[{price:0.5,size:10}]},base,'test','UP',base);store.close();store=new LeadStore(path);assert.equal(store.order('x').pairLegs.length,1);assert.equal(store.account('paper').running,false);const e=new LeadEngine(store,{},{});await assert.rejects(()=>e.start('live'));}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

 test('independent paper API rejects live trading and persists validated settings',async t=>{
  const c=fixture(t),server=createApp(c.engine,{allowedModes:['paper']}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port,state=await(await fetch(base+'/api/state')).json();
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Control-Token':state.controlToken},body:JSON.stringify(body)});
  assert.equal((await post('/api/live/start',{})).status,400);
  assert.equal((await post('/api/paper/config',{...state.accounts.paper.config,leadConfig:{...LEAD_DEFAULTS,delayMs:1000}})).status,200);
  assert.equal(c.store.leadConfig().delayMs,1000);
  assert.equal((await post('/api/paper/config',{...state.accounts.paper.config,leadConfig:{delayMs:-1}})).status,400);
  assert.equal(c.store.leadConfig().delayMs,1000);
 });
