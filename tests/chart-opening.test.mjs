import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartOpening} from '../server/chart-opening.mjs';

const start=1800000000;
const rows=(round,price)=>{const slug='btc-updown-5m-'+round;return [{slug,eventMetadata:{priceToBeat:price},markets:[{slug,cryptoMarketConfig:{asset:'btc',twapEnabled:true,twapLookbackSeconds:60}}]}];};
const response=items=>({ok:true,json:async()=>items});

test('chart target retries unpublished official data and shares a single request between subscribers',async()=>{
  let now=start*1000,calls=0;
  const chart=new ChartOpening({now:()=>now,fetchImpl:async()=>response(++calls===1?[]:rows(start,68000))});
  const events=[];chart.on('opening',value=>events.push(value));chart.on('opening',value=>events.push(value));
  const first=chart.poll();assert.equal(chart.poll(),first);await first;
  assert.equal(chart.current(),null);assert.equal(chart.poll(),null);
  now+=2500;await chart.poll();
  assert.deepEqual(chart.current(),{round:start,price:68000});assert.equal(events.length,2);
  assert.equal(chart.poll(),null);assert.equal(calls,2);
});

test('a late previous-round response never draws the new round target',async()=>{
  let now=start*1000,release;
  const chart=new ChartOpening({now:()=>now,fetchImpl:()=>new Promise(resolve=>{release=resolve;})});
  const first=chart.poll();
  await Promise.resolve();now+=300000;release(response(rows(start,68000)));await first;
  assert.equal(chart.current(),null);
});

test('uses the official crypto-price opening when Gamma has no priceToBeat',async()=>{
  const event=rows(start,null);
  event[0].markets[0].cryptoMarketConfig={asset:'btc',twapEnabled:true,twapLookbackSeconds:60};
  const calls=[];
  const chart=new ChartOpening({now:()=>start*1000,fetchImpl:async url=>{
    calls.push(new URL(url));
    return response(calls.length===1?event:{openPrice:68123,closePrice:70000});
  }});
  await chart.poll();
  assert.deepEqual(chart.current(),{round:start,price:68123});
  assert.equal(calls[1].searchParams.get('twapLookbackSeconds'),'60');
  assert.equal(calls[1].searchParams.get('eventStartTime'),new Date(start*1000).toISOString());
});

test('rechecks Gamma when crypto-price had no opening, without waiting on the slow fallback',async()=>{
  let now=start*1000,gammaCalls=0,cryptoCalls=0;
  let release;
  const late=new Promise(resolve=>{release=resolve;});
  const chart=new ChartOpening({now:()=>now,fetchImpl:async url=>{
    if(String(url).includes('gamma-api'))return response(rows(start,++gammaCalls===1?null:68000));
    return ++cryptoCalls===1?response({}):late;
  }});
  await chart.poll();
  assert.equal(chart.current(),null);
  now+=3000;
  await chart.poll();
  assert.deepEqual(chart.current(),{round:start,price:68000});
  release(response({openPrice:69000}));
});

test('a missing official target never hides received quotes beyond two seconds after rollover',async()=>{
  const {holdChartForOpening,chartTimeWindow}=await import('../src/chart-prices.mjs');
  const view={start,range:'round',now:start*1000+1000};
  assert.equal(holdChartForOpening(view),true);
  assert.equal(holdChartForOpening({...view,reference:68000}),false);
  assert.equal(holdChartForOpening({...view,range:'30m'}),false);
  view.now=start*1000+2000;
  assert.equal(holdChartForOpening(view),false);
  const ticks=[{time:start*1000-1},{time:start*1000},{time:start*1000+1000}];
  const bounds=chartTimeWindow(ticks,view);
  assert.deepEqual(ticks.filter(p=>p.time>=bounds.xmin&&p.time<=bounds.visibleThrough),ticks.slice(1));
});

test('target uses only the exact opening tick provisionally and switches to the current official value',async()=>{
  const {chartOpeningReference}=await import('../src/chart-prices.mjs');
  const time=start*1000;
  const boundary={time,price:61924.98,oracleWindow:60};
  const next={time:time+1000,price:61917.54,oracleWindow:60};
  assert.equal(chartOpeningReference([next],null,start),null);
  assert.equal(chartOpeningReference([boundary,{...next,oracleWindow:30}],null,start),null);
  assert.deepEqual(chartOpeningReference([boundary,next],{round:start-300,price:70000},start),{price:61924.98,provisional:true});
  assert.deepEqual(chartOpeningReference([boundary,next],{round:start,price:61925},start),{price:61925,provisional:false});
});

test('a confirmed opening picked up from another local consumer wins over pending HTTP',async()=>{
  let release;
  const chart=new ChartOpening({now:()=>start*1000,fetchImpl:()=>new Promise(resolve=>{release=resolve;})});
  const pending=chart.poll();
  await Promise.resolve();
  chart.publish(start-300,69000);
  assert.equal(chart.current(),null);
  chart.publish(start,68000);
  release(response(rows(start,68100)));
  await pending;
  assert.deepEqual(chart.current(),{round:start,price:68000});
});
