import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {orderReason} from '../src/order-reason.mjs';

test('entry reason remains immutable through settlement and hiding',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const order={id:'reason',mode:'paper',round:1800000000,session:store.account('paper').session,status:'open',direction:'DOWN',entryReason:'连续三场 UP，本场买 DOWN；当前价位于蓝色区域'};
  store.reserveOrder(order);store.setHistoryHidden('paper','orders',true);
  store.saveOrder({...order,status:'won',entryReason:'must not replace original evidence'});
  assert.equal(orderReason(store.order(order.id)),order.entryReason);
  assert.equal(store.order(order.id).isHide,true);
});

test('legacy trigger carryover is labeled rather than described as the immediately previous rounds',()=>{
  const order={round:1800000000,direction:'DOWN',streakSignal:{roundsRequired:3,marketDirection:'UP',firstRound:1799998200,lastRound:1799998800,samples:[{round:1799998800,outcome:'UP',source:'official'}]}};
  assert.match(orderReason(order),/沿用了更早的触发记录/);
  order.streakSignal.lastRound=1799999700;assert.match(orderReason(order),/触发区间紧邻本场/);
  assert.match(orderReason({}),/未保存完整下单原因/);
});
