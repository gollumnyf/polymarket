import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {PreviousDirectionEngine} from '../server/previous-direction-engine.mjs';
import {StreakReverseEngine} from '../server/streak-reverse-engine.mjs';
import {apiPath} from '../src/api.mjs';

const round=1800000000;
function fixture(t,streakRounds=3){
  const sourceStore=new Store(':memory:'),store=new Store(':memory:');
  t.after(()=>{sourceStore.close();store.close();});
  let now=round*1000+1000;
  const clock=()=>now;
  const venue={readiness:()=>({enabled:false}),buy:()=>assert.fail('paper execution only')};
  const source=new PreviousDirectionEngine(sourceStore,venue,{now:clock});
  const engine=new StreakReverseEngine(store,venue,{source,now:clock,streakRounds});
  const result=(start,outcome,status='resolved')=>sourceStore.saveHistoricalRound({round:start,end:start+300,slug:'r'+start,status,result:outcome},now);
  const market=(start,price=.65,seconds=1)=>{
    now=(start+seconds)*1000;
    engine.market={round:start,active:true,fetchedAt:now,conditionId:'c'+start,slug:'r'+start,feeSchedule:{rate:.05,exponent:1},
      outcomes:[{direction:'UP',assetId:'up',index:0},{direction:'DOWN',assetId:'down',index:1}]};
    const book={fetchedAt:now,tickSize:.01,minOrderSize:5,asks:[{price,size:100}],bids:[]};
    engine.books={UP:book,DOWN:book};
  };
  return {engine,source,sourceStore,store,result,market,venue,clock};
}

test('three immediately preceding shared market results must match, with official results preferred',t=>{
  const {engine,source,sourceStore,result}=fixture(t);
  assert.equal(engine.history,source.history);
  result(round-1200,'UP');result(round-600,'UP');result(round-300,'UP');
  assert.equal(engine.signal().direction,null);
  sourceStore.saveRoundPrediction({round:round-900,conditionId:'c'+(round-900),open:100,close:101,outcome:'UP',
    oracleWindow:60,source:'polymarket_crypto_price',observedAt:round*1000-1000});
  assert.equal(engine.signal().direction,'DOWN');
  assert.match(engine.signal().message,/预计/);
  result(round-900,'DOWN');
  assert.equal(engine.signal().direction,null);
  result(round-300,null,'void');
  assert.equal(engine.signal().code,'PREVIOUS_ROUND_VOID');
  assert.equal(apiPath('paper/start','/streak-reverse'),'/streak-reverse/api/paper/start');
});

test('SR-001 uses separate settings and bankroll, even when the engine is restarted',async t=>{
  const {engine,source,sourceStore,store,venue,clock}=fixture(t);
  assert.equal(store.account('paper').balance,10000);
  assert.equal(store.account('paper').running,false);
  engine.configure('paper',{...store.account('paper').config,baseAmount:30,maxDoublings:4,minPrice:.6,maxPrice:.9,stopLoss:120});
  const reopened=new StreakReverseEngine(store,venue,{source,now:clock});
  const a=reopened.snapshot().accounts.paper;
  assert.equal(a.config.baseAmount,10);assert.equal(a.config.maxDoublings,0);
  assert.equal(a.config.minPrice,.40);assert.equal(a.config.maxPrice,.65);
  assert.equal(a.config.stopLoss,120);assert.equal(a.fixedStake,true);
  assert.equal(reopened.strategyVersion,'SR-001');
  assert.equal(sourceStore.account('paper').config.maxPrice,.7);
  assert.equal(sourceStore.account('paper').balance,1000);
  await assert.rejects(reopened.start('live'),/不支持此交易模式/);
});

test('the fixed budget respects the price floor, hard cap, entry window, and its own losing-fill cooldown',async t=>{
  const {engine,store,sourceStore,result,market}=fixture(t);
  for(const offset of [300,600,900])result(round-offset,'DOWN');
  await engine.start('paper');
  market(round,.39);await engine.attempt('paper');
  assert.equal(store.entryBlock('paper',round).code,'BEST_ASK_BELOW_MIN_PRICE');
  market(round,.66);await engine.attempt('paper');
  assert.equal(store.entryBlock('paper',round).code,'MAX_PRICE_BELOW_BEST_ASK');
  market(round,.65);await engine.attempt('paper');await engine.attempt('paper');
  const first=store.orderForRound('paper',round);
  assert.equal(first.direction,'UP');assert.equal(first.strategyVersion,'SR-001');
  assert.equal(first.budget,10);assert.equal(first.priceLimit,.65);
  assert.match(first.entryReason,/紧邻前三场同向/);
  assert.equal(store.orderCount('paper'),1);assert.equal(sourceStore.orderCount('paper'),0);
  market(round+300);result(round,'DOWN');await engine.attempt('paper');
  assert.equal(store.entryBlock('paper',round+300).code,'PREVIOUS_REVERSE_COOLDOWN');
  result(round+300,'DOWN');market(round+600,.65,16);await engine.attempt('paper');
  assert.equal(store.entryBlock('paper',round+600).code,'ENTRY_WINDOW_CLOSED');
  result(round+600,'DOWN');market(round+900);await engine.attempt('paper');
  assert.equal(store.orderForRound('paper',round+900).budget,10);
  assert.equal(store.orderForRound('paper',round+900).doubling,0);
  assert.equal(store.prediction(first.id),null);
});

test('SR-002 checks only the adjacent pair and prioritizes its official results',t=>{
  const {engine,source,sourceStore,result}=fixture(t,2);
  result(round-900,'UP');result(round-300,'UP');
  assert.equal(engine.signal().direction,null);
  sourceStore.saveRoundPrediction({round:round-600,conditionId:'c'+(round-600),open:100,close:101,outcome:'UP',
    oracleWindow:60,source:'polymarket_crypto_price',observedAt:round*1000-1000});
  assert.equal(engine.signal().direction,'DOWN');
  assert.match(engine.signal().message,/紧邻前两场同向.*预计/);
  assert.ok(!engine.signal().message.includes('#'+(round-900)));
  result(round-600,'DOWN');
  assert.equal(engine.signal().code,'STREAK_REVERSE_NO_SIGNAL');
  result(round-600,null,'void');
  assert.equal(engine.signal().direction,null);
  assert.equal(engine.history,source.history);
  assert.equal(apiPath('events?chart=1','/streak-reverse-two'),'/streak-reverse-two/api/events?chart=1');
});

test('SR-002 trades an exact pair, skips one round after its own losing fill and keeps its own bankroll',async t=>{
  const {engine,source,store,result,market,venue,clock}=fixture(t,2);
  const threeStore=new Store(':memory:');t.after(()=>threeStore.close());
  const three=new StreakReverseEngine(threeStore,venue,{source,now:clock});
  assert.equal(engine.snapshot().accounts.paper.streakRounds,2);
  assert.equal(three.snapshot().accounts.paper.streakRounds,3);
  assert.equal(store.account('paper').running,false);
  engine.configure('paper',{...store.account('paper').config,stopLoss:120});
  assert.equal(threeStore.account('paper').config.stopLoss,1000);
  result(round-900,'UP');result(round-600,'DOWN');result(round-300,'DOWN');
  assert.equal(three.signal().code,'PREVIOUS_REVERSE_COOLDOWN');
  await engine.start('paper');
  for(const [price,code] of [[.39,'BEST_ASK_BELOW_MIN_PRICE'],[.66,'MAX_PRICE_BELOW_BEST_ASK']]){
    market(round,price);await engine.attempt('paper');
    assert.equal(store.entryBlock('paper',round).code,code);
  }
  market(round,.65);await engine.attempt('paper');await engine.attempt('paper');
  const order=store.orderForRound('paper',round);
  assert.equal(order.strategyVersion,'SR-002');
  assert.equal(order.signalRule,'previous_two_round_streak_reverse');
  assert.equal(order.direction,'UP');assert.equal(order.budget,10);assert.equal(order.priceLimit,.65);
  assert.equal(store.orderCount('paper'),1);
  assert.equal(threeStore.orderCount('paper'),0);assert.equal(threeStore.account('paper').balance,10000);
  result(round,'DOWN');market(round+300);await engine.attempt('paper');
  const skipped=store.entryBlock('paper',round+300);
  assert.equal(skipped.code,'PREVIOUS_REVERSE_COOLDOWN');assert.match(skipped.message,/最近两场/);
  result(round+300,'DOWN');market(round+600);await engine.attempt('paper');
  assert.equal(store.orderForRound('paper',round+600).budget,10);
  assert.equal(store.orderCount('paper'),2);
  await assert.rejects(engine.start('live'),/不支持此交易模式/);
});
