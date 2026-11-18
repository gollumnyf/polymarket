import test from 'node:test';
import assert from 'node:assert/strict';
import {PreviousDirectionEngine} from '../server/previous-direction-engine.mjs';
import {Store} from '../server/store.mjs';
import {apiPath} from '../src/api.mjs';

const start=1800000000;
function fixture(t){
  const store=new Store(':memory:');let now=start*1000;
  const engine=new PreviousDirectionEngine(store,{readiness:()=>({enabled:false})},{now:()=>now});
  function market(round=start,seconds=0,asks=[{price:.70,size:1000}]){
    now=(round+seconds)*1000;
    engine.market={round,conditionId:'condition-'+round,active:true,fetchedAt:now,slug:`btc-updown-5m-${round}`,feeSchedule:{rate:.07,exponent:1},outcomes:[{direction:'UP',assetId:'up',index:0},{direction:'DOWN',assetId:'down',index:1}]};
    const book={fetchedAt:now,tickSize:.01,minOrderSize:5,asks,bids:[]};engine.books={UP:book,DOWN:book};
  }
  const predict=(round,outcome)=>store.saveRoundPrediction({round,conditionId:'condition-'+round,open:100,close:outcome==='UP'?101:99,outcome,source:'polymarket_crypto_price',oracleWindow:60,observedAt:now});
  const official=(round,result,status='resolved')=>store.saveHistoricalRound({round,slug:`btc-updown-5m-${round}`,end:round+300,status,result},now);
  market();t.after(()=>store.close());return {engine,store,market,predict,official};
}
test('previous-direction paper fills at open without a current BTC quote, uses official direction, and doubles on a predicted loss',async t=>{
  const {engine,store,market,predict,official}=fixture(t);
  for(let i=2;i<=41;i++)official(start-i*300,'DOWN');
  predict(start-300,'UP');official(start-300,'DOWN');
  engine.errors.spot='Current BTC feed unavailable';
  await assert.rejects(engine.start('live'));await engine.start('paper');await engine.attempt('paper');await engine.attempt('paper');
  const first=store.orderForRound('paper',start);assert.equal(store.orderCount('paper'),1);
  assert.equal(first.direction,'DOWN');assert.equal(first.budget,10);assert.equal(first.price,.7);assert.match(first.entryReason,/官方最终结果 DOWN/);
  market(start+300);predict(start,'UP');await engine.attempt('paper');
  const second=store.orderForRound('paper',start+300);assert.equal(second.budget,20);assert.equal(second.direction,'UP');assert.match(second.entryReason,/接口起止价预计 UP/);
  market(start+600);predict(start+300,'UP');await engine.attempt('paper');assert.equal(store.orderForRound('paper',start+600).budget,10);
});
test('rolling 40 chooses reverse on a tie and below a five-round advantage, then honors an advantage of exactly five',t=>{
  const {engine,predict,official}=fixture(t);
  predict(start-300,'UP');
  let direction='UP';
  for(let i=2;i<=41;i++){
    if(i<=21)direction=direction==='UP'?'DOWN':'UP';
    official(start-i*300,direction);
  }
  official(start-42*300,'DOWN');official(start,'DOWN');
  const tied=engine.signal();
  assert.deepEqual(tied.stats,{same:20,reverse:20,estimated:1,missing:0,total:40,rule:'reverse'});
  assert.equal(tied.direction,'DOWN');
  official(start-300,'DOWN');
  const corrected=engine.signal();
  assert.deepEqual(corrected.stats,{same:21,reverse:19,estimated:0,missing:0,total:40,rule:'reverse'});
  assert.equal(corrected.direction,'UP');
  official(start-3*300,null,'void');
  assert.equal(engine.signal().stats.missing,2);
  official(start-41*300,'DOWN');
  assert.equal(engine.signal().stats.reverse,18);
  official(start-3*300,'DOWN');
  assert.equal(engine.signal().stats.same-engine.signal().stats.reverse,4);
  assert.equal(engine.signal().stats.rule,'reverse');
  official(start-41*300,null,'void');
  assert.equal(engine.signal().stats.same-engine.signal().stats.reverse,5);
  assert.equal(engine.signal().stats.rule,'same');
});
test('reverse pauses exactly one round when the second consecutive same-direction result lands',async t=>{
  const {engine,store,market,official}=fixture(t);
  for(let i=3;i<=41;i++)official(start-i*300,i%2?'UP':'DOWN');
  official(start-600,'UP');official(start-300,'UP');
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(engine.entryBlocks.paper.code,'PREVIOUS_REVERSE_COOLDOWN');
  assert.equal(store.orderCount('paper'),0);
  official(start,'UP');market(start+300);await engine.attempt('paper');
  assert.equal(store.orderForRound('paper',start+300).direction,'DOWN');
});
test('previous-direction refuses earlier rounds, voids, prices over 0.70, depth only beyond the cap, and late fills',async t=>{
  const {engine,store,market,predict,official}=fixture(t);
  predict(start-600,'UP');await engine.start('paper');await engine.attempt('paper');assert.equal(engine.entryBlocks.paper.code,'PREVIOUS_DIRECTION_MISSING');
  predict(start-300,'UP');market(start,1,[{price:.71,size:1000}]);await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  market(start,2,[{price:.5,size:5},{price:.71,size:1000}]);await engine.attempt('paper');assert.equal(engine.entryBlocks.paper.code,'EXECUTION_PRICE_LIMITED_DEPTH');
  market(start,16);await engine.attempt('paper');assert.equal(engine.entryBlocks.paper.code,'ENTRY_WINDOW_CLOSED');
  market(start+300);official(start,null,'void');await engine.attempt('paper');assert.equal(engine.entryBlocks.paper.code,'PREVIOUS_ROUND_VOID');assert.equal(store.orderCount('paper'),0);
  assert.equal(apiPath('paper/start','/previous'),'/previous/api/paper/start');
});
