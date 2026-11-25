import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {RangeStore} from '../server/range-store.mjs';
import {RangeEngine} from '../server/range-engine.mjs';
import {PreviousDirectionEngine} from '../server/previous-direction-engine.mjs';
import {LevelLimitedStore,LevelLimitedEngine,independentLevelRange} from '../server/level-limited-engine.mjs';
import {ChartRange} from '../server/chart-range.mjs';
import {createApp} from '../server/index.mjs';
import {apiPath} from '../src/api.mjs';

const start=1800000000;
function fixture(t){
  let now=start*1000+1000,point={time:now,price:100};
  const sourceStore=new Store(':memory:'),shared=new RangeStore(':memory:');
  const feed={round:start,spec:{seconds:60},recent:()=>[point]};
  const venue={priceFeed:feed,readiness:()=>({enabled:false})};
  const source=new PreviousDirectionEngine(sourceStore,venue,{now:()=>now});
  const store=new LevelLimitedStore(':memory:',{sourceConfig:sourceStore.account('paper').config});
  const levels=independentLevelRange(store,shared,feed,{now:()=>now});
  const engine=new LevelLimitedEngine(store,venue,{levels,marketStore:shared,previousMarketStore:sourceStore,now:()=>now});
  for(let i=1;i<=12;i++)shared.marketRound(start-900-i*300,90,110,60,now);
  for(let i=1;i<=41;i++)sourceStore.saveHistoricalRound({round:start-i*300,end:start-(i-1)*300,slug:'s'+i,status:'resolved',result:i%2?'UP':'DOWN'},now);
  engine.market={round:start,active:true,fetchedAt:now,conditionId:'c',feeSchedule:{rate:0,exponent:1},
    outcomes:[{direction:'UP',assetId:'u',index:0},{direction:'DOWN',assetId:'d',index:1}]};
  engine.books={DOWN:{fetchedAt:now,tickSize:.01,minOrderSize:5,asks:[{price:.5,size:1000}],bids:[]}};
  t.after(()=>{store.close();sourceStore.close();shared.close();});
  return {engine,source,store,sourceStore,shared,feed,levels,venue,now:()=>now,
    setPrice:price=>{point={time:now,price};},setPoint:value=>{point=value;},setNow:value=>{now=value;}};
}

for(const [price,code,inside] of [[89,'BELOW_SUPPORT',90],[111,'ABOVE_RESISTANCE',110]])
test(`${code} blocks entry and the exact boundary allows a later entry without changing the source`,async t=>{
  const f=fixture(t);f.setPrice(price);
  await f.engine.start('paper');await f.engine.attempt('paper');
  assert.equal(f.store.orderCount('paper'),0);assert.equal(f.store.account('paper').losses,0);
  assert.equal(f.store.account('paper').running,true);assert.equal(f.store.entryBlock('paper',start).code,code);
  assert.ok(f.store.entryBlock('paper',start).message.includes(price+'.000000'));
  f.source.market=f.engine.market;f.source.books=f.engine.books;
  await f.source.start('paper');await f.source.attempt('paper');assert.equal(f.sourceStore.orderCount('paper'),1);
  f.setPrice(inside);await f.engine.attempt('paper');await f.engine.attempt('paper');
  const order=f.store.orderForRound('paper',start);assert.equal(f.store.orderCount('paper'),1);
  assert.equal(order.direction,'DOWN');assert.equal(order.budget,10);assert.equal(order.strategyVersion,'LP-001');
  assert.match(order.entryReason,/完整支撑压力区间内/);
  const evidence=f.store.db.prepare('SELECT * FROM level_limit_order_signals WHERE order_id=?').get(order.id);
  assert.equal(evidence.lower_price,90);assert.equal(evidence.upper_price,110);assert.equal(evidence.observed_price,inside);
  f.store.saveOrder({id:order.id,status:'won',payout:20,pnl:10});f.store.clearPaperOrders();
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM level_limit_order_signals').get().n,0);
  assert.equal(f.store.hasRound('paper',start),true);
});

test('the full interval outside the blue middle is tradable, and the last pre-reservation check catches a new break',async t=>{
  const f=fixture(t);f.setPrice(91);
  assert.equal(f.engine.levelCheck().allowed,true);
  const original=f.engine.quote.bind(f.engine);f.engine.quote=(...args)=>{const quote=original(...args);f.setPrice(111);return quote;};
  await f.engine.start('paper');await f.engine.attempt('paper');
  assert.equal(f.store.orderCount('paper'),0);assert.equal(f.store.entryBlock('paper',start).code,'ABOVE_RESISTANCE');
  f.engine.quote=original;f.setPrice(91);await f.engine.attempt('paper');
  assert.equal(f.store.orderCount('paper'),1);
});

test('missing and stale quotes, missing levels, changed oracle windows and original cooldown remain entry guards',t=>{
  const f=fixture(t);
  f.setPoint({time:start*1000-1,price:100});assert.equal(f.engine.levelCheck().code,'LEVEL_PRICE_BEFORE_OPEN');
  f.setPoint({time:f.now()+2001,price:100});assert.equal(f.engine.levelCheck().code,'LEVEL_PRICE_FUTURE');
  f.setPoint({time:f.now(),price:NaN});assert.equal(f.engine.levelCheck().code,'LEVEL_PRICE_MISSING');
  f.setNow(start*1000+10000);f.setPoint({time:start*1000+1000,price:100});assert.equal(f.engine.levelCheck().code,'LEVEL_PRICE_STALE');
  f.setPrice(100);assert.equal(f.engine.levelCheck().allowed,true);
  f.feed.spec.seconds=30;assert.equal(f.engine.levelCheck().code,'LEVELS_NOT_READY');
  f.feed.round=start-300;assert.equal(f.engine.levelCheck().code,'LEVEL_PRICE_ROUND_MISSING');
  f.feed.round=start;f.feed.spec.seconds=60;
  f.sourceStore.saveHistoricalRound({round:start-600,end:start-300,slug:'s2',status:'resolved',result:'UP'},f.now());
  f.sourceStore.saveHistoricalRound({round:start-900,end:start-600,slug:'s3',status:'resolved',result:'DOWN'},f.now());
  assert.equal(f.engine.signal(start).code,'PREVIOUS_REVERSE_COOLDOWN');
  assert.equal(f.engine.nextAmount({...f.store.account('paper'),losses:1}),20);
  assert.equal(f.engine.nextAmount(f.engine.resetStakeCycle({...f.store.account('paper'),losses:7})),10);
});

test('clone configuration and level settings are independent and survive restart without recopying funds',t=>{
  const directory=mkdtempSync(join(tmpdir(),'pulse-limited-')),path=join(directory,'paper.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let store=new LevelLimitedStore(path);
  const account=store.account('paper');store.saveAccount({...account,balance:900,config:{...account.config,baseAmount:5}});
  store.saveChartSettings({levelLookbackMinutes:120});
  for(const input of [{levelLookbackMinutes:14},{levelLookbackMinutes:'60'},{middlePercent:0},{levelLagMinutes:0}])assert.throws(()=>store.saveChartSettings(input));
  store.close();store=new LevelLimitedStore(path,{sourceConfig:{...account.config,baseAmount:50}});
  try{assert.equal(store.account('paper').balance,900);assert.equal(store.account('paper').config.baseAmount,5);
    assert.equal(store.chartSettings().levelLookbackMinutes,120);assert.equal(store.levelLagMinutes(),15);
  }finally{store.close();}
});

test('isolated API settings, chart range, reports and control tokens never change other accounts',async t=>{
  const f=fixture(t);
  const chartRange=new ChartRange({store:f.shared,spot:{round:start,windowSeconds:60}},f.feed,{now:f.now});
  const server=createApp(f.source,{previousEngine:f.source,levelLimitedEngine:f.engine,allowedModes:['paper'],chart:{feed:f.feed,range:chartRange,store:f.shared}}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const origin='http://127.0.0.1:'+server.address().port,base=origin+'/level-limited';
  const state=await fetch(base+'/api/state').then(r=>r.json()),source=await fetch(origin+'/api/state').then(r=>r.json());
  const post=(path,body,token=state.controlToken)=>fetch(base+'/api/'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Control-Token':token},body:JSON.stringify(body)});
  assert.equal((await post('chart-settings',{levelLookbackMinutes:15},source.controlToken)).status,403);
  assert.equal((await post('chart-settings',{levelLookbackMinutes:15})).status,200);
  assert.equal(f.store.chartSettings().levelLookbackMinutes,15);assert.equal(f.shared.chartSettings().levelLookbackMinutes,60);
  assert.equal((await post('paper/config',{...state.accounts.paper.config,baseAmount:5,minPrice:.45,maxPrice:.65})).status,200);
  assert.equal(f.store.account('paper').config.baseAmount,5);assert.equal(f.sourceStore.account('paper').config.baseAmount,10);
  await f.engine.start('paper');assert.equal((await post('chart-settings',{middlePercent:70})).status,400);
  assert.equal((await fetch(base+'/api/live/report')).status,400);
  assert.equal((await fetch(base+'/api/paper/report')).status,200);
  assert.equal(apiPath('paper/start','/level-limited'),'/level-limited/api/paper/start');
  await assert.rejects(f.engine.start('live'));
});

test('a longer independent lookback extends the shared low priority historical repair range',async t=>{
  const store=new RangeStore(':memory:');t.after(()=>store.close());
  const requested=[];
  const venue={readiness:()=>({enabled:false}),fetch:async url=>{
    const query=new URL(url).searchParams;requested.push(Date.parse(query.get('eventStartTime'))/1000);
    return {ok:true,json:async()=>({openPrice:90,closePrice:110})};
  }};
  const engine=new RangeEngine(store,venue,{now:()=>start*1000+1000});engine.spot={windowSeconds:60};
  engine.extraLevelHistoryStart=()=>start-6*3600;
  await engine.backfillMarketHistory();
  assert.equal(Math.min(...requested),start-6*3600);assert.equal(requested.length,72);
  assert.equal(store.rangeConfig().levelLookbackHours,4);
});

test('paused chart work defers during opening protection while active entry can compute its local dependency',async t=>{
  const f=fixture(t);f.engine.canRunBackground=()=>false;
  assert.equal(f.engine.levelCheck().code,'LEVELS_NOT_READY');
  assert.equal(f.levels.ready,null);
  await f.engine.start('paper');await f.engine.attempt('paper');
  assert.equal(f.store.orderCount('paper'),1);
});

test('opening oracle activation is an entry dependency even without charts or background spot refresh',async t=>{
  const f=fixture(t);f.feed.round=start-300;f.engine.canRunBackground=()=>false;
  f.engine.spot={round:start-300,windowSeconds:60,price:100,at:(start-1)*1000};
  f.engine.pollSpot=()=>assert.fail('display spot must stay deferred');
  f.engine.pollPredictions=()=>assert.fail('old forecasts must stay deferred');
  f.engine.history.poll=()=>assert.fail('history must stay deferred');
  let release,oracleCalls=0,markets=0;
  f.venue.preparePriceFeed=async(round,isCurrent)=>{
    oracleCalls++;assert.equal(round,start);await new Promise(resolve=>{release=resolve;});
    if(isCurrent())f.feed.round=round;return f.feed.spec;
  };
  f.venue.market=async()=>{markets++;return f.engine.market;};f.venue.books=async()=>f.engine.books;
  await f.engine.start('paper');const tick=f.engine.tick();await Promise.resolve();
  assert.equal(oracleCalls,1);assert.equal(markets,1);assert.equal(f.store.orderCount('paper'),0);
  release();await tick;
  const order=f.store.orderForRound('paper',start);
  assert.equal(f.store.orderCount('paper'),1);assert.equal(order.direction,'DOWN');
  assert.equal(order.createdAt,start*1000+1000);assert.equal(order.oracleWindow,60);
  assert.equal(f.engine.spot.round,start-300);
  await f.engine.tick();assert.equal(oracleCalls,1);assert.equal(f.store.orderCount('paper'),1);
});

test('oracle lookup failure records the exact cause, and retry still enforces the interval',async t=>{
  const f=fixture(t);f.feed.round=start-300;f.engine.canRunBackground=()=>false;
  f.venue.market=async()=>f.engine.market;f.venue.books=async()=>f.engine.books;
  f.venue.preparePriceFeed=async()=>{throw Error('Gamma oracle TIMEOUT');};
  await f.engine.start('paper');await f.engine.tick();
  assert.equal(f.store.orderCount('paper'),0);assert.equal(f.engine.busy,false);
  assert.equal(f.store.entryBlock('paper',start).code,'LEVEL_PRICE_ROUND_MISSING');
  assert.match(f.store.entryBlock('paper',start).message,/Gamma oracle TIMEOUT/);
  f.venue.preparePriceFeed=async round=>{f.feed.round=round;return f.feed.spec;};
  f.setPrice(111);await f.engine.tick();assert.equal(f.store.orderCount('paper'),0);
  assert.equal(f.store.entryBlock('paper',start).code,'ABOVE_RESISTANCE');
  f.setPrice(100);await f.engine.tick();assert.equal(f.store.orderCount('paper'),1);
});
