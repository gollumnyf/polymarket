import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BOLLINGER_DEFAULTS,bollingerBands,validateBollinger,visibleBollingerBands} from '../src/bollinger.mjs';
import {apiPath} from '../src/api.mjs';
import {BollingerStore,BollingerEngine,bollingerHistory} from '../server/bollinger-engine.mjs';
import {Store} from '../server/store.mjs';
import {RangeStore} from '../server/range-store.mjs';
import {PreviousDirectionEngine} from '../server/previous-direction-engine.mjs';
import {createApp} from '../server/index.mjs';

const point=(minute,price,oracleWindow=60)=>({time:minute*60000+1000,price,oracleWindow});
const config={...BOLLINGER_DEFAULTS,period:3};

test('Bollinger bands use candle closes and population standard deviation, including the developing candle',()=>{
  const prices=[point(0,50),point(0,100),point(1,102),point(2,104)];
  const bands=bollingerBands(prices,config);
  assert.equal(bands.length,1);assert.equal(bands[0].middle,102);
  assert.ok(Math.abs(bands[0].upper-(102+2*Math.sqrt(8/3)))<1e-10);
  assert.equal(bands[0].segment,true);
  assert.deepEqual(bollingerBands([...prices,{...point(2,110),time:121999}],config).map(x=>x.middle),[104]);
  assert.equal(bollingerBands(prices,config,prices[1].time).length,0);
  assert.equal(bollingerBands(prices,{...config,enabled:false}).length,0);
});

test('missing candles and oracle changes reset warmup, invalid points never synthesize prices',()=>{
  const prices=[point(0,100),point(1,100),point(2,100),point(4,100),point(5,100),point(6,100)];
  const bands=bollingerBands(prices,config);assert.equal(bands.length,2);assert.equal(bands[1].segment,true);
  assert.equal(bands[0].upper,100);assert.equal(bands[0].lower,100);
  assert.equal(bollingerBands([point(0,100),point(1,100),point(2,100,30)],config).length,0);
  assert.equal(bollingerBands([point(0,100),point(1,NaN),point(2,100)],config).length,0);
  assert.equal(bollingerBands([point(0,100),point(1,100),{time:121000,price:100}],config).length,0);
});

test('Bollinger configuration validates types, ranges and unknown keys',()=>{
  for(const input of [{period:'20'},{period:1},{period:201},{period:2.5},{deviations:NaN},{deviations:0},
    {deviations:11},{enabled:'false'},{intervalSeconds:5},{baseAmount:5},null,[]])assert.throws(()=>validateBollinger(input));
  assert.deepEqual(validateBollinger({period:50}),{...BOLLINGER_DEFAULTS,period:50});
  assert.equal(apiPath('paper/start','/bollinger'),'/bollinger/api/paper/start');
});

test('the viewport starts with the already known band instead of losing the opening candle',()=>{
  const prices=Array.from({length:25},(_,i)=>({time:i*60000+59000,price:59000+i,oracleWindow:60}));
  const bands=bollingerBands(prices,BOLLINGER_DEFAULTS),xmin=20*60000;
  const visible=visibleBollingerBands(bands,{xmin,visibleThrough:24*60000+59000,intervalSeconds:60});
  assert.equal(visible[0].time,xmin);
  assert.equal(visible[0].middle,bands[0].middle);
  assert.equal(visible[1].time,xmin+59000);
  assert.notEqual(visible[0].middle,visible[1].middle);
  assert.equal(bands[0].time,19*60000+59000);
  const scrolling=visibleBollingerBands(bands,{xmin:xmin+30000,visibleThrough:24*60000+59000,intervalSeconds:60});
  assert.equal(scrolling[0].time,xmin+30000);
  assert.equal(scrolling[0].middle,bands[0].middle);
});

test('viewport clipping does not fill warmup gaps, oracle resets or stale history, and does not borrow future points',()=>{
  const before={time:59000,middle:100,upper:101,lower:99,segment:true};
  const after={time:119000,middle:200,upper:201,lower:199,segment:false};
  const view={xmin:60000,visibleThrough:119000,intervalSeconds:60};
  assert.deepEqual(visibleBollingerBands([before,{...after,segment:true}],view),[{...after,segment:true}]);
  assert.deepEqual(visibleBollingerBands([before],{...view,xmin:180000,visibleThrough:240000}),[]);
  assert.deepEqual(visibleBollingerBands([after],view),[after]);
  const opening={...after,time:60000};
  assert.deepEqual(visibleBollingerBands([before,opening],view),[opening]);
  assert.deepEqual(visibleBollingerBands([before,after],{...view,visibleThrough:60001}),[{...before,time:60000,segment:true}]);
});

test('the clone copies initial parameters once while retaining independent funds, orders and persisted indicator settings',t=>{
  const sourceStore=new Store(':memory:');t.after(()=>sourceStore.close());
  const directory=mkdtempSync(join(tmpdir(),'pulse-bollinger-')),path=join(directory,'paper.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const source=sourceStore.account('paper'),sourceConfig={...source.config,baseAmount:5,maxAmount:41,maxPrice:.7};
  let store=new BollingerStore(path,{sourceConfig});
  const venue={readiness:()=>({enabled:false})};
  const engine=new BollingerEngine(store,venue,{previousMarketStore:sourceStore});
  assert.equal(store.account('paper').config.baseAmount,5);assert.equal(store.account('paper').balance,1000);
  assert.notEqual(store.account('paper').session,source.session);assert.equal(store.account('paper').running,false);
  assert.equal(engine.strategyVersion,'PR-001');assert.equal(engine.nextAmount({...store.account('paper'),losses:1}),10);
  sourceStore.saveHistoricalRound({round:1800000000,slug:'source',end:1800000300,status:'resolved',result:'UP'},Date.now());
  assert.equal(engine.marketResult(1800000000).direction,'UP');
  store.saveAccount({...store.account('paper'),running:true,balance:900});
  engine.configureBollinger({period:30,deviations:2.5});
  store.saveBollingerHistoryPrice({oracleWindow:60,time:1800000059000,price:59000,observedAt:1800000060000});
  assert.equal(engine.snapshot().bollinger.period,30);assert.equal(sourceStore.account('paper').balance,1000);
  assert.throws(()=>engine.configure('live',sourceConfig));
  store.close();
  store=new BollingerStore(path,{sourceConfig:{...sourceConfig,baseAmount:50}});
  try{
    assert.equal(store.account('paper').balance,900);assert.equal(store.account('paper').config.baseAmount,5);
    assert.equal(store.account('paper').running,false);assert.equal(store.bollingerSettings().period,30);
    assert.equal(store.bollingerSettings().deviations,2.5);
    assert.equal(store.bollingerHistoryPrices(60,1800000000000,1800000060000)[0].price,59000);
  }finally{store.close();}
});

test('warmup history reads the latest close per interval, isolates oracle windows and excludes future data',t=>{
  const store=new RangeStore(':memory:');t.after(()=>store.close());
  for(const tick of [point(0,100),{...point(0,101),time:59000},point(1,102),point(2,900,30),point(3,200)])
    store.tick(tick.time,tick.price,'polymarket',tick.oracleWindow);
  const history=bollingerHistory(store,config,60,130000);
  assert.deepEqual(history.points.map(p=>p.price),[101,102]);
  assert.equal(history.oracleWindow,60);
});

test('clone APIs isolate reports and control tokens, support chart settings while running, and defer history during entry',async t=>{
  const sourceStore=new Store(':memory:'),store=new BollingerStore(':memory:');
  const source=new PreviousDirectionEngine(sourceStore,{readiness:()=>({enabled:false})});
  const engine=new BollingerEngine(store,{readiness:()=>({enabled:false})});
  let background=false;engine.canRunBackground=()=>background;
  const server=createApp(source,{previousEngine:source,bollingerEngine:engine,allowedModes:['paper']}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();sourceStore.close();store.close();});
  const origin='http://127.0.0.1:'+server.address().port,base=origin+'/bollinger';
  const s=await fetch(base+'/api/state').then(r=>r.json());
  const sourceState=await fetch(origin+'/api/state').then(r=>r.json());
  const post=(body,token=s.controlToken)=>fetch(base+'/api/bollinger-settings',{method:'POST',
    headers:{Origin:origin,'Content-Type':'application/json','X-Control-Token':token},body:JSON.stringify(body)});
  assert.equal((await post({period:30},sourceState.controlToken)).status,403);
  store.saveAccount({...store.account('paper'),running:true});
  assert.equal((await post({period:30})).status,200);assert.equal(store.bollingerSettings().period,30);
  assert.equal((await post({period:1})).status,400);
  assert.equal((await fetch(base+'/api/bollinger-history')).status,202);
  background=true;const data=await fetch(base+'/api/bollinger-history').then(r=>r.json());
  assert.deepEqual(data.points,[]);
  assert.equal((await fetch(base+'/api/live/report')).status,400);
  const report=await fetch(base+'/api/paper/report').then(r=>r.json());assert.equal(report.summary.orderCount,0);
  assert.equal(sourceStore.account('paper').running,false);
});
