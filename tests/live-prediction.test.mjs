import test from 'node:test';
import assert from 'node:assert/strict';
import {liveOrderPrediction} from '../src/live-prediction.mjs';

const round=1800000000,now=(round+20)*1000;
const order=Object.freeze({id:'current',round,end:round+300,status:'open',direction:'UP',conditionId:'c',oracleWindow:60,referencePrice:90});
const spot=Object.freeze({round,sourceId:'polymarket',conditionId:'c',windowSeconds:60,currentOpen:100,price:101,at:now-1000});
const context={spot,now,connected:true};

test('an ongoing order predicts from this round opening and latest official price, and flips with the price',()=>{
  const win=liveOrderPrediction(order,context);
  assert.equal(win.outcome,'UP');assert.equal(win.won,true);assert.equal(win.open,100);assert.equal(win.close,101);
  assert.equal(win.source,'polymarket_realtime');assert.equal(win.priceAt,spot.at);
  const loss=liveOrderPrediction(order,{...context,spot:{...spot,price:99}});
  assert.equal(loss.outcome,'DOWN');assert.equal(loss.won,false);
  assert.equal(liveOrderPrediction({...order,direction:'DOWN'},{...context,spot:{...spot,price:99}}).won,true);
  assert.equal(order.prediction,undefined);assert.equal(spot.price,101);
});

test('an equal price predicts UP consistently with completed-round price forecasts',()=>{
  const prediction=liveOrderPrediction(order,{...context,spot:{...spot,price:100}});
  assert.equal(prediction.outcome,'UP');assert.equal(prediction.won,true);
});

for(const [label,patch] of [
  ['disconnected',{connected:false}],['source error',{spotError:'offline'}],
  ['another exchange',{spot:{...spot,sourceId:'binance'}}],
  ['previous round',{spot:{...spot,round:round-300}}],
  ['another market',{spot:{...spot,conditionId:'wrong'}}],
  ['unknown market',{spot:{...spot,conditionId:null}}],
  ['another oracle window',{spot:{...spot,windowSeconds:30}}],
  ['stale price',{spot:{...spot,at:now-6001}}],
  ['future price',{spot:{...spot,at:now+1}}],
  ['pre-open price',{spot:{...spot,at:round*1000-1}}],
  ['no official opening',{spot:{...spot,currentOpen:null}}],
  ['invalid latest',{spot:{...spot,price:NaN}}],
  ['missing timestamp',{spot:{...spot,at:null}}],
  ['after the end',{now:(round+300)*1000}],
  ['before the round',{now:round*1000-1}],
])test(`ongoing prediction does not invent a result for ${label}`,()=>{
  assert.equal(liveOrderPrediction(order,{...context,...patch}),null);
});

test('ended or unconfirmed orders cannot use the current spot as their result',()=>{
  for(const status of ['placing','confirming','uncertain','won','lost','rejected','void'])
    assert.equal(liveOrderPrediction({...order,status},context),null);
  const previous={...order,round:round-300,end:round};
  assert.equal(liveOrderPrediction(previous,context),null);
  assert.equal(liveOrderPrediction(previous,{...context,spot:{...spot,round:previous.round}}),null);
});
