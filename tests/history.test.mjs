import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistoricalRound, RoundHistory } from '../server/history.mjs';
import { roundStart } from '../server/strategy.mjs';
import { Store } from '../server/store.mjs';
import {summarizeHistory} from '../src/history-summary.mjs';

function fixture(round, { open = 74500, close = 74520, labels = ['Up', 'Down'], payouts = ['1', '0'], status = 'resolved' } = {}) {
  const slug = `btc-updown-5m-${round}`, conditionId = `condition-${round}`;
  return {
    event: { slug, eventMetadata: { priceToBeat: open, finalPrice: close },
      markets: [{ slug, conditionId, outcomes: JSON.stringify(labels) }] },
    resolution: { conditionId, status, payouts },
  };
}

test('round result follows official payout labels even when reference-price movement points the other way', () => {
  const { event, resolution } = fixture(1800000000, { labels: ['Down', 'Up'], payouts: ['1', '0'] });
  const item = normalizeHistoricalRound(1800000000, event, resolution);
  assert.equal(item.result, 'DOWN'); assert.equal(item.status, 'resolved');
  assert.equal(item.open, 74500); assert.equal(item.close, 74520); assert.equal(item.change, 20);
});

test('no price movement or quoted outcome price can finalize an unresolved round', () => {
  const { event, resolution } = fixture(1800000000, { status: 'proposed' });
  event.markets[0].outcomePrices = '["1","0"]';
  const item = normalizeHistoricalRound(1800000000, event, resolution);
  assert.equal(item.result, null); assert.equal(item.status, 'pending');
  assert.equal(item.close, 74520); assert.equal(item.change, 20);
});

test('invalid prices stay missing and split payouts do not produce invented red or green winners', () => {
  const { event, resolution } = fixture(1800000000, { open: null, close: 'invalid', payouts: ['0.5', '0.5'] });
  const item = normalizeHistoricalRound(1800000000, event, resolution);
  assert.equal(item.result, null); assert.equal(item.status, 'void');
  assert.equal(item.open, null); assert.equal(item.close, null); assert.equal(item.change, null);
  resolution.payouts = ['1', '1'];
  assert.equal(normalizeHistoricalRound(1800000000, event, resolution).status, 'pending');
});

test('history keeps exactly 40 completed windows oldest first and caches finalized results across refreshes', async () => {
  let now = 1800000010000, requests = 0;
  const batches = [];
  const venue = {
    fetch: async url => {
      requests++;
      const slugs = new URL(url).searchParams.getAll('slug');
      batches.push(slugs);
      return { ok: true, json: async () => slugs.map(slug => fixture(Number(slug.split('-').at(-1))).event) };
    },
    public: { fetchResolutions: async ({ conditionIds }) => conditionIds.map(conditionId => ({ conditionId, status: 'resolved', payouts: ['1', '0'] })) },
  };
  const history = new RoundHistory(venue, { now: () => now });
  const first = await history.read();
  assert.equal(first.items.length, 40);
  assert.equal(first.items[0].round, roundStart(now) - 12000);
  assert.equal(first.items.at(-1).round, roundStart(now) - 300);
  assert.ok(first.items.every(item => item.result === 'UP'));
  now += 20000; await history.read(); assert.equal(requests, 1);
  now += 300000;
  const next = await history.read();
  assert.equal(requests, 2); assert.equal(batches[1].length, 1);
  assert.equal(next.items.length, 40); assert.equal(next.items.at(-1).round, roundStart(now) - 300);
});

test('failed history refresh retains previously finalized results and does not hide the missing new window', async () => {
  let now = 1800000010000, failing = false;
  const venue = {
    fetch: async url => {
      if (failing) throw new Error('history timeout');
      return { ok: true, json: async () => new URL(url).searchParams.getAll('slug').map(slug => fixture(Number(slug.split('-').at(-1))).event) };
    },
    public: { fetchResolutions: async ({ conditionIds }) => conditionIds.map(conditionId => ({ conditionId, status: 'resolved', payouts: ['0', '1'] })) },
  };
  const history = new RoundHistory(venue, { now: () => now });
  await history.read(); failing = true; now += 300000;
  const next = await history.read();
  assert.equal(next.items.filter(item => item.result === 'DOWN').length, 39);
  assert.equal(next.items.at(-1).status, 'loading');
  assert.match(next.error, /history timeout/);
});

test('concurrent page reads share one history refresh and pending rounds are retried', async () => {
  let now = 1800000010000, requests = 0, resolved = false;
  const venue = {
    fetch: async url => {
      requests++; await new Promise(resolve => setTimeout(resolve, 5));
      return { ok: true, json: async () => new URL(url).searchParams.getAll('slug').map(slug => fixture(Number(slug.split('-').at(-1))).event) };
    },
    public: { fetchResolutions: async ({ conditionIds }) => conditionIds.map(conditionId => ({ conditionId, status: resolved ? 'resolved' : 'proposed', payouts: ['1', '0'] })) },
  };
  const history = new RoundHistory(venue, { now: () => now });
  const [first, second] = await Promise.all([history.read(), history.read()]);
  assert.equal(requests, 1); assert.deepEqual(first, second);
  assert.ok(first.items.every(item => item.status === 'pending'));
  resolved = true; now += 16000;
  assert.ok((await history.read()).items.every(item => item.result === 'UP'));
  assert.equal(requests, 2);
});

test('history shows last-second evidence while pending, then replaces display prices and compares against official results without changing trading forecasts',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const round=1799999700;let now=(round+310)*1000,close=null,resolved=false;
  store.saveRoundOpening({round,conditionId:`condition-${round}`,open:100,oracleWindow:60,observedAt:round*1000});
  store.tick((round+299)*1000,99,'polymarket',60);
  const venue={fetch:async()=>({ok:true,json:async()=>[fixture(round,{open:100,close}).event]}),
    public:{fetchResolutions:async()=>[fixture(round,{payouts:['1','0'],status:resolved?'resolved':'proposed'}).resolution]}};
  const history=new RoundHistory(venue,{store,now:()=>now}),account=store.account('paper');
  let item=(await history.read()).items.at(-1);
  assert.equal(item.status,'pending');assert.equal(item.result,null);assert.equal(item.close,99);assert.equal(item.change,-1);
  assert.equal(item.closeSource,'polymarket_last_second');assert.equal(item.closeAt,(round+299)*1000);
  assert.equal(item.forecast.outcome,'DOWN');assert.equal(item.forecastMatches,null);assert.equal(item.reversal,null);
  assert.equal(store.historicalRound(round).close,null);assert.equal(store.roundPrediction(round),null);
  const tradePrediction=store.saveRoundPrediction({...item.forecast,conditionId:`condition-${round}`,observedAt:now});
  close=101;now+=16000;item=(await history.read()).items.at(-1);
  assert.equal(item.status,'pending');assert.equal(item.result,null);assert.equal(item.close,101);assert.equal(item.change,1);
  assert.equal(item.closeSource,'polymarket_event_metadata');assert.equal(item.forecast.close,99);
  assert.equal(item.forecastMatches,false);assert.equal(item.forecastComparisonSource,'platform_prices');
  resolved=true;now+=16000;item=(await history.read()).items.at(-1);
  assert.equal(item.result,'UP');assert.equal(item.status,'resolved');assert.equal(item.forecastMatches,false);
  assert.equal(item.forecastComparisonSource,'official_result');assert.equal(item.forecastComparison,'UP');
  const restarted=new RoundHistory({fetch:async()=>{throw Error('offline');}},{store,now:()=>now});
  const restored=(await restarted.read()).items.at(-1);
  assert.equal(restored.close,101);assert.equal(restored.forecastMatches,false);assert.equal(restored.forecast.close,99);
  assert.deepEqual(store.roundPrediction(round),tradePrediction);assert.deepEqual(store.account('paper'),account);
  assert.equal(store.orderCount('paper'),0);
});

test('historical fallback uses archived signal reference only with an unambiguous oracle window and a tick strictly inside the last second',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const round=1799999700,now=(round+310)*1000;
  store.saveInitialSignal({round,targetSeconds:5,observedAt:(round+5)*1000,referencePrice:100,price:101,
    direction:'UP',rule:'current_round_open',source:'polymarket',oracleWindow:60});
  store.tick((round+298)*1000,99,'polymarket',60);
  store.tick((round+300)*1000,99,'polymarket',60);
  store.tick((round+299)*1000,99,'binance',60);
  store.tick((round+299)*1000+100,99,'polymarket',30);
  store.tick((round+299)*1000+200,99,'polymarket');
  const history=new RoundHistory({}, {store,now:()=>now});
  let item=history.snapshot().items.at(-1);
  assert.equal(item.close,null);assert.equal(item.forecast,null);
  store.tick((round+299)*1000+300,101,'polymarket',60);
  item=history.snapshot().items.at(-1);
  assert.equal(item.open,100);assert.equal(item.close,101);assert.equal(item.forecast.outcome,'UP');
  history.cache.set(round,{round,end:round+300,status:'resolved',result:'UP',open:100,close:102});
  assert.equal(history.snapshot().items.at(-1).forecastMatches,true);
  history.cache.set(round,{round,end:round+300,status:'void',result:null,open:100,close:102});
  assert.equal(history.snapshot().items.at(-1).forecastMatches,false);
  store.saveInitialSignal({round,targetSeconds:10,observedAt:(round+10)*1000,referencePrice:100,price:101,
    direction:'UP',rule:'current_round_open',source:'polymarket',oracleWindow:30});
  assert.equal(history.snapshot().items.at(-1).forecast,null);
});


test('history counts match displayed official results and exclude pending forecasts and void rounds',()=>{
  const items=[{result:'UP',status:'resolved'},{result:'DOWN',status:'resolved'},
    {result:null,status:'pending',forecast:{outcome:'UP'}},{status:'loading'},{status:'unavailable'},{status:'void'}];
  assert.deepEqual(summarizeHistory(items),{up:1,down:1,pending:3,void:1});
  items[2]={result:'DOWN',status:'resolved',forecast:{outcome:'UP'}};
  assert.deepEqual(summarizeHistory(items),{up:1,down:2,pending:2,void:1});
});
