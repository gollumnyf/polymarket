import test from 'node:test';
import assert from 'node:assert/strict';
import {replayLossFollow} from '../scripts/backtest-loss-follow.mjs';
import {DEFAULT_CONFIG} from '../server/strategy.mjs';

function data(results){
  const config={...DEFAULT_CONFIG,baseAmount:10,maxAmount:320,maxDoublings:6,
    stopLoss:1000,minPrice:.4,maxPrice:.7,entryDelay:0,entryWindow:15};
  return {sourceSession:'source',sourceConfig:config,followerConfig:config,
    orders:results.map((status,i)=>{
      const round=1800000000+i*300;
      return {round,direction:'UP',conditionId:'c'+round,oracleWindow:60,strategyVersion:'PR-001',
        status,createdAt:round*1000+2000,settledAt:(round+300)*1000+1000,
        finalDirection:status==='won'?'UP':'DOWN',payoutPerShare:status==='won'?1:0,
        book:{fetchedAt:round*1000+2000,tickSize:.01,minOrderSize:1,asks:[{price:.5,size:10000}]},
        feeSchedule:{rate:0,exponent:1}};
    })};
}

test('replay waits for three completed source losses and requires new losses after its own win',()=>{
  const r=replayLossFollow(data(['lost','lost','lost','won','lost','lost','lost','won']));
  assert.equal(r.trades,2);assert.equal(r.triggers,2);assert.equal(r.pnl,20);
  assert.deepEqual(r.ledger.map(t=>(t.round-1800000000)/300),[3,7]);
  assert.deepEqual(r.ledger.map(t=>t.budget),[10,10]);
});

test('independent Martingale resets at the cap and cannot treat a winning trade as cycle recovery',()=>{
  const d=data(['lost','lost','lost','lost','lost','lost','won']);
  const r=replayLossFollow(d,{legacy:true}),capped=replayLossFollow(d,{legacy:true,config:{...d.followerConfig,maxAmount:41}});
  assert.deepEqual(r.ledger.map(t=>t.budget),[10,20,40,80]);assert.equal(r.pnl,10);
  assert.equal(r.maxLossRun,3);assert.equal(r.drawdown,70);
  assert.deepEqual(capped.ledger.map(t=>t.budget),[10,20,40,10]);assert.equal(capped.pnl,-60);
});

test('LF-002 replay uses the new increment for both quotes and capital limits',()=>{
  const d=data(['lost','lost','lost','lost','lost','lost','won']);
  const r=replayLossFollow(d,{config:{...d.followerConfig,baseAmount:5}});
  assert.equal(r.strategyVersion,'LF-002');
  assert.deepEqual(r.ledger.map(t=>t.budget),[5,15,35,75]);
  assert.equal(r.pnl,20);
  const capped=replayLossFollow(d,{config:{...d.followerConfig,baseAmount:5,maxAmount:34}});
  assert.deepEqual(capped.ledger.map(t=>t.budget),[5,15,5,15]);
});

test('replay respects real book depth instead of scaling historical profit linearly',()=>{
  const d=data(['lost','lost','lost','lost','won']);
  d.orders.at(-1).book.asks=[{price:.5,size:10}];
  const r=replayLossFollow(d);
  assert.equal(r.trades,1);assert.equal(r.pnl,-10);
  assert.equal(r.skipped.ORDER_BOOK_DEPTH_EXHAUSTED,1);
});
