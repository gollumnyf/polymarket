import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {adaptiveFeatures,adaptiveDirection,evaluateSignals,wilson} from '../server/range-adaptive.mjs';
import {RangeAdaptiveObserver} from '../server/range-adaptive-observer.mjs';
const round=1800000000;
function fixture(t){
  let now=(round+60)*1000,result=null;const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE round_openings(round INTEGER,oracle_window INTEGER,observed_at INTEGER,open_price REAL);CREATE TABLE range_price_bars(oracle_window INTEGER,bucket INTEGER,first_at INTEGER,last_at INTEGER,open REAL,close REAL);');
  db.prepare('INSERT INTO round_openings VALUES(?,?,?,?)').run(round,60,round*1000+5000,100);
  const insert=db.prepare('INSERT INTO range_price_bars VALUES(?,?,?,?,?,?)');
  for(let i=0;i<48;i++){const at=(round-(48-i)*300)*1000;insert.run(60,at,at+1000,at+4000,100,100);insert.run(60,at+295000,at+296000,at+299000,100,i%2?100.1:99.9);}
  insert.run(60,(round+55)*1000,(round+55)*1000,(round+59)*1000,100.01,100.02);
  const engine={store:{db,historicalRound:()=>result},market:{round,active:true,feeSchedule:{rate:0.07,exponent:1}},venue:{books:async()=>({UP:{fetchedAt:now,tickSize:0.01,minOrderSize:5,asks:[{price:0.49,size:100}]}})}};
  const observer=new RangeAdaptiveObserver(':memory:',engine,{now:()=>now});t.after(()=>{observer.close();db.close();});return {db,engine,observer,setNow:x=>now=x,setResult:x=>result=x};
}
test('adaptive research features reject gaps and route without future outcomes',()=>{
  const h=Array.from({length:48},(_,i)=>({round:round-(48-i)*300,open:100,close:i%2?100.1:99.9}));
  const f=adaptiveFeatures(h,100,100.02);assert.equal(f.regime,'range');assert.equal(f.zone,'middle');assert.equal(adaptiveDirection(f,'aligned'),'UP');assert.equal(adaptiveDirection({...f,trend:'DOWN'},'aligned'),null);
  assert.equal(adaptiveFeatures(h.slice(1),100,100.02),null);h[3].round+=1;assert.equal(adaptiveFeatures(h,100,100.02),null);
  assert.deepEqual(wilson(0,0),[0,1]);const stats=evaluateSignals([{round,outcome:'DOWN'},{round:round+300,outcome:'UP'},{round:round+600,outcome:'UP'}],()=> 'DOWN');assert.equal(stats.n,3);assert.equal(stats.maxLossStreak,2);
});
test('observer waits for 60 seconds, simulates once with fees, settles once, never changes account',async t=>{
  const c=fixture(t);c.setNow((round+59)*1000);await c.observer.tick();assert.equal(c.observer.snapshot().stats.rounds,0);
  c.setNow((round+60)*1000);await c.observer.tick();let row=c.observer.snapshot().items[0];assert.equal(row.direction,'UP');assert.equal(row.status,'filled');assert(row.fee>0);await c.observer.tick();assert.equal(c.observer.snapshot().stats.rounds,1);
  c.setNow((round+301)*1000);c.setResult({status:'resolved',result:'UP'});c.observer.settle();row=c.observer.snapshot().items[0];assert.equal(row.status,'won');assert.equal(row.correct,1);const pnl=row.pnl;c.observer.settle();assert.equal(c.observer.snapshot().stats.pnl,pnl);
});
test('late opening or future current-price bucket cannot enter historical decision',t=>{
  const c=fixture(t),at=(round+60)*1000,f=c.observer.sample(round,at);
  c.db.prepare('INSERT INTO range_price_bars VALUES(?,?,?,?,?,?)').run(60,at,at+1000,at+4000,110,110);assert.deepEqual(c.observer.sample(round,at),f);
  c.db.prepare('UPDATE round_openings SET observed_at=?').run(at+1);assert.match(c.observer.sample(round,at).error,/起始价/);
});
test('expensive book records signal correctness separately from executable fills',async t=>{
  const c=fixture(t);c.engine.venue.books=async()=>({UP:{fetchedAt:(round+60)*1000,tickSize:0.01,minOrderSize:5,asks:[{price:0.7,size:100}]}});await c.observer.tick();assert.equal(c.observer.snapshot().items[0].status,'skipped');
  c.setNow((round+301)*1000);c.setResult({status:'resolved',result:'UP'});c.observer.settle();const s=c.observer.snapshot().stats;assert.equal(s.correct,1);assert.equal(s.fills,0);assert.equal(s.pnl,0);
});
test('late asynchronous book cancels execution, paused observer still settles',async t=>{
  const c=fixture(t);c.engine.venue.books=async()=>{c.setNow((round+66)*1000);return {UP:{fetchedAt:(round+66)*1000,tickSize:0.01,minOrderSize:5,asks:[{price:0.49,size:100}]}};};await c.observer.tick();assert.match(c.observer.snapshot().items[0].reason,/执行窗口/);
  c.observer.configure({running:false});c.setResult({status:'resolved',result:'DOWN'});c.setNow((round+301)*1000);await c.observer.tick();assert.equal(c.observer.snapshot().items[0].correct,0);
});
test('observer settles from official API even when historical page has never loaded',async t=>{
  const c=fixture(t);await c.observer.tick();c.setNow((round+301)*1000);
  c.engine.venue.market=async()=>({conditionId:'official-c',outcomes:[{direction:'UP',index:1}]});
  c.engine.venue.resolution=async order=>{assert.equal(order.conditionId,'official-c');assert.equal(order.outcomeIndex,1);return {payout:0};};
  await c.observer.settle();assert.equal(c.observer.snapshot().items[0].status,'lost');assert.equal(c.observer.snapshot().items[0].pnl,-6);
});
