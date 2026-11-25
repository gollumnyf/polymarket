import test from 'node:test';
import assert from 'node:assert/strict';
import {BollingerStore} from '../server/bollinger-engine.mjs';
import {BollingerHistoryRepair} from '../server/bollinger-history.mjs';
import {RangeStore} from '../server/range-store.mjs';
import {BOLLINGER_DEFAULTS,bollingerBands} from '../src/bollinger.mjs';

function fixture(t,fetch){
  let now=1800000123456,background=true;
  const store=new BollingerStore(':memory:'),marketStore=new RangeStore(':memory:');
  t.after(()=>{store.close();marketStore.close();});
  const repair=new BollingerHistoryRepair({store,marketStore,venue:{fetch},now:()=>now,canRunBackground:()=>background});
  return {store,marketStore,repair,now:()=>now,advance:ms=>{now+=ms;},background:value=>{background=value;}};
}

test('missing history is fetched at real closing-second timestamps, persisted and reused across reads',async t=>{
  const calls=[];
  const f=fixture(t,async url=>{
    calls.push(url);const query=new URL(url).searchParams;
    assert.equal(query.get('symbol'),'BTC');assert.equal(query.get('twapEnabled'),'true');
    assert.equal(query.get('twapLookbackSeconds'),'60');
    const at=Date.parse(query.get('eventStartTime'));
    assert.equal(at%60000,59000);assert.ok(at<f.now());
    return {ok:true,json:async()=>({openPrice:59000+at%1000,closePrice:null,incomplete:true})};
  });
  const config=BOLLINGER_DEFAULTS,before=f.repair.read(config,60);
  assert.ok(before.repair.missing>=config.period+30);
  await f.repair.task;
  const after=f.repair.read(config,60);
  assert.equal(after.repair.state,'ready');assert.equal(after.repair.missing,0);
  assert.equal(after.points.length,before.repair.expected);assert.equal(calls.length,before.repair.expected);
  assert.ok(bollingerBands(after.points,config,f.now()).length>0);
  assert.ok(after.points.every(p=>p.source==='polymarket_crypto_price'));
  f.repair.read(config,60);assert.equal(calls.length,before.repair.expected);
  const next=new BollingerHistoryRepair({store:f.store,marketStore:f.marketStore,venue:{fetch:()=>{throw Error('must use persisted prices');}},now:f.now});
  assert.equal(next.read(config,60).repair.missing,0);
});

test('local candles win and the requested period and timeframe expand the repair range',async t=>{
  const f=fixture(t,async()=>({ok:true,json:async()=>({openPrice:59000})}));
  const end=Math.floor(f.now()/60000)*60000;
  f.marketStore.tick(end-2000,60000,'polymarket',60);
  f.store.saveBollingerHistoryPrice({oracleWindow:60,time:end-1000,price:1,observedAt:f.now()});
  let result=f.repair.read(BOLLINGER_DEFAULTS,60);await f.repair.task;
  assert.equal(result.points.at(-1).price,60000);
  result=f.repair.read({...BOLLINGER_DEFAULTS,period:200,intervalSeconds:300},60);
  assert.ok(result.repair.expected>=206);assert.ok(result.repair.missing>0);
  await f.repair.task;
  assert.equal(f.repair.read({...BOLLINGER_DEFAULTS,period:200,intervalSeconds:300},60).repair.missing,0);
  // A closing snapshot for a shorter interval must not masquerade as a longer candle close.
  f.background(false);
  f.store.saveBollingerHistoryPrice({oracleWindow:30,time:end-46000,price:59000,observedAt:f.now()});
  result=f.repair.read(BOLLINGER_DEFAULTS,30);
  assert.equal(result.repair.available,0);
});

test('background concurrency is two, duplicate reads coalesce, and opening protection stops new requests',async t=>{
  const pending=[],calls=[];
  const f=fixture(t,url=>new Promise(resolve=>{calls.push(url);pending.push(resolve);}));
  f.repair.read(BOLLINGER_DEFAULTS,60);
  await Promise.resolve();
  assert.equal(calls.length,2);
  f.repair.read(BOLLINGER_DEFAULTS,60);assert.equal(calls.length,2);
  f.background(false);
  for(const resolve of pending)resolve({ok:true,json:async()=>({openPrice:59000})});
  await f.repair.task;
  assert.equal(calls.length,2);
  const state=f.repair.read(BOLLINGER_DEFAULTS,60);
  assert.equal(state.repair.state,'waiting_for_opening');assert.equal(calls.length,2);
  assert.equal(state.repair.available,2);
});

test('failed and null responses stay missing and automatically retry without saving fake prices',async t=>{
  let attempt=0;
  const f=fixture(t,async()=>++attempt===1?{ok:false,status:429}:attempt===2?
    {ok:true,json:async()=>({openPrice:null})}:{ok:true,json:async()=>({openPrice:'59123.5'})});
  const interval=60000,end=Math.floor(f.now()/interval)*interval;
  const start=Math.floor((f.now()-(20*interval+31*60000))/interval)*interval;
  for(let bucket=start;bucket<end-interval;bucket+=interval)f.marketStore.tick(bucket+1000,59000,'polymarket',60);
  f.repair.read(BOLLINGER_DEFAULTS,60);await f.repair.task;
  assert.equal(attempt,1);assert.equal(f.store.bollingerHistoryPrices(60,start,f.now()).length,0);
  assert.equal(f.repair.read(BOLLINGER_DEFAULTS,60).repair.state,'retrying');await f.repair.task;
  assert.equal(attempt,1);
  f.advance(1000);f.repair.poll();await f.repair.task;
  assert.equal(attempt,2);assert.equal(f.store.bollingerHistoryPrices(60,start,f.now()).length,0);
  f.advance(2000);f.repair.poll();await f.repair.task;
  assert.equal(attempt,3);assert.equal(f.repair.read(BOLLINGER_DEFAULTS,60).repair.missing,0);
});
