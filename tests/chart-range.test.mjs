import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartRange} from '../server/chart-range.mjs';

const start=1800000000;
test('shared chart levels keep one matching previous range until current levels are ready',()=>{
  let now=start*1000,calculations=0;
  let candidate={lower:71000,upper:72000,levelAnalysis:{ready:true}};
  const source={spot:{round:start,windowSeconds:60},analysis:()=>{
    calculations++;return {candidate,config:{edgePercent:20}};
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
  candidate={lower:71500,upper:72500,levelAnalysis:{ready:true}};
  range.poll(false);
  assert.equal(range.current().zone.fallbackFrom,start);
  range.poll(true);
  assert.deepEqual(range.current(),{round:start+300,zone:{lower:71500,upper:72500,edgePercent:20,phase:'reference'}});
  assert.deepEqual(paper,live);
  now+=600000;range.poll(false);
  assert.equal(range.current().zone,null);
});
