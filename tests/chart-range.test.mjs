import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartRange} from '../server/chart-range.mjs';
import {RangeStore} from '../server/range-store.mjs';

const start=1800000000;
test('shared chart levels keep one matching previous range until current levels are ready',()=>{
  let now=start*1000,calculations=0;
  let lower=71000,upper=72000;
  const source={spot:{round:start,windowSeconds:60},store:{
    chartSettings:()=>({levelLookbackMinutes:60,middlePercent:60}),
    rangeConfig:()=>({levelLagMinutes:15,edgePercent:20}),
    rangeBars:()=>{calculations++;return [];},
    marketPrices:(_window,from,to)=>Array.from({length:(to-from)/300},(_,i)=>({round:from+i*300,open:lower,close:upper})),
  }};
  const feed={round:start,spec:{seconds:60}};
  const range=new ChartRange(source,feed,{now:()=>now});
  const paper=[],live=[];
  range.on('range',value=>paper.push(value));range.on('range',value=>live.push(value));
  range.poll(true);range.poll(true);
  assert.equal(calculations,1);
  assert.equal(range.current().zone.lower,71000);
  now+=300000;range.poll(false);
  assert.equal(range.current().zone.fallbackFrom,start);
  assert.equal(calculations,1);
  feed.round=start+300;feed.spec={seconds:30};range.poll(false);
  assert.equal(range.current().zone,null);
  feed.spec={seconds:60};source.spot={round:start+300,windowSeconds:60};
  lower=71500;upper=72500;
  range.poll(false);
  assert.equal(range.current().zone.fallbackFrom,start);
  range.poll(true);
  assert.deepEqual(range.current(),{round:start+300,zone:{lower:71500,upper:72500,edgePercent:20,phase:'reference'}});
  assert.deepEqual(paper,live);
  now+=600000;range.poll(false);
  assert.equal(range.current().zone,null);
});

test('shared level setting uses 60 minutes by default and recalculates a 15-minute window without changing legacy config',t=>{
  const store=new RangeStore(':memory:');t.after(()=>store.close());
  const now=start*1000,lag=store.rangeConfig().levelLagMinutes;
  const end=start-lag*60;
  for(let i=1;i<=12;i++)store.marketRound(end-i*300,70000-i*10,71000+i*10,60,now);
  const range=new ChartRange({store,spot:{round:start,windowSeconds:60}},{round:start,spec:{seconds:60}},{now:()=>now});
  assert.deepEqual({...range.settings()},{levelLookbackMinutes:60,middlePercent:60});
  range.poll(true);
  assert.equal(range.current().zone.upper,71120);
  for(const value of [14,16,'15',1445])assert.throws(()=>range.configure({levelLookbackMinutes:value}));
  range.configure({levelLookbackMinutes:15});
  assert.equal(range.current().zone,null);
  range.poll(false);
  assert.equal(range.current().zone,null);
  range.poll(true);
  assert.equal(range.current().zone.upper,71030);
  assert.equal(range.current().zone.lower,69970);
  const events=[];range.on('range',value=>events.push(value));
  range.configure({middlePercent:80});
  range.poll(false);
  assert.equal(events.at(-1).zone.edgePercent,10);
  assert.equal(range.current().zone.upper,71030);
  assert.equal(range.settings().levelLookbackMinutes,15);
  for(const value of [0,-1,101,'60',null])assert.throws(()=>range.configure({middlePercent:value}));
  assert.equal(range.settings().middlePercent,80);
  assert.equal(store.rangeConfig().edgePercent,20);
  assert.equal(store.rangeConfig().levelLookbackHours,4);
  assert.equal(new ChartRange({store},{},{now:()=>now}).settings().levelLookbackMinutes,15);
});
