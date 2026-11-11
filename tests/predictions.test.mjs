import test from 'node:test';
import assert from 'node:assert/strict';
import {predictionFromPrices,projectedAccount} from '../server/predictions.mjs';
import {DEFAULT_CONFIG,nextAmount,riskReason} from '../server/strategy.mjs';

const order={id:'o',round:1800000000,end:1800000300,direction:'DOWN',conditionId:'c'};
const prices={round:order.round,conditionId:'c',open:100,close:101,source:'polymarket_event_metadata'};
test('predictions use matching platform round start/end prices only after the round ends and equality is UP',()=>{
  const prediction=predictionFromPrices(order,prices,order.end*1000);
  assert.equal(prediction.outcome,'UP'); assert.equal(prediction.won,false);
  assert.equal(prediction.open,100); assert.equal(prediction.close,101);
  assert.equal(predictionFromPrices(order,{...prices,close:100},order.end*1000).outcome,'UP');
  for(const invalid of [{...prices,close:null},{...prices,open:0},{...prices,source:'stream'},
    {...prices,round:order.round+300},{...prices,conditionId:'other'}])
    assert.equal(predictionFromPrices(order,invalid,order.end*1000),null);
  assert.equal(predictionFromPrices(order,prices,order.end*1000-1),null);
});
test('pending predictions advance sequence without changing realized results or counting pending payouts as money',()=>{
  const account={config:{...DEFAULT_CONFIG,baseAmount:5},losses:1,cycle:2,pnl:-5,balance:990,wins:0,settled:1};
  const pending=[{status:'open',cost:10,prediction:{won:false}},{status:'open',cost:20,prediction:{won:false}}];
  const projected=projectedAccount(account,pending);
  assert.equal(projected.losses,3); assert.equal(nextAmount(projected),40);
  assert.equal(account.losses,1); assert.equal(projected.pnl,-5); assert.equal(projected.balance,990);
  assert.equal(projected.settled,1); assert.equal(projected.riskPnl,-35);
  assert.equal(projectedAccount(account,[...pending,{status:'open',cost:40,prediction:{won:true}}]).losses,0);
  assert.match(riskReason({...projected,config:{...projected.config,stopLoss:50}},990),/累计亏损/);
});

test('last-second fallback accepts only actual same-round closing-second timestamps and retains evidence',()=>{
  const last={...prices,source:'polymarket_last_second',priceAt:order.end*1000-1};
  const forecast=predictionFromPrices(order,last,order.end*1000);
  assert.equal(forecast.source,'polymarket_last_second');assert.equal(forecast.priceAt,last.priceAt);
  assert.equal(predictionFromPrices(order,{...last,priceAt:order.end*1000},order.end*1000),null);
  assert.equal(predictionFromPrices(order,{...last,priceAt:order.end*1000-1001},order.end*1000),null);
  assert.equal(predictionFromPrices(order,{...last,priceAt:null},order.end*1000),null);
});
