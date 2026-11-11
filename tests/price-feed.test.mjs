import test from 'node:test';
import assert from 'node:assert/strict';
import { oracleSpec, decodePriceFrame,PolymarketPriceFeed } from '../server/price-feed.mjs';
import { Polymarket } from '../server/polymarket.mjs';
import { roundStart } from '../server/strategy.mjs';

const spec = oracleSpec({ asset: 'btc', twapEnabled: true, twapLookbackSeconds: 60 });

test('market oracle configuration selects TWAP instead of silently using spot', () => {
  assert.equal(spec.topic, 'crypto_prices_twap_sixty');
  assert.equal(spec.seconds, 60);
  assert.throws(() => oracleSpec(null), /配置/);
  assert.throws(() => oracleSpec({ asset: 'btc', twapEnabled: true, twapLookbackSeconds: 120 }), /不支持/);
});

test('RTDS decoding rejects the wrong oracle, window, symbol and future data and converts E18 correctly', () => {
  const now = 1800000010000;
  const frame = { topic: spec.topic, payload: { symbol: 'btc/usd', window_s: 60,
    data: [{ timestamp: now - 1000, full_accuracy_value: '74136836977531417526272', value: 1 }] } };
  const [point] = decodePriceFrame(frame, spec, now);
  assert.ok(Math.abs(point.price - 74136.83697753142) < 1e-8);
  assert.equal(decodePriceFrame({ ...frame, topic: 'crypto_prices_chainlink' }, spec, now).length, 0);
  assert.equal(decodePriceFrame({ ...frame, payload: { ...frame.payload, symbol: 'eth/usd' } }, spec, now).length, 0);
  assert.equal(decodePriceFrame({ ...frame, payload: { ...frame.payload, window_s: 30 } }, spec, now).length, 0);
  frame.payload.data[0].timestamp = now + 10000;
  assert.equal(decodePriceFrame(frame, spec, now).length, 0);
});

test('spot and both opening prices use Polymarket and signal compares with the current round', async () => {
  const now = 1800000010000, start = roundStart(now), urls = [];
  const event = (round, opening) => ({ slug: `btc-updown-5m-${round}`, eventMetadata: { priceToBeat: opening },
    markets: [{ slug: `btc-updown-5m-${round}`, cryptoMarketConfig: { asset: 'btc', twapEnabled: true, twapLookbackSeconds: 60 } }] });
  const priceFeed = { connect: value => assert.equal(value.seconds, 60),
    fresh: async () => ({ price: 74300, time: now - 1000 }), drain: () => [], close() {} };
  const venue = new Polymarket({ now: () => now, priceFeed, fetchImpl: async url => {
    urls.push(String(url));
    return { ok: true, json: async () => [event(start, 74400), event(start - 300, 74200)] };
  } });
  const result = await venue.spot();
  assert.equal(result.sourceId, 'polymarket'); assert.equal(result.currentOpen, 74400);
  assert.equal(result.previousOpen, 74200); assert.equal(result.price, 74300);
  assert.equal(result.direction, 'DOWN'); assert.equal(result.at, now - 1000);
  assert.equal(result.change, -100); assert.equal(result.referencePrice, 74400);
  assert.equal(result.previousChange, 200); assert.equal(result.signalRule, 'current_round_open');
  await venue.spot(); assert.equal(urls.length, 1);
  assert.ok(urls.every(url => url.includes('polymarket.com') && !url.includes('binance')));
});

test('missing event opening price falls back only to the official website with the same TWAP parameters', async () => {
  const venue = new Polymarket({ fetchImpl: async url => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'polymarket.com');
    assert.equal(parsed.searchParams.get('twapEnabled'), 'true');
    assert.equal(parsed.searchParams.get('twapLookbackSeconds'), '60');
    return { ok: true, json: async () => ({ openPrice: 74142.1188 }) };
  } });
  assert.equal(await venue.openingPrice({}, 1800000000, spec), 74142.1188);
});

test('a delayed current opening quote keeps prices visible but withholds direction instead of using the previous opening', async () => {
  const now = 1800000010000, start = roundStart(now);
  const market = round => ({ slug: `btc-updown-5m-${round}`, cryptoMarketConfig: { asset: 'btc', twapEnabled: true, twapLookbackSeconds: 60 } });
  const feed = { connect() {}, fresh: async () => ({ price: 74300, time: now }), pointAt: () => null, drain: () => [], close() {} };
  const venue = new Polymarket({ now: () => now, priceFeed: feed, fetchImpl: async url => {
    if (String(url).includes('crypto-price')) return { ok: false, status: 429 };
    return { ok: true, json: async () => [
      { slug: market(start).slug, markets: [market(start)] },
      { slug: market(start - 300).slug, markets: [market(start - 300)], eventMetadata: { priceToBeat: 74200 } },
    ] };
  } });
  const result = await venue.spot();
  assert.equal(result.price, 74300); assert.equal(result.previousOpen, 74200);
  assert.equal(result.currentOpen, null); assert.equal(result.direction, null);
  assert.equal(result.change, null); assert.equal(result.referencePrice, null);
});

test('screenshot regression: previous round drops about 10 while this round rises about 16, never netting them to 6', async () => {
  const now = 1800000010000, start = roundStart(now);
  const event = (round, open, close) => ({ slug:`btc-updown-5m-${round}`,
    eventMetadata:{ priceToBeat:open, finalPrice:close },
    markets:[{ slug:`btc-updown-5m-${round}`, cryptoMarketConfig:{ asset:'btc',twapEnabled:true,twapLookbackSeconds:60 } }] });
  const feed = { connect() {}, fresh:async () => ({ price:74079.99,time:now }), drain:() => [],close() {} };
  const venue = new Polymarket({ now:() => now,priceFeed:feed,fetchImpl:async () => ({ok:true,json:async () => [
    event(start,74063.67124713791),event(start-300,74073.56230871202,74063.67124713791),
  ]}) });
  const result = await venue.spot();
  assert.equal(result.previousChange.toFixed(2), '-9.89');
  assert.equal(result.change.toFixed(2), '16.32');
  assert.equal(result.direction, 'UP');
});

test('official-only opening never substitutes a locally sampled boundary and retries a delayed official value',async()=>{
  let now=1800000010000,available=false,requests=0;const start=roundStart(now);
  const event=round=>({slug:`btc-updown-5m-${round}`,markets:[{slug:`btc-updown-5m-${round}`,conditionId:'c',cryptoMarketConfig:{asset:'btc',twapEnabled:true,twapLookbackSeconds:60}}],eventMetadata:round===start-300?{priceToBeat:99}:{}});
  const feed={connect(){},fresh:async()=>({price:102,time:now}),pointAt:()=>100,drain:()=>[],close(){},recent:()=>[{time:now-1000,price:101},{time:now,price:102}],spec:{seconds:60}};
  const venue=new Polymarket({officialOpeningOnly:true,now:()=>now,priceFeed:feed,fetchImpl:async url=>{
    if(String(url).includes('gamma-api'))return {ok:true,json:async()=>[event(start),event(start-300)]};
    requests++;return {ok:true,json:async()=>available?{openPrice:100.5}:{}};
  }});
  const missing=await venue.spot();assert.equal(missing.currentOpen,null);assert.equal(missing.direction,null);
  available=true;now+=1000;const present=await venue.spot();
  assert.equal(present.currentOpen,100.5);assert.equal(present.openingSource,'polymarket_official');assert.equal(requests,2);
  assert.deepEqual(venue.latestOfficialPrices(),{points:feed.recent(),oracleWindow:60});
});

test('the new strategy can read the current official opening without waiting for previous-round metadata',async()=>{
  const now=1800000010000,start=roundStart(now),slug=`btc-updown-5m-${start}`;
  const feed={connect(){},fresh:async()=>({price:101,time:now}),close(){}};
  const venue=new Polymarket({officialOpeningOnly:true,priceFeed:feed,now:()=>now,fetchImpl:async url=>{
    assert.ok(String(url).includes('gamma-api'));
    return {ok:true,json:async()=>[{slug,eventMetadata:{priceToBeat:100},markets:[{slug,conditionId:'c',cryptoMarketConfig:{asset:'btc',twapEnabled:true,twapLookbackSeconds:60}}]}]};
  }});
  const spot=await venue.spot();assert.equal(spot.currentOpen,100);assert.equal(spot.direction,'UP');assert.equal(spot.previousChange,null);
});

test('a multi-tick official frame emits only its newest price and preserves two distinct consecutive timestamps',()=>{
  const now=1800000010000,handlers={},seen=[];
  const socket={readyState:1,addEventListener:(name,fn)=>{handlers[name]=fn;},close(){},send(){}};
  const feed=new PolymarketPriceFeed({now:()=>now,socketFactory:()=>socket});
  feed.on('price',point=>seen.push(point));feed.connect(spec);
  const frame={topic:spec.topic,payload:{symbol:'btc/usd',window_s:60,data:[
    {timestamp:now-1000,value:100},{timestamp:now,value:101},{timestamp:now,value:999}
  ]}};
  handlers.message({data:JSON.stringify(frame)});
  assert.deepEqual(seen,[{time:now,price:101,oracleWindow:60}]);
  assert.deepEqual(feed.recent(),[{time:now-1000,price:100},{time:now,price:101}]);
  handlers.message({data:JSON.stringify(frame)});assert.equal(seen.length,1);feed.close();
});

test('range strategy receives official live prices without waiting for a slow current opening endpoint',async()=>{
  const now=1800000010000,start=roundStart(now),slug=`btc-updown-5m-${start}`;let release;
  const feed={connect(){},fresh:async()=>({price:101,time:now}),close(){}};
  const venue=new Polymarket({officialOpeningOnly:true,deferOpeningPrice:true,priceFeed:feed,now:()=>now,fetchImpl:async url=>{
    if(String(url).includes('gamma-api'))return {ok:true,json:async()=>[{slug,markets:[{slug,conditionId:'c',cryptoMarketConfig:{asset:'btc',twapEnabled:true,twapLookbackSeconds:60}}]}]};
    return new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({openPrice:100})});});
  }});
  const first=await venue.spot();assert.equal(first.price,101);assert.equal(first.currentOpen,null);assert.equal(typeof release,'function');
  release();await venue.openingTask.promise;const next=await venue.spot();assert.equal(next.currentOpen,100);assert.equal(next.direction,'UP');
});
