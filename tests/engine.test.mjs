import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { roundStart } from '../server/strategy.mjs';
import {withEntryMode} from '../src/entry-mode.mjs';

function setup(t, mode = 'paper') {
  let now = 1800000010000;
  const store = new Store(':memory:'); t.after(() => store.close());
  let buyCount = 0;
  const venue = { readiness: () => ({ configured: true, enabled: true, authenticated: true }),
    balance: async () => 1000, buy: async () => { buyCount++; return { ok: true, orderId: '0x' + 'a'.repeat(64), tradeIds: [] }; },
    reconcile: async () => null, resolution: async () => null };
  const engine = new Engine(store, venue, { now: () => now });
  for (const accountMode of ['paper', 'live']) store.saveAccount({ ...store.account(accountMode), config: { ...store.account(accountMode).config, baseAmount: 5 } });
  const start = roundStart(now);
  function fresh() {
    engine.spot = { round: roundStart(now), previousOpen: 100, currentOpen:100, price: 101, at: now, direction: 'UP' };
    engine.market = { round: roundStart(now), active: true, fetchedAt: now, slug: `btc-updown-5m-${roundStart(now)}`, conditionId: 'condition',
      outcomes: [{ index: 0, direction: 'UP', assetId: 'up' }, { index: 1, direction: 'DOWN', assetId: 'down' }], feeSchedule: { rate: .07, exponent: 1 } };
    engine.books = { UP: { tickSize: .01, minOrderSize: 1, fetchedAt: now, asks: [{ price: '.5', size: '1000' }] } };
  }
  fresh();
  return { engine, store, venue, start, mode, fresh, setNow: value => { now = value; }, buys: () => buyCount };
}

test('one simulated order per round survives repeated tick checks and stop/restart', async t => {
  const { engine, store, start } = setup(t);
  await engine.start('paper'); await engine.attempt('paper'); await engine.attempt('paper');
  engine.stop('paper'); await engine.start('paper'); await engine.attempt('paper');
  assert.equal(store.orders('paper').length, 1); assert.equal(store.orderForRound('paper', start).status, 'open');
  assert.equal(store.account('paper').balance, 995);
});

function enableAlignment(store,start,outcome='UP') {
  store.saveAccount({...store.account('paper'),config:{...store.account('paper').config,sameDirectionOnly:true}});
  if(outcome)store.saveRoundPrediction({round:start-300,conditionId:'previous-market',open:100,
    close:outcome==='UP'?101:99,outcome,source:'polymarket_event_metadata',oracleWindow:60,observedAt:start*1000});
}

test('same-direction filter checks the actual entry signal, waits on mismatch and can buy once when it aligns',async t=>{
  const {engine,store,start}=setup(t);enableAlignment(store,start,'DOWN');
  engine.books.DOWN={...engine.books.UP};
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),0);assert.match(engine.status.paper,/本场 UP.*上一场预计 DOWN.*不一致/);
  engine.spot.direction='DOWN';engine.spot.price=99;
  await engine.attempt('paper');await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),1);assert.equal(store.orders('paper')[0].direction,'DOWN');
});

test('same-direction filter uses the configured entry moment rather than freezing an earlier signal',async t=>{
  const {engine,store,start,setNow,fresh}=setup(t);enableAlignment(store,start,'UP');
  store.saveAccount({...store.account('paper'),config:{...store.account('paper').config,entryDelay:10}});
  await engine.start('paper');setNow((start+5)*1000);fresh();engine.spot.direction='DOWN';engine.spot.price=99;
  await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  setNow((start+10)*1000);fresh();await engine.attempt('paper');
  assert.equal(store.orders('paper')[0].direction,'UP');
});

test('previous-round forecast is fetched without any trade or official settlement, and a missing forecast blocks entry',async t=>{
  const {engine,store,venue,start}=setup(t);enableAlignment(store,start,null);
  engine.spot.previousClose=101;
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),0);assert.match(engine.status.paper,/等待上一场平台起止价/);
  let queries=0;
  venue.roundPrices=async request=>{
    queries++;assert.equal(request.round,start-300);assert.equal(request.end,start);
    return {round:start-300,conditionId:'untraded-market',open:100,close:101,source:'polymarket_crypto_price',oracleWindow:60};
  };
  await engine.refreshPreviousPrediction();await engine.refreshPreviousPrediction();
  assert.equal(queries,1);assert.equal(store.orderCount('paper'),0);
  await engine.attempt('paper');assert.equal(store.orderCount('paper'),1);
  assert.equal(engine.snapshot().previousRoundPrediction.outcome,'UP');
});

test('same direction means previous market UP/DOWN, independently of whether the previous position was a win',async t=>{
  const {engine,store,start}=setup(t);enableAlignment(store,start,'UP');
  const account=store.account('paper');store.saveAccount({...account,balance:995});
  store.reserveOrder({id:'prior-down',mode:'paper',session:account.session,round:start-300,end:start,
    status:'open',direction:'DOWN',conditionId:'previous-market',budget:5,cost:5,shares:9.6});
  store.savePrediction({orderId:'prior-down',open:100,close:101,outcome:'UP',won:false,
    source:'polymarket_event_metadata',observedAt:start*1000});
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(store.orders('paper')[0].direction,'UP');assert.equal(store.orders('paper')[0].budget,10);
  assert.equal(store.account('paper').settled,0);
});

test('disabled same-direction filtering preserves entry even when the previous market predicted the other direction',async t=>{
  const {engine,store,start}=setup(t);enableAlignment(store,start,'DOWN');
  engine.configure('paper',{...store.account('paper').config,sameDirectionOnly:false});
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(store.orders('paper')[0].direction,'UP');
});

test('live entry rechecks same-direction matching after awaiting wallet data',async t=>{
  const {engine,store,venue,start,buys}=setup(t,'live');enableAlignment(store,start,'UP');
  engine.configure('live',{...store.account('live').config,sameDirectionOnly:true});
  await engine.start('live');let release;
  venue.balance=()=>new Promise(resolve=>{release=resolve;});
  const attempt=engine.attempt('live');engine.spot.direction='DOWN';release(1000);await attempt;
  assert.equal(buys(),0);assert.equal(store.orderCount('live'),0);assert.match(engine.status.live,/不一致/);
});

test('following the prior forecast waits for the configured delay despite the legacy at-open flag and an opposite current signal',async t=>{
  const {engine,store,start,setNow,fresh}=setup(t);
  enableAlignment(store,start,'DOWN');
  engine.configure('paper',{...store.account('paper').config,followPreviousAtOpen:true,entryDelay:20});
  setNow((start+20)*1000-1);fresh();engine.books.DOWN={...engine.books.UP};
  await engine.start('paper');await engine.attempt('paper');await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),0);assert.match(engine.status.paper,/等待设定的入场时间/);
  setNow((start+20)*1000);fresh();engine.books.DOWN={...engine.books.UP};
  await engine.attempt('paper');await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),1);assert.equal(store.orders('paper')[0].direction,'DOWN');
  assert.equal(store.orders('paper')[0].signalRule,'previous_round_prediction');
  assert.equal(store.orders('paper')[0].createdAt,(start+20)*1000);
});

for(const mode of ['paper','live'])for(const rule of [
  {value:'independent',current:'UP',expected:'UP'},
  {value:'same_direction',current:'UP',expected:null},
  {value:'same_direction',current:'DOWN',expected:'DOWN'},
  {value:'follow_previous',current:'UP',expected:'DOWN'},
  {value:'reverse',current:'UP',expected:'DOWN'},
  {value:'reverse',current:'DOWN',expected:'UP'},
])test(`${mode}: ${rule.value} observes the configured delay and chooses ${rule.expected??'no trade'} for current ${rule.current}, previous DOWN`,async t=>{
  const {engine,store,start,setNow,fresh,buys}=setup(t,mode);
  engine.configure(mode,withEntryMode({...store.account(mode).config,entryDelay:10},rule.value));
  store.saveRoundPrediction({round:start-300,conditionId:'prior',open:100,close:99,outcome:'DOWN',source:'polymarket_event_metadata',oracleWindow:60,observedAt:start*1000});
  const update=()=>{fresh();engine.spot.direction=rule.current;engine.spot.price=rule.current==='UP'?101:99;engine.books.DOWN={...engine.books.UP};};
  setNow((start+10)*1000-1);update();await engine.start(mode);await engine.attempt(mode);
  assert.equal(store.orderCount(mode),0);assert.equal(buys(),0);
  setNow((start+10)*1000);update();await engine.attempt(mode);await engine.attempt(mode);
  assert.equal(store.orderCount(mode),rule.expected?1:0);
  if(rule.expected){assert.equal(store.orders(mode)[0].direction,rule.expected);assert.equal(store.orders(mode)[0].createdAt,(start+10)*1000);}
  if(rule.value==='reverse'){
    const order=store.orders(mode)[0];assert.equal(order.signalRule,'current_round_reverse');
    assert.equal(order.referencePrice,100);assert.equal(order.signalPrice,rule.current==='UP'?101:99);
    assert.equal(order.assetId,rule.expected.toLowerCase());
  }
  if(mode==='live')assert.equal(buys(),rule.expected?1:0);
});

test('reverse mode never guesses for flat or stale signals and uses the opposite book only once',async t=>{
  const {engine,store,start,setNow,fresh}=setup(t);
  engine.configure('paper',withEntryMode(store.account('paper').config,'reverse'));
  await engine.start('paper');engine.books.DOWN={...engine.books.UP};
  engine.spot.direction=null;engine.spot.price=100;await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  engine.spot.direction='UP';engine.spot.price=101;engine.spot.at-=7000;
  await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  fresh();engine.books.DOWN={...engine.books.UP,fetchedAt:engine.spot.at-7000};
  await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  engine.books.DOWN={...engine.books.UP};await engine.attempt('paper');await engine.attempt('paper');
  const order=store.orders('paper')[0];assert.equal(order.direction,'DOWN');assert.equal(store.orderCount('paper'),1);
  setNow((start+310)*1000);fresh();
  const prices={round:start,conditionId:'condition',open:100,close:99,source:'polymarket_event_metadata',oracleWindow:60};
  store.saveRoundPrediction({...prices,outcome:'DOWN',observedAt:(start+310)*1000});
  await engine.refreshPredictions();assert.equal(store.order(order.id).prediction.won,true);
  assert.equal(engine.snapshot().accounts.paper.nextAmount,5);
});

test('live reverse mode rechecks the inverted signal after awaiting wallet data',async t=>{
  const {engine,store,venue,buys}=setup(t,'live');
  engine.configure('live',withEntryMode(store.account('live').config,'reverse'));
  engine.books.DOWN={...engine.books.UP};await engine.start('live');let release;
  venue.balance=()=>new Promise(resolve=>{release=resolve;});
  const attempt=engine.attempt('live');engine.spot.direction='DOWN';engine.spot.price=99;release(1000);await attempt;
  assert.equal(buys(),0);assert.equal(store.orderCount('live'),0);assert.match(engine.status.live,/信号已改变/);
});

test('follow-at-open needs a prior forecast and fresh book, but does not require a current BTC opening or spot signal',async t=>{
  const {engine,store,start}=setup(t);
  engine.configure('paper',{...store.account('paper').config,followPreviousAtOpen:true});engine.spot=null;
  await engine.start('paper');await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
  assert.match(engine.status.paper,/上一场预计方向/);
  store.saveRoundPrediction({round:start-300,conditionId:'prev',open:100,close:101,outcome:'UP',source:'polymarket_crypto_price',oracleWindow:60,observedAt:start*1000});
  engine.books.UP.fetchedAt-=7000;await engine.attempt('paper');assert.equal(store.orderCount('paper'),0);
});

test('stalled price APIs and spot polling do not delay last-second prediction and the next doubled entry',async t=>{
  const {engine,store,venue,start,setNow,fresh}=setup(t);
  await engine.start('paper');await engine.attempt('paper');
  store.saveRoundOpening({round:start,conditionId:'condition',open:100,oracleWindow:60,observedAt:start*1000});
  const ticks=[{time:(start+299)*1000,price:99,oracleWindow:60}];
  venue.drainPriceTicks=()=>ticks.splice(0);let releasePrices,releaseSpot;
  venue.roundPrices=()=>new Promise(resolve=>{releasePrices=resolve;});
  venue.spot=()=>new Promise(resolve=>{releaseSpot=resolve;});
  venue.readiness=()=>({authenticated:false});venue.market=async()=>engine.market;venue.books=async()=>engine.books;
  setNow((start+305)*1000);fresh();await engine.tick();
  assert.equal(store.orderCount('paper'),2);assert.equal(store.orders('paper')[0].budget,10);
  const previous=store.orders('paper')[1].prediction;
  assert.equal(previous.source,'polymarket_last_second');assert.equal(previous.priceAt,(start+299)*1000);
  releasePrices({round:start,conditionId:'condition',open:100,close:101,oracleWindow:60,source:'polymarket_event_metadata'});
  releaseSpot({...engine.spot,sourceId:'polymarket',windowSeconds:60});
  await Promise.all([...engine.roundPredictionTasks.values(),engine.spotTask]);
  assert.equal(store.roundPrediction(start).outcome,'DOWN');assert.equal(store.orders('paper')[1].prediction.won,false);
});

test('last-second selection excludes other windows, exchanges, older ticks and next-round prices',async t=>{
  const {engine,store,venue,start}=setup(t);enableAlignment(store,start,null);
  store.saveRoundOpening({round:start-300,conditionId:'prev',open:100,oracleWindow:60,observedAt:(start-300)*1000});
  store.tick(start*1000-1001,99,'polymarket',60);store.tick(start*1000,200,'polymarket',60);
  store.tick(start*1000-500,99,'binance',60);store.tick(start*1000-400,99,'polymarket',30);
  venue.roundPrices=async()=>null;
  assert.equal(await engine.getRoundPrediction(start-300),null);
  store.tick(start*1000-300,101,'polymarket',60);
  assert.equal((await engine.getRoundPrediction(start-300)).outcome,'UP');
});

test('a cold engine loads prices and markets when neither spot nor market exists yet',async t=>{
  const {engine,venue}=setup(t);
  const spot={...engine.spot,sourceId:'polymarket',windowSeconds:60},market={...engine.market},books={...engine.books};
  engine.spot=null;engine.market=null;engine.books={};
  venue.readiness=()=>({authenticated:false});venue.spot=async()=>spot;
  venue.market=async()=>market;venue.books=async()=>books;
  await engine.tick();await engine.spotTask;
  assert.equal(engine.market.round,market.round);assert.equal(engine.spot.round,spot.round);
  assert.equal(engine.store.roundOpening(spot.round).open,spot.currentOpen);
});

test('follow-at-open captures the prior closing tick and opening before rollover without waiting for current spot',async t=>{
  const {engine,store,venue,start,setNow}=setup(t);
  engine.configure('paper',{...store.account('paper').config,followPreviousAtOpen:true,sameDirectionOnly:true,entryDelay:0});
  setNow(start*1000+100);
  engine.spot={round:start-300,currentOpen:100,price:99,sourceId:'polymarket',windowSeconds:60,at:start*1000-1000};
  engine.market={round:start-300,conditionId:'previous-market'};
  const ticks=[{time:start*1000-1000,price:99,oracleWindow:60}];venue.drainPriceTicks=()=>ticks.splice(0);
  let releasePrices,releaseSpot;venue.roundPrices=()=>new Promise(resolve=>{releasePrices=resolve;});
  venue.spot=()=>new Promise(resolve=>{releaseSpot=resolve;});venue.readiness=()=>({authenticated:false});
  const market={round:start,active:true,fetchedAt:start*1000,slug:`btc-updown-5m-${start}`,conditionId:'current-market',
    outcomes:[{direction:'UP',index:0,assetId:'up'},{direction:'DOWN',index:1,assetId:'down'}],feeSchedule:{rate:.07,exponent:1}};
  venue.market=async()=>market;venue.books=async()=>({DOWN:{tickSize:.01,minOrderSize:1,fetchedAt:start*1000,asks:[{price:.5,size:1000}]}});
  await engine.start('paper');await engine.tick();
  assert.equal(store.orders('paper')[0].direction,'DOWN');assert.equal(store.orders('paper')[0].createdAt,start*1000+100);
  assert.equal(store.orders('paper')[0].referencePrice,null);assert.equal(store.orders('paper')[0].oracleWindow,null);
  assert.equal(store.roundPrediction(start-300).priceAt,start*1000-1000);
  releasePrices(null);releaseSpot({...engine.spot});await Promise.all([...engine.roundPredictionTasks.values(),engine.spotTask]);
});

test('an already obtained platform forecast takes priority over a conflicting last-second sample',async t=>{
  const {engine,store,start}=setup(t);enableAlignment(store,start,'UP');
  store.saveRoundOpening({round:start-300,conditionId:'previous-market',open:100,oracleWindow:60,observedAt:(start-300)*1000});
  store.tick(start*1000-1000,99,'polymarket',60);
  assert.equal((await engine.getRoundPrediction(start-300)).outcome,'UP');
  assert.equal(store.roundPrediction(start-300).source,'polymarket_event_metadata');
});
test('without platform ending prices official settlement still gates entry, loss doubles and win resets', async t => {
  const s = setup(t); const { engine, store, venue, start, setNow, fresh } = s;
  await engine.start('paper'); await engine.attempt('paper');
  setNow((start + 310) * 1000); fresh();
  await engine.attempt('paper'); assert.equal(store.orders('paper').length, 1);
  venue.resolution = async () => ({ payout: 0 });
  await engine.settlePending(); await engine.settlePending();
  assert.equal(store.account('paper').losses, 1); assert.equal(store.account('paper').pnl, -5);
  await engine.attempt('paper'); assert.equal(store.orders('paper')[0].budget, 10);
  setNow((start + 610) * 1000); fresh(); venue.resolution = async () => ({ payout: 1 });
  await engine.settlePending(); await engine.attempt('paper');
  assert.equal(store.account('paper').losses, 0); assert.equal(store.orders('paper')[0].budget, 5);
  assert.equal(store.account('paper').wins, 1); assert.equal(store.account('paper').settled, 2);
});

test('a predicted loss buys the next round at double stake without waiting or prematurely settling money',async t=>{
  const {engine,store,venue,start,setNow,fresh}=setup(t);
  await engine.start('paper');await engine.attempt('paper');
  const first=store.orders('paper')[0];
  setNow((start+305)*1000);fresh();
  venue.roundPrices=async o=>({round:o.round,conditionId:o.conditionId,open:100,close:99,source:'polymarket_event_metadata'});
  await engine.refreshPredictions();await engine.attempt('paper');await engine.attempt('paper');
  assert.equal(store.order(first.id).prediction.won,false);
  assert.equal(store.order(first.id).status,'open');assert.equal(store.order(first.id).pnl,null);
  assert.equal(store.order(first.id).settledAt,null);
  assert.equal(store.orders('paper').length,2);assert.equal(store.orders('paper')[0].budget,10);
  assert.equal(store.account('paper').balance,985);assert.equal(store.account('paper').pnl,0);
  assert.equal(store.account('paper').losses,0);assert.equal(engine.snapshot().accounts.paper.projectedLosses,1);
  venue.resolution=async()=>({payout:0});await engine.settlePending();
  assert.equal(store.account('paper').losses,1);assert.equal(engine.snapshot().accounts.paper.projectedLosses,1);
  assert.equal(store.order(first.id).prediction.matches,true);
});

test('several pending forecasts keep the sequence in order and official results cannot advance it twice',async t=>{
  const {engine,store,venue,start,setNow,fresh}=setup(t);
  await engine.start('paper');await engine.attempt('paper');
  venue.roundPrices=async o=>({round:o.round,conditionId:o.conditionId,open:100,close:99,source:'polymarket_event_metadata'});
  setNow((start+305)*1000);fresh();await engine.refreshPredictions();await engine.attempt('paper');
  setNow((start+605)*1000);fresh();await engine.refreshPredictions();await engine.attempt('paper');
  assert.deepEqual(store.orders('paper').map(o=>o.budget),[20,10,5]);
  let firstReady=false;
  venue.resolution=async o=>o.round===start&&!firstReady?null:{payout:0};
  await engine.settlePending();assert.equal(store.account('paper').settled,0);
  assert.equal(engine.snapshot().accounts.paper.nextAmount,20);
  firstReady=true;await engine.settlePending();await engine.settlePending();
  assert.equal(store.account('paper').settled,2);assert.equal(store.account('paper').losses,2);
  assert.equal(engine.snapshot().accounts.paper.nextAmount,20);
});

test('a predicted win resets the next stake without treating its unconfirmed payout as spendable balance',async t=>{
  const {engine,store,venue,start,setNow,fresh}=setup(t);
  store.saveAccount({...store.account('paper'),losses:2});
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(store.orders('paper')[0].budget,20);
  setNow((start+305)*1000);fresh();
  venue.roundPrices=async o=>({round:o.round,conditionId:o.conditionId,open:100,close:101,source:'polymarket_event_metadata'});
  await engine.refreshPredictions();await engine.attempt('paper');
  assert.equal(store.orders('paper')[0].budget,5);assert.equal(store.account('paper').balance,975);
  assert.equal(store.account('paper').pnl,0);assert.equal(store.account('paper').losses,2);
});

test('official disagreement keeps trading, retains prediction evidence and accounts the actual result once',async t=>{
  const {engine,store,venue,start,setNow,fresh}=setup(t);
  await engine.start('paper');await engine.attempt('paper');
  const first=store.orders('paper')[0];
  setNow((start+305)*1000);fresh();
  venue.roundPrices=async o=>({round:o.round,conditionId:o.conditionId,open:100,close:99,source:'polymarket_event_metadata'});
  await engine.refreshPredictions();await engine.attempt('paper');
  venue.resolution=async()=>({payout:1});await engine.settlePending();await engine.settlePending();
  assert.equal(store.account('paper').running,true);assert.equal(store.account('paper').reason,null);
  assert.ok(store.logs('paper').some(log=>/预计结果不一致.*继续运行/.test(log.message)));
  assert.equal(store.account('paper').settled,1);assert.equal(store.account('paper').wins,1);
  assert.equal(store.order(first.id).prediction.won,false);assert.equal(store.order(first.id).prediction.matches,false);
  setNow((start+605)*1000);fresh();await engine.refreshPredictions();await engine.attempt('paper');assert.equal(store.orderCount('paper'),3);
  assert.equal(store.orderForRound('paper',start+600).budget,10);
});

test('slow official resolution is polled in background and cannot hold up a forecast-based next entry',async t=>{
  const {engine,store,venue,start,setNow,fresh}=setup(t);
  await engine.start('paper');await engine.attempt('paper');
  setNow((start+305)*1000);fresh();
  venue.roundPrices=async o=>({round:o.round,conditionId:o.conditionId,open:100,close:99,source:'polymarket_event_metadata'});
  venue.readiness=()=>({authenticated:false});venue.spot=async()=>engine.spot;
  venue.market=async()=>engine.market;venue.books=async()=>engine.books;
  let release;venue.resolution=()=>new Promise(resolve=>{release=resolve;});
  await engine.tick();
  assert.equal(typeof release,'function');assert.equal(store.orderCount('paper'),2);
  assert.equal(store.orders('paper')[0].budget,10);
  release(null);await engine.settlementTask;
});

test('missing platform ending price never borrows live or next-round prices and records the skip reason',async t=>{
  const {engine,store,venue,start,setNow,fresh}=setup(t);
  await engine.start('paper');await engine.attempt('paper');
  setNow((start+305)*1000);fresh();
  engine.spot.previousClose=99;engine.spot.currentOpen=99;engine.spot.price=98;
  venue.roundPrices=async()=>null;
  await engine.refreshPredictions();await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),1);assert.equal(store.orders('paper')[0].prediction,null);
  assert.match(engine.status.paper,/等待上一场起止价预测/);
  setNow((start+350)*1000);await engine.attempt('paper');
  assert.match(engine.status.paper,/已过入场窗口.*等待上一场起止价预测/);
});

test('forecast continuation restarts the cycle at the amount cap and does not spend an expected winner payout',async t=>{
  const {engine,store,venue,start,setNow,fresh}=setup(t);
  store.saveAccount({...store.account('paper'),balance:5});
  await engine.start('paper');await engine.attempt('paper');
  setNow((start+305)*1000);fresh();
  venue.roundPrices=async o=>({round:o.round,conditionId:o.conditionId,open:100,close:101,source:'polymarket_event_metadata'});
  await engine.refreshPredictions();await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),1);assert.equal(store.account('paper').balance,0);
  assert.equal(store.account('paper').running,true);assert.match(engine.status.paper,/余额不足/);
  store.saveAccount({...store.account('paper'),balance:1000,running:true,config:{...store.account('paper').config,maxAmount:5}});
  // A persisted forecast is immutable; use a separate later-round order for the losing prediction.
  store.reserveOrder({...store.orders('paper')[0],id:'loss-limit',round:start+300,end:start+600,prediction:undefined});
  store.savePrediction({orderId:'loss-limit',open:100,close:99,outcome:'DOWN',won:false,
    source:'polymarket_event_metadata',observedAt:(start+600)*1000});
  setNow((start+605)*1000);fresh();await engine.attempt('paper');
  assert.equal(store.orderCount('paper'),3);assert.equal(store.orders('paper')[0].budget,5);
  assert.equal(store.account('paper').running,true);
});

test('predicted losses roll 5,10,20,5 continuously and delayed settlements do not repeat the cap reset',async t=>{
  const {engine,store,venue,start,setNow,fresh}=setup(t);
  engine.configure('paper',{...store.account('paper').config,maxAmount:32});
  venue.roundPrices=async o=>({round:o.round,conditionId:o.conditionId,open:100,close:99,source:'polymarket_event_metadata'});
  await engine.start('paper');await engine.attempt('paper');
  for(const seconds of [305,605,905]){
    setNow((start+seconds)*1000);fresh();await engine.refreshPredictions();await engine.attempt('paper');
  }
  assert.deepEqual(store.orders('paper').map(o=>o.budget),[5,20,10,5]);
  assert.equal(store.account('paper').running,true);assert.equal(store.account('paper').pnl,0);
  assert.equal(engine.snapshot().accounts.paper.projectedCycle,2);assert.equal(engine.snapshot().accounts.paper.projectedLosses,0);
  assert.equal(store.account('paper').balance,960);
  venue.resolution=async()=>({payout:0});await engine.settlePending();await engine.settlePending();
  assert.equal(store.account('paper').settled,3);assert.equal(store.account('paper').cycle,2);
  assert.equal(store.account('paper').losses,0);assert.equal(store.account('paper').pnl,-35);
  assert.equal(engine.snapshot().accounts.paper.nextAmount,5);assert.equal(store.account('paper').running,true);
});

test('an account paused by the former amount-cap rule can restart from base and persists that new cycle once',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pulse-cap-'));const path=join(dir,'test.sqlite');
  let store=new Store(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const original=store.account('paper');
  store.saveAccount({...original,losses:3,pnl:-35,cyclePnl:-35,balance:965,
    config:{...original.config,baseAmount:5,maxAmount:32},reason:'下一笔金额超过单笔上限，策略已暂停'});
  let engine=new Engine(store,{readiness:()=>({enabled:false})});
  await engine.start('paper');
  assert.equal(store.account('paper').running,true);assert.equal(store.account('paper').losses,0);
  assert.equal(store.account('paper').cycle,2);assert.equal(store.account('paper').cyclePnl,0);
  assert.equal(store.account('paper').pnl,-35);assert.equal(store.account('paper').balance,965);
  store.close();store=new Store(path);engine=new Engine(store,{readiness:()=>({enabled:false})});
  await engine.start('paper');assert.equal(store.account('paper').cycle,2);assert.equal(engine.snapshot().accounts.paper.nextAmount,5);
});

test('live forecast continuation still requires a confirmed fill and posts the next round only once',async t=>{
  const {engine,store,venue,start,setNow,fresh,buys}=setup(t,'live');
  await engine.start('live');await engine.attempt('live');
  setNow((start+305)*1000);fresh();
  venue.roundPrices=async o=>({round:o.round,conditionId:o.conditionId,open:100,close:99,source:'polymarket_event_metadata'});
  await engine.refreshPredictions();await engine.attempt('live');assert.equal(buys(),1);
  venue.reconcile=async()=>({shares:9.6,cost:5,fee:.2,price:.5});
  await engine.settlePending();await engine.refreshPredictions();
  await engine.attempt('live');await engine.attempt('live');
  assert.equal(buys(),2);assert.equal(store.orders('live')[0].budget,10);
  assert.equal(store.account('live').settled,0);
});
test('stale prices, stale books, unavailable market and late entry cause no purchase', async t => {
  const s = setup(t); const { engine, store, setNow, fresh, start } = s;
  await engine.start('paper'); engine.spot.at -= 7000; await engine.attempt('paper');
  fresh(); engine.books.UP.fetchedAt -= 7000; await engine.attempt('paper');
  fresh(); engine.market.active = false; await engine.attempt('paper');
  setNow((start + 90) * 1000); fresh(); await engine.attempt('paper');
  assert.equal(store.orders('paper').length, 0);
});

test('a missing current-round opening blocks entry even if a previous-round direction was supplied', async t => {
  const { engine, store } = setup(t);
  await engine.start('paper'); engine.spot.currentOpen = null;
  await engine.attempt('paper');
  assert.equal(store.orders('paper').length, 0);
  assert.match(engine.status.paper, /本场起始价/);
});

test('new orders record this round opening as the reference without netting the previous round movement', async t => {
  const { engine, store } = setup(t);
  engine.spot.previousOpen = 90; engine.spot.currentOpen = 100;
  await engine.start('paper'); await engine.attempt('paper');
  const order = store.orders('paper')[0];
  assert.equal(order.referencePrice, 100); assert.equal(order.signalRule, 'current_round_open');
});
test('network failure after live submission keeps the strategy running, reconciles and never resubmits an unknown order', async t => {
  const s = setup(t, 'live'); const { engine, store, venue,start,setNow,fresh } = s; let attempts = 0;
  venue.buy = async () => { attempts++; throw new Error('timeout'); };
  await engine.start('live'); await engine.attempt('live'); await engine.attempt('live');
  assert.equal(attempts, 1); assert.equal(store.orders('live')[0].status, 'uncertain');
  assert.equal(store.account('live').running, true);
  await engine.start('live');setNow((start+305)*1000);fresh();await engine.attempt('live');
  assert.equal(attempts,1);assert.equal(store.entryBlock('live',start+300).code,'ORDER_UNCONFIRMED');
  venue.reconcile=async()=>({rejected:true,note:'官方确认未成交'});await engine.settlePending();await engine.attempt('live');
  assert.equal(attempts,2);assert.equal(store.account('live').running,true);
});
test('live accepted response is not assumed filled until confirmed trades are reconciled', async t => {
  const s = setup(t, 'live'); const { engine, store, venue, setNow, start } = s;
  await engine.start('live'); await engine.attempt('live');
  setNow((start + 310) * 1000); venue.resolution = async () => ({ payout: 0 });
  await engine.settlePending(); assert.equal(store.orders('live')[0].status, 'confirming');
  assert.equal(store.account('live').settled, 0);
  venue.reconcile = async () => ({ shares: 9.6, cost: 5, fee: .2, price: .5 });
  await engine.settlePending(); assert.equal(store.orders('live')[0].status, 'lost');
  assert.equal(store.account('live').pnl, -5);
});
test('venue rejecting a live order does not count as a losing trade or permit another buy in that round', async t => {
  const { engine, store, venue } = setup(t, 'live');
  venue.buy = async () => ({ ok: false, message: 'insufficient liquidity' });
  await engine.start('live'); await engine.attempt('live'); await engine.start('live'); await engine.attempt('live');
  assert.equal(store.orders('live').length, 1); assert.equal(store.orders('live')[0].status, 'rejected');
  assert.equal(store.account('live').losses, 0);
});
test('pause during async wallet balance check prevents a queued live purchase', async t => {
  const { engine, store, venue, buys } = setup(t, 'live');
  await engine.start('live');
  let release;
  venue.balance = () => new Promise(resolve => { release = resolve; });
  const attempt = engine.attempt('live'); engine.stop('live'); release(1000); await attempt;
  assert.equal(buys(), 0); assert.equal(store.orders('live').length, 0);
});

test('each blocked quote preserves the exact book and numeric cause, throttles repetitive logs, and records the entry deadline once',async t=>{
  const {engine,store,start,setNow,fresh}=setup(t);
  engine.configure('paper',{...store.account('paper').config,maxPrice:.49});await engine.start('paper');
  const balance=store.account('paper').balance;
  for(let index=0;index<3;index++){
    setNow((start+10+index)*1000);fresh();engine.books.UP.asks[0].price=String(.5+index*.01);
    await engine.attempt('paper');
    const block=store.entryBlock('paper',start,{withBook:true});
    assert.equal(block.code,'MAX_PRICE_BELOW_BEST_ASK');assert.equal(block.bestAsk,.5+index*.01);
    assert.equal(block.maxPrice,.49);assert.equal(block.budget,5);assert.equal(block.book.asks[0].price,.5+index*.01);
    assert.doesNotMatch(block.message,/或/);
  }
  assert.equal(store.db.prepare('SELECT count(*) n FROM entry_diagnostics').get().n,3);
  assert.equal(store.logs('paper').filter(log=>log.message.startsWith('本场暂未买入')).length,1);
  setNow((start+42)*1000);fresh();await engine.attempt('paper');
  assert.equal(store.logs('paper').filter(log=>log.message.startsWith('本场暂未买入')).length,2);
  setNow((start+46)*1000);await engine.attempt('paper');
  const cutoff=store.entryBlock('paper',start,{withBook:true});
  assert.equal(cutoff.code,'ENTRY_WINDOW_CLOSED');assert.match(cutoff.message,/46.000 秒 > 截止 45 秒.*卖一价超过最高买价/);
  assert.equal(cutoff.previous.code,'MAX_PRICE_BELOW_BEST_ASK');assert.equal(cutoff.previous.book.asks[0].price,.5);
  const count=store.db.prepare('SELECT count(*) n FROM entry_diagnostics').get().n;
  setNow((start+70)*1000);await engine.attempt('paper');
  assert.equal(store.db.prepare('SELECT count(*) n FROM entry_diagnostics').get().n,count);
  assert.equal(store.account('paper').balance,balance);assert.equal(store.orderCount('paper'),0);assert.equal(store.hasRound('paper',start),false);
});

for(const item of [
  {code:'SPOT_MISSING',change:engine=>{engine.spot=null;},text:/未收到 BTC/},
  {code:'SPOT_WRONG_ROUND',change:engine=>{engine.spot.round-=300;},text:/行情场次不匹配/},
  {code:'SPOT_STALE',change:engine=>{engine.spot.at-=7000;},text:/7000 毫秒.*6000 毫秒.*1000 毫秒/},
  {code:'SPOT_FETCH_ERROR',change:engine=>{engine.errors.spot='HTTP 502';},text:/行情请求失败：HTTP 502/},
  {code:'MARKET_INACTIVE',change:engine=>{engine.market.active=false;engine.market.marketState={active:true,closed:false,acceptingOrders:false};},text:/acceptingOrders=false/},
  {code:'MARKET_STALE',change:engine=>{engine.market.fetchedAt-=21000;},text:/21000 毫秒.*20000 毫秒/},
  {code:'OPENING_PRICE_MISSING',change:engine=>{engine.spot.currentOpen=null;},text:/起始价=null/},
  {code:'BOOK_MISSING',change:engine=>{engine.books={};},text:/缺少 UP 盘口/},
  {code:'BOOK_FETCH_ERROR',change:engine=>{engine.errors.books='HTTP 503';},text:/盘口请求失败：HTTP 503/},
  {code:'BOOK_STALE',change:engine=>{engine.books.UP.fetchedAt-=7000;},text:/盘口过期.*7000 毫秒.*6000 毫秒/},
])test(`diagnostics identify ${item.code} separately and retain its concrete evidence`,async t=>{
  const {engine,store,start}=setup(t);await engine.start('paper');item.change(engine);await engine.attempt('paper');
  const block=store.entryBlock('paper',start);assert.equal(block.code,item.code);assert.match(block.message,item.text);assert.doesNotMatch(block.message,/或/);
  assert.equal(store.orderCount('paper'),0);
});

test('small-budget blocking reasons are retained after the entry window and do not consume the round', async t => {
  const { engine, store, start, setNow } = setup(t);
  const account = store.account('paper');
  store.saveAccount({ ...account, config: { ...account.config, baseAmount: 2 } });
  engine.books.UP.minOrderSize = 5;
  await engine.start('paper'); await engine.attempt('paper');
  assert.match(engine.status.paper, /低于最小 5 份/);
  assert.equal(store.orders('paper').length, 0);
  setNow((start + 60) * 1000); await engine.attempt('paper');
  assert.match(engine.status.paper, /已过入场窗口.*低于最小 5 份/);
  assert.ok(store.logs('paper').some(log => log.message.includes('本场暂未买入')));
});

test('a $2 simulated order triggers once when the executable price provides enough shares', async t => {
  const { engine, store } = setup(t);
  const account = store.account('paper');
  store.saveAccount({ ...account, config: { ...account.config, baseAmount: 2 } });
  engine.books.UP = { ...engine.books.UP, minOrderSize: 5, asks: [{ price: '.30', size: '1000' }] };
  await engine.start('paper'); await engine.attempt('paper'); await engine.attempt('paper');
  assert.equal(store.orders('paper').length, 1);
  assert.equal(store.orders('paper')[0].cost, 2);
  assert.ok(store.orders('paper')[0].shares >= 5);
});

test('oracle charts exclude the previous exchange price history', t => {
  const { store } = setup(t);
  store.tick(1800000000000, 74000, 'binance');
  store.tick(1800000001000, 74100, 'polymarket');
  assert.deepEqual(store.ticks().map(row => ({ ...row })), [{ time: 1800000001000, price: 74100 }]);
});

test('early signals are recorded while trading is paused and are not overwritten by later prices', async t => {
  const { engine, store, venue, start } = setup(t);
  venue.readiness = () => ({ authenticated:false });
  venue.market = async () => engine.market;
  venue.books = async () => engine.books;
  venue.spot = async () => ({ round:start, previousOpen:80, currentOpen:100, price:99, direction:'DOWN',
    sourceId:'polymarket', windowSeconds:60, at:(start + 6) * 1000 });
  await engine.tick();
  assert.equal(store.account('paper').running, false);
  assert.equal(store.orders('paper').length, 0);
  assert.equal(store.initialSignal(start).direction, 'DOWN');
  venue.spot = async () => ({ round:start, previousOpen:80, currentOpen:100, price:101, direction:'UP',
    sourceId:'polymarket', windowSeconds:60, at:(start + 8) * 1000 });
  await engine.tick();
  assert.equal(store.initialSignal(start).direction, 'DOWN');
});

test('paused sampling records paper and live entry delays independently instead of fixing both at five seconds', async t => {
  const {engine,store,venue,start,setNow}=setup(t);
  store.saveAccount({...store.account('paper'),config:{...store.account('paper').config,entryDelay:10}});
  venue.readiness=()=>({authenticated:false});
  venue.market=async()=>engine.market; venue.books=async()=>engine.books;
  let seconds=5,price=99;
  venue.spot=async()=>({round:start,currentOpen:100,price,sourceId:'polymarket',windowSeconds:60,at:(start+seconds)*1000});
  setNow((start+seconds)*1000); await engine.tick();
  assert.equal(store.initialSignal(start,5).direction,'DOWN'); assert.equal(store.initialSignal(start,10),null);
  seconds=10; price=101; setNow((start+seconds)*1000); await engine.tick();
  assert.equal(store.initialSignal(start,10).direction,'UP'); assert.equal(store.initialSignal(start,5).direction,'DOWN');
  assert.equal(store.account('paper').running,false); assert.equal(store.orders('paper').length,0);
});

test('all requested time points and a custom entry delay are archived while both strategies are paused', async t => {
  const {engine,store,venue,start,setNow}=setup(t);
  const targets=[5,10,15,20,35,40,45,50,55,60];
  store.saveAccount({...store.account('paper'),config:{...store.account('paper').config,entryDelay:25}});
  venue.readiness=()=>({authenticated:false});
  venue.market=async()=>engine.market; venue.books=async()=>engine.books;
  venue.drainPriceTicks=()=>[...targets,25].map(seconds=>({time:(start+seconds)*1000,price:100+seconds}));
  venue.spot=async()=>({round:start,currentOpen:100,price:160,sourceId:'polymarket',windowSeconds:60,at:(start+60)*1000});
  setNow((start+60)*1000); await engine.tick();
  for(const seconds of [...targets,25]) {
    const signal=store.initialSignal(start,seconds);
    assert.equal(signal.targetSeconds,seconds); assert.equal(signal.observedAt,(start+seconds)*1000);
    assert.equal(signal.price,100+seconds); assert.equal(signal.referencePrice,100);
    assert.equal(signal.oracleWindow,60); assert.equal(signal.direction,'UP');
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM round_signals').get().n,11);
  assert.equal(store.orderCount('paper'),0); assert.equal(store.orderCount('live'),0);
});
test('configuration edits preserve losing streak and cannot modify active/pending orders', async t => {
  const { engine, store } = setup(t);
  store.saveAccount({ ...store.account('paper'), losses: 2, pnl: -15 });
  engine.configure('paper', { ...store.account('paper').config, baseAmount: 7 });
  assert.equal(store.account('paper').losses, 2);
  await engine.start('paper'); assert.throws(() => engine.configure('paper', { baseAmount: 5 }), /暂停/);
  await engine.attempt('paper'); engine.stop('paper'); assert.throws(() => engine.resetPaper(), /持仓结算/);
});
test('nonbinary payouts are accounted once and keep the strategy running without inventing a loss', async t => {
  const { engine, store, venue, setNow, start } = setup(t);
  await engine.start('paper'); await engine.attempt('paper'); setNow((start + 310) * 1000);
  venue.resolution = async () => ({ payout: .5 }); await engine.settlePending(); await engine.settlePending();
  assert.equal(store.orders('paper')[0].status, 'void'); assert.equal(store.account('paper').running, true);
  assert.equal(store.account('paper').losses, 0); assert.equal(store.account('paper').settled, 0);
  assert.ok(store.account('paper').balance < 1000);
});
test('SQLite restart preserves streak and unique rounds, stops strategies, and recovers crash reservations', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'test.sqlite'); let store = new Store(file);
  store.saveAccount({ ...store.account('paper'), running: true, losses: 3, pnl: -35 });
  store.saveInitialSignal({ round: 123, direction: 'DOWN', observedAt: 128000 });
  for (const mode of ['paper', 'live']) store.reserveOrder({ id: mode, mode, round: 123, session: 'session', status: 'placing' });
  store.close(); store = new Store(file);
  try {
    assert.equal(store.account('paper').running, false); assert.equal(store.account('paper').losses, 3);
    assert.equal(store.initialSignal(123).direction, 'DOWN');
    assert.equal(store.order('paper').status, 'rejected'); assert.equal(store.order('live').status, 'uncertain');
    assert.equal(store.reserveOrder({ id: 'second', mode: 'paper', round: 123, session: 'new', status: 'placing' }), false);
  } finally { store.close(); }
});

test('wallet errors during startup and entry leave the strategy running and recover without another start',async t=>{
  const {engine,store,venue,buys,start}=setup(t,'live');
  venue.balance=async()=>{throw Error('wallet timeout');};
  await engine.start('live');assert.equal(store.account('live').running,true);
  await engine.attempt('live');assert.equal(buys(),0);assert.equal(store.entryBlock('live',start).code,'WALLET_CHECK_FAILED');
  venue.balance=async()=>1000;await engine.attempt('live');assert.equal(buys(),1);assert.equal(store.account('live').running,true);
});

test('a rejected live order skips that round and automatically attempts the next without a restart',async t=>{
  const {engine,store,venue,start,setNow,fresh}=setup(t,'live');let submissions=0;
  venue.buy=async()=>{submissions++;return {ok:false,message:'official rejection'};};
  await engine.start('live');await engine.attempt('live');await engine.attempt('live');
  assert.equal(submissions,1);assert.equal(store.account('live').running,true);
  setNow((start+305)*1000);fresh();await engine.attempt('live');assert.equal(submissions,2);
  assert.equal(store.account('live').losses,0);
});

test('insufficient funds remain a retried entry condition and recover after funds become available',async t=>{
  const {engine,store,start}=setup(t);store.saveAccount({...store.account('paper'),balance:2});
  await engine.start('paper');await engine.attempt('paper');
  assert.equal(store.account('paper').running,true);assert.equal(store.orderCount('paper'),0);assert.equal(store.entryBlock('paper',start).code,'RISK_LIMIT');
  store.saveAccount({...store.account('paper'),balance:1000});await engine.attempt('paper');assert.equal(store.orderCount('paper'),1);
});

test('one mode throwing cannot stop another mode or prevent the next tick from recovering',async t=>{
  const {engine,store,venue}=setup(t);venue.readiness=()=>({enabled:true,configured:true,authenticated:false});
  venue.market=async()=>engine.market;venue.spot=async()=>engine.spot;venue.books=async()=>engine.books;
  await engine.start('paper');await engine.start('live');const attempt=engine.attempt.bind(engine);let failures=1;
  engine.attempt=async mode=>{if(mode==='paper'&&failures-->0)throw Error('temporary local error');return attempt(mode);};
  await engine.tick();assert.equal(store.account('paper').running,true);assert.equal(store.account('live').running,true);
  assert.equal(store.orderCount('paper'),0);assert.equal(store.orderCount('live'),1);
  await engine.tick();assert.equal(store.orderCount('paper'),1);
});

test('failed paper fill transaction rolls back money, preserves deduplication and recovers for the next round',async t=>{
  const {engine,store,start,setNow,fresh}=setup(t);await engine.start('paper');
  const save=store.saveAccount.bind(store);let fail=true;
  store.saveAccount=account=>{if(fail&&account.mode==='paper'&&account.balance<1000){fail=false;throw Error('temporary write failure');}return save(account);};
  await assert.rejects(engine.attempt('paper'),/temporary write failure/);
  assert.equal(store.account('paper').running,true);assert.equal(store.account('paper').balance,1000);
  await engine.attempt('paper');assert.equal(store.orderForRound('paper',start).status,'rejected');
  setNow((start+305)*1000);fresh();await engine.attempt('paper');
  assert.equal(store.orderForRound('paper',start+300).status,'open');assert.equal(store.account('paper').balance,995);
});

test('settlement errors retry and later account the result once while preserving a manual pause',async t=>{
  const {engine,store,venue,start,setNow}=setup(t);await engine.start('paper');await engine.attempt('paper');
  setNow((start+305)*1000);venue.resolution=async()=>{throw Error('resolution timeout');};
  await engine.settlePending();assert.equal(store.account('paper').running,true);assert.equal(store.account('paper').settled,0);
  engine.stop('paper');venue.resolution=async()=>({payout:0.5});await engine.settlePending();await engine.settlePending();
  assert.equal(store.account('paper').running,false);assert.equal(store.orderForRound('paper',start).status,'void');
});

test('a failing state observer cannot throw out of a tick or turn a strategy off',async t=>{
  const {engine,store}=setup(t);await engine.start('paper');t.mock.method(console,'error',()=>{});
  const broken=()=>{throw Error('closed observer');};engine.on('update',broken);
  assert.doesNotThrow(()=>engine.broadcast());assert.equal(store.account('paper').running,true);
  engine.off('update',broken);assert.doesNotThrow(()=>engine.broadcast());
});

test('rejected background forecasts are logged and retried without ending the running strategy',async t=>{
  const {engine,store}=setup(t);await engine.start('paper');let calls=0;
  engine.refreshPredictions=async()=>{calls++;throw Error('temporary prediction read error');};
  engine.refreshPreviousPrediction=async()=>{throw Error('temporary prior prediction error');};
  engine.pollPredictions();await new Promise(resolve=>setImmediate(resolve));
  engine.pollPredictions();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2);assert.equal(store.account('paper').running,true);
  assert.ok(store.logs('paper').some(log=>log.message.includes('temporary prediction read error')));
});
