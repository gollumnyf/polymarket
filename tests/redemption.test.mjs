import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {LiveRedemption} from '../server/redemption.mjs';

const start=1800000000000,wallet='0x'+'1'.repeat(40);
function fixture(t){
  const store=new Store(':memory:');t.after(()=>store.close());
  const calls=[];let now=start+100000;
  const venue={readiness:()=>({authenticated:true,wallet,redemptionConfigured:true}),
    balance:async()=>calls.push('balance'),hasRedeemablePosition:async()=>true,
    cleanWalletError:error=>error.message,
    redeemPosition:async (_job,beforeSubmit)=>{beforeSubmit();calls.push('submit');return {transactionId:'tx-1'};},
    redemptionReceipt:async id=>{calls.push(id);return {state:'STATE_CONFIRMED',transactionHash:'hash'};}};
  const engine={store,venue,now:()=>now,busy:false,closing:false,log(){},broadcast(){}};
  const worker=new LiveRedemption(engine);
  const order={id:'live-1',mode:'live',session:store.account('live').session,round:start/1000-300,status:'won',payout:10,
    settledAt:start+10,conditionId:'condition',assetId:'123'};
  store.reserveOrder(order);worker.bind(order,'v2');
  return {store,engine,venue,worker,calls,time:ms=>{now=start+ms;}};
}

test('redeems off the trading path, resumes polling by saved transaction ID and refreshes balance after confirmation',async t=>{
  const {engine,worker,calls,time,store}=fixture(t);
  time(0);worker.tick();assert.equal(worker.task,null);
  time(290000);worker.tick();assert.equal(worker.task,null);
  time(100000);engine.busy=true;worker.tick();assert.equal(worker.task,null);
  engine.busy=false;worker.tick();await worker.task;
  assert.deepEqual(calls,['submit','balance']);
  const resumed=new LiveRedemption(engine);
  time(106000);resumed.tick();await resumed.task;
  assert.deepEqual(calls,['submit','balance','tx-1','balance']);
  assert.equal(resumed.snapshot().counts.confirmed,1);
  assert.equal(store.db.prepare('SELECT transaction_hash FROM live_redemptions').get().transaction_hash,'hash');
});

test('ambiguous submission is persisted and never submitted again after restart',async t=>{
  const {worker,engine,calls,time,venue}=fixture(t);
  venue.redeemPosition=async (_job,beforeSubmit)=>{beforeSubmit();calls.push('submit');throw Error('timeout');};
  worker.tick();await worker.task;
  const resumed=new LiveRedemption(engine);
  time(140000);resumed.tick();await resumed.task;
  assert.equal(resumed.snapshot().counts.uncertain,1);
  assert.equal(calls.filter(x=>x==='submit').length,1);
});

test('market boundary is checked again before the relayer request',async t=>{
  const {worker,calls,time,venue}=fixture(t);
  venue.redeemPosition=async (_job,beforeSubmit)=>{time(275000);beforeSubmit();calls.push('submit');};
  worker.tick();await worker.task;
  assert.equal(worker.snapshot().counts.waiting,1);
  assert.deepEqual(calls,[]);
});
