import test from 'node:test';
import assert from 'node:assert/strict';
import {PreviousDirectionEngine} from '../server/previous-direction-engine.mjs';
import {Store} from '../server/store.mjs';
import {apiPath} from '../src/api.mjs';

const start=1800000000;
test('paper chart displays only ready levels from the current oracle window without changing the trade signal',t=>{
  const {engine,official}=fixture(t);
  official(start-300,'DOWN');engine.spot={round:start,windowSeconds:60};
  const candidate={lower:71000,upper:72000,levelAnalysis:{ready:true}};
  engine.chartRangeSource={spot:{round:start,windowSeconds:60},analysis:()=>({candidate,config:{edgePercent:20}})};
  const signal=engine.signal();
  assert.deepEqual(engine.snapshot().chartRange,{lower:71000,upper:72000,edgePercent:20,phase:'reference'});
  assert.deepEqual(engine.snapshot().entrySignal,signal);
  engine.chartRangeSource.spot.windowSeconds=30;
  assert.equal(engine.snapshot().chartRange,null);
});
test('live uses its own execution mode, requires authentication and never starts the paper account',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const engine=new PreviousDirectionEngine(store,{readiness:()=>({enabled:true,configured:true,authenticated:false})},{mode:'live',now:()=>start*1000});
  assert.equal(store.account('live').running,false);
  assert.equal(store.account('live').config.maxPrice,.7);
  assert.equal(store.account('live').config.entryWindow,15);
  await assert.rejects(engine.start('paper'));
  await assert.rejects(engine.start('live'),/请先连接/);
  const other=new PreviousDirectionEngine(store,{readiness:()=>({enabled:false})},{mode:'live',now:()=>start*1000});
  await assert.rejects(other.start('live'));
  assert.equal(store.account('paper').running,false);
  assert.equal(store.account('live').running,false);
  assert.equal(apiPath('live/start','/previous-live'),'/previous-live/api/live/start');
});
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
  assert.equal(first.direction,'UP');assert.equal(first.signalRule,'previous_round_fixed_reverse');assert.equal(first.budget,10);assert.equal(first.price,.7);assert.match(first.entryReason,/官方最终结果 DOWN/);
  market(start+300);predict(start,'DOWN');await engine.attempt('paper');
  const second=store.orderForRound('paper',start+300);assert.equal(second.budget,20);assert.equal(second.direction,'UP');assert.match(second.entryReason,/接口起止价预计 DOWN/);
  market(start+600);predict(start+300,'UP');await engine.attempt('paper');assert.equal(store.orderForRound('paper',start+600).budget,10);
});
test('paper waits within the entry window for a best ask at or above the inclusive floor',async t=>{
  const {engine,store,market,official}=fixture(t);
  official(start-300,'UP');
  assert.equal(store.account('paper').config.minPrice,.4);
  assert.equal(store.account('paper').config.maxPrice,.7);
  await engine.start('paper');
  market(start,0,[{price:.39,size:100}]);await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),0);
  assert.match(store.logs('paper',10).map(row=>row.message).join(' '),/卖一价低于最低买价/);
  market(start,1,[{price:.40,size:100}]);await engine.attempt('paper');
  assert.ok(Math.abs(store.orderForRound('paper',start).price-.4)<1e-9);
});

test('paper saves custom price bounds and does not reset them when the engine is recreated',t=>{
  const {engine,store}=fixture(t),account=store.account('paper');
  assert.throws(()=>engine.configure('paper',{...account.config,minPrice:.6,maxPrice:.5}),/最低买入价不能高于最高买入价/);
  engine.configure('paper',{...account.config,minPrice:.5,maxPrice:.6});
  const restarted=new PreviousDirectionEngine(store,engine.venue,{now:()=>start*1000});
  const config=store.account('paper').config;
  assert.equal(config.minPrice,.5);assert.equal(config.maxPrice,.6);
  const book=price=>({tickSize:.01,minOrderSize:5,asks:[{price,size:100}]});
  const fees={rate:0,exponent:1};
  assert.throws(()=>restarted.quote(book(.49),10,config,fees),{code:'BEST_ASK_BELOW_MIN_PRICE'});
  assert.throws(()=>restarted.quote(book(.61),10,config,fees),{code:'MAX_PRICE_BELOW_BEST_ASK'});
  assert.equal(restarted.quote(book(.6),10,config,fees).priceLimit,.6);
});

test('paper resets the stake after a loss at the configured limit, even while settlement is pending',async t=>{
  const {engine,store,market,predict,official}=fixture(t);
  for(let i=1;i<=41;i++)official(start-i*300,'DOWN');
  const a=store.account('paper');engine.configure('paper',{...a.config,maxDoublings:1,maxAmount:20});
  await engine.start('paper');await engine.attempt('paper');
  market(start+300);predict(start,'DOWN');await engine.attempt('paper');
  assert.equal(store.orderForRound('paper',start+300).budget,20);
  market(start+600);predict(start+300,'DOWN');await engine.attempt('paper');
  assert.equal(store.orderForRound('paper',start+600).budget,10);
  const limit={...a,config:{...a.config,maxDoublings:1},losses:1,pnl:-10};
  const settled=engine.accountAfterSettlement(limit,-20,false);
  assert.equal(settled.losses,0);assert.equal(settled.cycle,a.cycle+1);assert.equal(settled.pnl,-30);
});
test('live and paper both buy the opposite direction even with a five-round same-direction advantage',t=>{
  const {engine:paper,store,predict,official}=fixture(t);
  const engine=new PreviousDirectionEngine(store,paper.venue,{mode:'live',now:()=>start*1000});
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
  assert.equal(corrected.code,'PREVIOUS_REVERSE_COOLDOWN');
  official(start-3*300,null,'void');
  assert.equal(engine.signal().stats.missing,2);
  official(start-41*300,'DOWN');
  assert.equal(engine.signal().stats.reverse,18);
  official(start-3*300,'DOWN');
  assert.equal(engine.signal().stats.same-engine.signal().stats.reverse,4);
  assert.equal(engine.signal().stats.rule,'reverse');
  official(start-41*300,null,'void');
  assert.equal(engine.signal().stats.same-engine.signal().stats.reverse,5);
  assert.equal(engine.signal().stats.rule,'reverse');
  assert.equal(engine.signal().direction,'UP');
  assert.equal(paper.signal().stats.rule,'reverse');
  assert.equal(paper.signal().direction,'UP');
});
for(const direction of ['UP','DOWN'])test('paper and live pause once after exactly two consecutive '+direction+' rounds',async t=>{
  const {engine,store,market,official,predict}=fixture(t);
  const opposite=direction==='UP'?'DOWN':'UP';
  official(start-900,opposite);
  official(start-600,direction);predict(start-300,direction);
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(engine.entryBlocks.paper.code,'PREVIOUS_REVERSE_COOLDOWN');
  const live=new PreviousDirectionEngine(store,engine.venue,{mode:'live',now:()=>start*1000});
  assert.equal(live.signal().code,'PREVIOUS_REVERSE_COOLDOWN');
  assert.equal(store.orderCount('paper'),0);
  official(start,direction);market(start+300);await engine.attempt('paper');
  assert.equal(store.orderForRound('paper',start+300).direction,opposite);
  assert.equal(live.signal(start+300).direction,opposite);
});
test('previous-direction refuses earlier rounds, voids, prices over 0.70, depth only beyond the cap, and late fills',async t=>{
  const {engine,store,market,predict,official}=fixture(t);
  predict(start-600,'DOWN');await engine.start('paper');await engine.attempt('paper');assert.equal(engine.entryBlocks.paper.code,'PREVIOUS_DIRECTION_MISSING');
  predict(start-300,'UP');market(start,1,[{price:.71,size:1000}]);await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  market(start,2,[{price:.5,size:5},{price:.71,size:1000}]);await engine.attempt('paper');assert.equal(engine.entryBlocks.paper.code,'EXECUTION_PRICE_LIMITED_DEPTH');
  market(start,16);await engine.attempt('paper');assert.equal(engine.entryBlocks.paper.code,'ENTRY_WINDOW_CLOSED');
  market(start+300);official(start,null,'void');await engine.attempt('paper');assert.equal(engine.entryBlocks.paper.code,'PREVIOUS_ROUND_VOID');assert.equal(store.orderCount('paper'),0);
  assert.equal(apiPath('paper/start','/previous'),'/previous/api/paper/start');
});

test('paper prefetches market metadata before the bell and uses opening books only after fresh status is confirmed',async t=>{
  const {engine,store,market,official}=fixture(t);
  official(start-300,'UP');
  await engine.start('paper');
  market(start-300,290);
  const calls=[];
  const upcoming={round:start,conditionId:'new',active:false,outcomes:[{direction:'DOWN',assetId:'down'}]};
  const venue=engine.venue;
  venue.market=async round=>{calls.push(['market',round]);return upcoming;};
  venue.books=async m=>{calls.push(['books',m.round]);return {};};
  engine.prefetchNextMarket();
  await engine.marketPrefetchTask;
  assert.deepEqual(calls,[['market',start]]);
  assert.equal(engine.market.round,start-300);
  market(start,0);
  engine.market=null;
  engine.books={};
  const fresh={...upcoming,active:true,fetchedAt:start*1000,feeSchedule:{rate:.07,exponent:1}};
  let confirm;
  venue.market=round=>{calls.push(['market',round]);return new Promise(resolve=>{confirm=resolve;});};
  const book={fetchedAt:start*1000,tickSize:.01,minOrderSize:5,asks:[{price:.50,size:100}]};
  venue.books=async m=>{calls.push(['books',m.round]);return {DOWN:book};};
  const opening=engine.refreshMarketBooks(start,[]);
  await Promise.resolve();
  assert.deepEqual(calls,[['market',start],['market',start],['books',start]]);
  await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),0);
  confirm(fresh);
  await opening;
  await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),1);
});

test('paper discards opening books for token IDs that failed market revalidation',async t=>{
  const {engine,market}=fixture(t);
  market(start);
  engine.market=null;
  const cached={round:start,conditionId:'old',outcomes:[{direction:'UP',assetId:'old-up'}]};
  engine.prefetchedMarket=cached;
  const fresh={round:start,conditionId:'new',outcomes:[{direction:'UP',assetId:'new-up'}]};
  engine.venue.market=async()=>fresh;
  const calls=[];
  engine.venue.books=async m=>{calls.push(m.conditionId);return {UP:{assetId:m.outcomes[0].assetId}};};
  await engine.refreshMarketBooks(start,[]);
  assert.deepEqual(calls,['old','new']);
  assert.equal(engine.books.UP.assetId,'new-up');
});
