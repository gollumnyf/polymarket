import test from 'node:test';
import assert from 'node:assert/strict';
import { Polymarket, normalizeMarket, safeError } from '../server/polymarket.mjs';

test('critical public queries expose their endpoint and network cause without hidden SDK retries',async()=>{
  let calls=0;
  const venue=new Polymarket({fetchImpl:async()=>{calls++;throw new TypeError('fetch failed',
    {cause:Object.assign(Error('reset'),{code:'ECONNRESET'})});}});
  await assert.rejects(venue.market(1800000000),error=>{
    assert.match(error.message,/Gamma.*1800000000/);assert.match(error.message,/ECONNRESET/);return true;
  });
  assert.equal(calls,1);
  await assert.rejects(venue.market(1800000000));assert.equal(calls,2);
});

test('concurrent market and book reads share only matching in-flight public data, with independent results',async()=>{
  const feed={},fetchImpl=async()=>{},a=new Polymarket({priceFeed:feed,fetchImpl}),b=new Polymarket({priceFeed:feed,fetchImpl});
  const raw={id:'1',slug:'btc-updown-5m-1800000000',conditionId:'c',version:'v1',
    state:{active:true,closed:false,acceptingOrders:true},trading:{feesEnabled:false},
    outcomes:{yes:{label:'UP',tokenId:'u'},no:{label:'DOWN',tokenId:'d'}}};
  let release,calls=0;
  const load=(_params,options)=>{calls++;assert.equal(options.retries,0);assert.equal(options.timeout,2500);
    assert.ok(options.signal instanceof AbortSignal);return new Promise(resolve=>{release=()=>resolve(raw);});};
  a.public={fetchMarket:load};b.public={fetchMarket:load};
  const p=a.market(1800000000),q=b.market(1800000000);await Promise.resolve();
  assert.equal(calls,1);release();const [ma,mb]=await Promise.all([p,q]);
  ma.outcomes[0].assetId='mutated';assert.equal(mb.outcomes[0].assetId,'u');
  const next=a.market(1800000000);await Promise.resolve();assert.equal(calls,2);release();await next;
  let books=0,finish;
  const loadBooks=(_params,options)=>{books++;assert.equal(options.retries,0);
    return new Promise(resolve=>{finish=()=>resolve([{assetId:'u',asks:[{price:'.5',size:'10'}],bids:[]},{assetId:'d',asks:[],bids:[]}]);});};
  a.public.fetchOrderBooks=loadBooks;b.public.fetchOrderBooks=loadBooks;
  const x=a.books(mb),y=b.books(mb);await Promise.resolve();assert.equal(books,1);finish();
  const [ba,bb]=await Promise.all([x,y]);ba.UP.asks[0].size='0';assert.equal(bb.UP.asks[0].size,'10');
  const other={...mb,round:mb.round+300};
  const z=a.books(other);await Promise.resolve();assert.equal(books,2);finish();await z;
});

test('a stalled public request times out and releases the next scheduler retry',async()=>{
  const venue=new Polymarket();let calls=0;
  venue.public={fetchMarket:async(_params,options)=>{
    calls++;await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  }};
  await assert.rejects(venue.market(1800000000),/Gamma.*TIMEOUT/);
  assert.equal(calls,1);
  venue.public.fetchMarket=async()=>{throw Object.assign(Error('dns'),{code:'ENOTFOUND'});};
  await assert.rejects(venue.market(1800000000),/ENOTFOUND/);
  const cycle=Object.assign(Error('fetch failed'),{code:'UND_ERR_SOCKET'});cycle.cause=cycle;
  assert.match(safeError(cycle),/UND_ERR_SOCKET/);
  assert.match(safeError(new AggregateError([Object.assign(Error('dns'),{code:'EAI_AGAIN'})],'fetch failed')),/EAI_AGAIN/);
});

test('fee lookup uses the same short public deadline and rate limits honor retry-after without blocking the engine',async()=>{
  const venue=new Polymarket();let calls=0;
  venue.public={fetchMarket:async()=>({id:'1',slug:'btc',conditionId:'c',version:'v1',
    state:{active:true,closed:false,acceptingOrders:true},trading:{feesEnabled:true},
    outcomes:{yes:{label:'UP',tokenId:'u'},no:{label:'DOWN',tokenId:'d'}}}),
    fetchMarketInfo:async(_params,options)=>{calls++;assert.equal(options.retries,0);assert.equal(options.timeout,2500);
      throw Object.assign(Error('rate limited'),{name:'RateLimitError',retryAfter:10});}};
  await assert.rejects(venue.market(1800000000),/CLOB.*HTTP 429.*10/);
  await assert.rejects(venue.market(1800000000),/CLOB.*HTTP 429/);
  assert.equal(calls,1);
});

test('market normalization maps UP/DOWN by labels and chooses IDs by explicit protocol version', () => {
  const raw = { id: '1', slug: 'btc', version: 'v2', state: { active: true, closed: false, acceptingOrders: true },
    trading: { feesEnabled: true, feeSchedule: { rate: '.07', exponent: 1 } },
    outcomes: { yes: { label: 'Down', tokenId: 'legacy-down', positionId: 'position-down', price: '.4' },
      no: { label: 'Up', tokenId: 'legacy-up', positionId: 'position-up', price: '.6' } } };
  const normalized = normalizeMarket(raw, 100);
  assert.equal(normalized.outcomes.find(o => o.direction === 'UP').assetId, 'position-up');
  assert.equal(normalized.outcomes.find(o => o.direction === 'UP').index, 1);
  raw.version = 'v1'; assert.equal(normalizeMarket(raw, 100).outcomes[0].assetId, 'legacy-down');
  raw.version = 'v3'; assert.throws(() => normalizeMarket(raw, 100), /未知市场/);
});
test('live buy signs and posts once; never invokes SDK automatic approval helper', async () => {
  const venue = new Polymarket(); let prepared, posts = 0;
  venue.authenticate = async () => ({
    createMarketOrder: async request => { prepared = request; return { signed: true }; },
    postOrder: async signed => { posts++; assert.equal(signed.signed, true); return { ok: true }; },
    placeMarketOrder: () => { throw new Error('Must not request automatic allowance recovery'); },
  });
  const result = await venue.buy({ assetId: 'up', budget: 10 }, { priceLimit: .55 });
  assert.equal(result.ok, true); assert.equal(posts, 1);
  assert.equal(prepared.maxSpend, '10'); assert.equal(prepared.maxPrice, '0.55');
  assert.equal(prepared.orderType, 'FOK');
});
test('pause or expired entry after signing prevents the POST; failed signing is known unsubmitted', async () => {
  const venue = new Polymarket(); let posts = 0;
  venue.authenticate = async () => ({ createMarketOrder: async () => ({}), postOrder: async () => { posts++; } });
  assert.equal((await venue.buy({ assetId: 'up', budget: 10 }, { priceLimit: .55 }, () => false)).ok, false);
  assert.equal(posts, 0);
  venue.authenticate = async () => ({ createMarketOrder: async () => { throw new Error('metadata unavailable'); } });
  const result = await venue.buy({ assetId: 'up', budget: 10 }, { priceLimit: .55 });
  assert.equal(result.ok, false); assert.match(result.message, /未提交/);
});
test('settlement requires explicit resolved payouts and honors outcome index rather than UP assumptions', async () => {
  const venue = new Polymarket(); let rows = [{ conditionId: 'c', status: 'proposed', payouts: ['1', '0'] }];
  venue.public = { fetchResolutions: async () => rows };
  assert.equal(await venue.resolution({ conditionId: 'c', outcomeIndex: 0 }), null);
  rows = [{ conditionId: 'c', status: 'resolved', payouts: ['0', '1'] }];
  assert.equal((await venue.resolution({ conditionId: 'c', outcomeIndex: 1 })).payout, 1);
  rows[0].payouts = ['1', '1']; await assert.rejects(venue.resolution({ conditionId: 'c', outcomeIndex: 0 }), /兑付比例无效/);
});

test('prediction prices are read from matching event metadata with the recorded oracle window',async()=>{
  const order={round:1800000000,end:1800000300,conditionId:'c',oracleWindow:60};
  const slug=`btc-updown-5m-${order.round}`;
  const event={slug,eventMetadata:{priceToBeat:100,finalPrice:99},markets:[{slug,conditionId:'c',
    cryptoMarketConfig:{asset:'BTC',twapEnabled:true,twapLookbackSeconds:60}}]};
  const urls=[];
  const venue=new Polymarket({fetchImpl:async url=>{urls.push(url);return {ok:true,json:async()=>[event]};}});
  assert.deepEqual(await venue.roundPrices(order),{round:order.round,conditionId:'c',open:100,close:99,oracleWindow:60,source:'polymarket_event_metadata'});
  assert.equal(urls.length,1);
  assert.equal((await venue.roundPrices({round:order.round,end:order.end})).conditionId,'c');
  assert.equal(await venue.roundPrices({...order,conditionId:'wrong'}),null);
  await assert.rejects(venue.roundPrices({...order,oracleWindow:30}),/TWAP/);
});

test('missing metadata closes may use only the same official window closePrice, never current prices or the next opening',async()=>{
  const order={round:1800000000,end:1800000300,conditionId:'c',oracleWindow:60};
  const slug=`btc-updown-5m-${order.round}`;
  const event={slug,eventMetadata:{priceToBeat:100,finalPrice:null},markets:[{slug,conditionId:'c',
    cryptoMarketConfig:{asset:'BTC',twapEnabled:true,twapLookbackSeconds:60}}]};
  let pair={openPrice:100,closePrice:101},last;
  const venue=new Polymarket({fetchImpl:async url=>{
    if(url.startsWith('https://gamma-api.'))return {ok:true,json:async()=>[event]};
    last=new URL(url);return {ok:true,json:async()=>pair};
  }});
  assert.equal((await venue.roundPrices(order)).close,101);
  assert.equal(last.searchParams.get('eventStartTime'),new Date(order.round*1000).toISOString());
  assert.equal(last.searchParams.get('endDate'),new Date(order.end*1000).toISOString());
  assert.equal(last.searchParams.get('twapLookbackSeconds'),'60');
  pair={openPrice:100,price:102,currentPrice:102,nextOpen:102};
  assert.equal(await venue.roundPrices(order),null);
  pair={openPrice:99,closePrice:102};
  await assert.rejects(venue.roundPrices(order),/起始价不一致/);
});

test('wallet refresh reloads changed config and reads again without recreating an unchanged client',async t=>{
  let next={enabled:true,key:'0x'+'1'.repeat(64),wallet:'0x'+'2'.repeat(40)};
  const sessions=[];
  let calls=0;
  const venue=new Polymarket({
    loadWalletConfig:()=>({...next}),
    createWalletClient:async ({wallet})=>{const client={wallet};sessions.push(client);return client;},
    readWalletBalance:async client=>{assert.equal(client.wallet,next.wallet);return {balance:String(++calls*1e6)};}
  });
  t.after(()=>venue.close());
  assert.equal(await venue.refreshWallet(),1);
  assert.equal(await venue.refreshWallet({allowChange:false}),2);
  assert.equal(sessions.length,1);
  assert.equal(venue.readiness().authenticated,true);
  next={...next,wallet:'0x'+'3'.repeat(40)};
  await assert.rejects(venue.refreshWallet({allowChange:false}),/请先暂停实盘/);
  assert.equal(await venue.refreshWallet(),3);
  assert.equal(sessions.length,2);
  next={enabled:false,key:'',wallet:''};
  await assert.rejects(venue.refreshWallet(),/LIVE_TRADING_ENABLED/);
  assert.equal(venue.readiness().authenticated,false);
  assert.equal(venue.readiness().balance,null);
});

test('automatic connection skips missing or disabled wallet configuration without authenticating',async()=>{
  let config={enabled:false,key:'test',wallet:'test'};
  const venue=new Polymarket({loadWalletConfig:()=>config,
    createWalletClient:async()=>assert.fail('missing config must not authenticate')});
  assert.equal(await venue.refreshWallet({ifConfigured:true}),null);
  config={enabled:true,key:'',wallet:'test'};
  assert.equal(await venue.refreshWallet({ifConfigured:true}),null);
});

test('live reconciliation accepts confirmed CLOB status with or without prefix, but never MINED',async()=>{
  const venue=new Polymarket();
  const order={venueOrderId:'test-order',assetId:'asset',conditionId:'market',feeSchedule:{rate:0,exponent:1}};
  const trade={id:'fill',takerOrderId:order.venueOrderId,side:'BUY',size:'11.113637',price:'0.44'};
  let status='TRADE_STATUS_CONFIRMED';
  venue.authenticate=async()=>({
    listAccountTrades:()=>({firstPage:async()=>({items:[{...trade,status}]})}),
  });
  const result=await venue.reconcile(order);
  assert.deepEqual(result.tradeIds,['fill']);
  assert.ok(Math.abs(result.price-0.44)<1e-12);
  assert.equal(result.shares,11.113637);
  status='CONFIRMED';
  assert.deepEqual(await venue.reconcile(order),result);
  for(status of ['TRADE_STATUS_MINED','MINED','TRADE_STATUS_FAILED',null])
    assert.equal(await venue.reconcile(order),null);
});
