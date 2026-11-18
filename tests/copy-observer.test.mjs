import test from 'node:test';
import assert from 'node:assert/strict';
import {CopyObserver,COPY_WALLET} from '../server/copy-observer.mjs';
import {createApp} from '../server/index.mjs';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';

const round=1800000000;
function fixture(t){
  let now=(round+280)*1000,calls=0;
  const book={fetchedAt:now,tickSize:0.01,minOrderSize:5,asks:[{price:0.99,size:100}],bids:[]};
  const venue={market:async()=>({active:true,conditionId:'c',outcomes:[{direction:'UP',assetId:'token'}],feeSchedule:{rate:0.07,exponent:1}}),books:async()=>{calls++;return {UP:book};},resolution:async()=>({payout:1}),buy:()=>{throw Error('must never submit');}};
  const observer=new CopyObserver(':memory:',venue,{now:()=>now});observer.since=round;
  const trade={proxy_wallet:COPY_WALLET,slug:'btc-updown-5m-'+round,side:'BUY',outcome:'Up',outcome_index:0,price:0.99,size:100,timestamp:round+278,condition_id:'c',token_id:'token',transaction_hash:'tx'};
  t.after(()=>observer.close());return {observer,venue,book,trade,setNow:n=>now=n,calls:()=>calls};
}
test('copy uses discovered book and fees; dedupes fills and aggregates split buys once per market',async t=>{
  const c=fixture(t);await c.observer.observe(c.trade);await c.observer.observe(c.trade);await c.observer.observe({...c.trade,size:20,transaction_hash:'split'});
  const s=c.observer.snapshot();assert.equal(s.total,1);assert.equal(s.items[0].fill_count,2);assert.equal(s.items[0].leader_shares,120);assert.equal(s.items[0].status,'filled');assert(s.items[0].fee>0);assert.equal(c.calls(),1);
  c.setNow((round+301)*1000);await c.observer.settle();assert(c.observer.snapshot().stats.pnl>0);const pnl=c.observer.snapshot().stats.pnl;await c.observer.settle();assert.equal(c.observer.snapshot().stats.pnl,pnl);
});
test('copy skips stale, ended, wrong asset family and opposite price above cap',async t=>{
  const c=fixture(t);await c.observer.observe({...c.trade,slug:'sol-updown-5m-'+round});assert.equal(c.observer.snapshot().total,0);
  await c.observer.observe({...c.trade,timestamp:round+260});assert.match(c.observer.snapshot().items[0].reason,/超过/);assert.equal(c.calls(),0);
  const d=fixture(t);d.book.tickSize=0.001;d.book.asks[0].price=0.995;await d.observer.observe(d.trade);assert.equal(d.observer.snapshot().items[0].status,'missed');assert.equal(d.observer.db.prepare('SELECT COUNT(*) n FROM copy_depth').get().n,1);
  const e=fixture(t);e.setNow((round+301)*1000);await e.observer.observe(e.trade);assert.match(e.observer.snapshot().items[0].reason,/已经结束/);
});
test('copy rechecks end and pause after asynchronous book reads',async t=>{
  const c=fixture(t);c.venue.books=async()=>{c.setNow((round+301)*1000);return {UP:{...c.book,fetchedAt:(round+301)*1000}};};await c.observer.observe(c.trade);assert.equal(c.observer.snapshot().items[0].status,'missed');
  const d=fixture(t);d.venue.books=async()=>{d.observer.configure({running:false});return {UP:d.book};};await d.observer.observe(d.trade);assert.match(d.observer.snapshot().items[0].reason,/暂停/);
});
test('copy poll includes maker rows, persists once, retries errors and never replays prior startup trades',async t=>{
  const c=fixture(t);let url;
  c.observer.fetch=async u=>{url=u;return {ok:true,json:async()=>({data:[c.trade],pagination:{next_cursor:null}})};};await c.observer.poll();assert.match(url,/taker_only=false/);await c.observer.poll();assert.equal(c.observer.snapshot().items[0].fill_count,1);
  c.observer.fetch=async()=>{throw Error('offline');};await c.observer.tick();assert.match(c.observer.error,/offline/);assert.equal(c.observer.config().running,1);
  const d=fixture(t);d.observer.since=round+280;await d.observer.observe(d.trade);assert.equal(d.observer.snapshot().total,0);
  assert.throws(()=>d.observer.configure({max_price:1}));assert.throws(()=>d.observer.configure({wallet:'other'}));
});
test('copy config endpoint requires local control token and origin',async t=>{
  const c=fixture(t),store=new Store(':memory:'),engine=new Engine(store,{});
  const server=createApp(engine,{copyObserver:c.observer}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const base='http://127.0.0.1:'+server.address().port,s=await(await fetch(base+'/api/copy/state')).json();
  assert.equal((await fetch(base+'/api/copy/config',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"running":false}'})).status,403);
  assert.equal((await fetch(base+'/api/copy/config',{method:'POST',headers:{'Content-Type':'application/json','Origin':base,'X-Control-Token':s.controlToken},body:'{"running":false}'})).status,200);assert.equal(c.observer.config().running,0);
});
