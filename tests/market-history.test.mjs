import test from 'node:test';
import assert from 'node:assert/strict';
import {RangeStore} from '../server/range-store.mjs';
import {Store} from '../server/store.mjs';
import {MarketHistory} from '../server/market-history.mjs';
import {createApp} from '../server/index.mjs';
import {Engine} from '../server/engine.mjs';
import {arrangeMarketHistory} from '../src/market-history-layout.mjs';

const date='2026-11-26',start=Date.parse(date+'T00:00:00+08:00')/1000;
const slug=round=>`btc-updown-5m-${round}`;
const event=(round,open=100,close=101)=>({slug:slug(round),eventMetadata:{priceToBeat:open,finalPrice:close},
  markets:[{slug:slug(round),conditionId:`c${round}`,outcomes:'["Up","Down"]'}]});
const resolved=(round,payouts=[1,0])=>({conditionId:`c${round}`,status:'resolved',payouts});
const tile=(slot,result='UP',verifiedAt=1)=>({round:start+slot*300,end:start+(slot+1)*300,result,verifiedAt});

test('hour groups use the opening hour, with groups and tiles both latest first',()=>{
  const items=[tile(0),tile(286),tile(264),tile(276),tile(1),tile(287)];
  const {hours}=arrangeMarketHistory(items,start);
  assert.deepEqual(hours.map(([hour,group])=>[hour,group.map(item=>(item.round-start)/300)]),[
    [23,[287,286,276]],[22,[264]],[0,[1,0]],
  ]);
});

test('each tile in a five-or-more verified same-direction run is marked, even across hours',()=>{
  const up=[9,10,11,12,13].map(slot=>tile(slot));
  const down=[14,15,16,17,18,19].map(slot=>tile(slot,'DOWN'));
  const {streaks,longest}=arrangeMarketHistory([...up,...down],start);
  assert.deepEqual([...streaks],[...up.map(item=>[item.round,5]),...down.map(item=>[item.round,6])]);
  assert.deepEqual(longest,{length:6,directions:['DOWN']});
});

test('an unverified outcome, void or missing round breaks a streak',()=>{
  const tiles=[0,1,2,3,5,6,7,8,10,11,12,13,15,16,17,18].map(slot=>tile(slot));
  tiles.push(tile(4,'UP',null),tile(9,null));
  const {streaks,longest}=arrangeMarketHistory(tiles,start);
  assert.equal(streaks.size,0);
  assert.deepEqual(longest,{length:4,directions:['UP']});
});

test('the longest run shows both directions on a tie and none before results are verified',()=>{
  const tiles=[tile(0,'DOWN'),tile(1,'DOWN'),tile(2),tile(3),tile(4,'UP',null)];
  assert.deepEqual(arrangeMarketHistory(tiles,start).longest,{length:2,directions:['UP','DOWN']});
  assert.deepEqual(arrangeMarketHistory([tiles.at(-1),tile(5,null)],start).longest,{length:0,directions:[]});
});

function fixture(t){
  const shared=new RangeStore(':memory:'),archive=new Store(':memory:');
  let now=(start+900)*1000,allowed=true,events=[],outcomes=[],prices=[];
  const calls=[];
  const venue={
    fetch:async (url,options)=>{
      assert(options.signal instanceof AbortSignal);
      const slugs=new URL(url).searchParams.getAll('slug');calls.push(['events',slugs]);
      assert(slugs.length<=20);
      return {ok:true,json:async()=>events.filter(e=>slugs.includes(e.slug))};
    },
    public:{fetchResolutions:async ({conditionIds},options)=>{
      assert(options.signal instanceof AbortSignal);
      calls.push(['resolutions',conditionIds]);
      if(outcomes instanceof Error)throw outcomes;
      return outcomes.filter(o=>conditionIds.includes(o.conditionId));
    }},
    roundPrices:async (order,{event,signal})=>{
      assert.equal(event.slug,slug(order.round));
      assert(signal instanceof AbortSignal);
      calls.push(['prices',order.round]);
      return prices.find(pair=>pair.round===order.round);
    },
  };
  const settings={sources:[archive],canRefresh:()=>allowed,now:()=>now};
  const history=new MarketHistory(shared,venue,settings);
  t.after(()=>{history.close();archive.close();shared.close();});
  return {shared,archive,history,settings,venue,calls,setAllowed:value=>{allowed=value;},
    setEvents:value=>{events=value;},setOutcomes:value=>{outcomes=value;},setPrices:value=>{prices=value;},advance:ms=>{now+=ms;}};
}

test('saved market rows show immediately and become final only after an official check',async t=>{
  const {shared,archive,history,settings,venue,calls,setAllowed,setEvents,setOutcomes}=fixture(t);
  archive.saveHistoricalRound({round:start,end:start+300,slug:slug(start),status:'resolved',result:'DOWN',open:120,close:119});
  shared.saveRoundOpening({round:start+600,conditionId:`c${start+600}`,open:105,oracleWindow:60,observedAt:start*1000});
  const initial=history.read(date);
  assert.equal(initial.timezone,'Asia/Shanghai');
  assert.deepEqual(initial.items.map(i=>[i.round,i.status,i.result,i.open,i.close]),[
    [start,'unverified','DOWN',120,119],[start+300,'missing',null,null,null],[start+600,'pending',null,105,null],
  ]);
  assert(initial.items.every(i=>i.verifiedAt===null));
  assert.deepEqual(calls,[]);
  setAllowed(false);assert.equal(history.poll(),null);
  setAllowed(true);
  setEvents([event(start),event(start+300,100,99),event(start+600,105,105)]);
  setOutcomes([resolved(start),resolved(start+300,[0,1]),resolved(start+600,[.5,.5])]);
  await history.poll();
  assert.equal(calls.length,2);
  const result=history.read(date);
  assert.deepEqual(result.items.map(i=>[i.status,i.result,i.open,i.close]),[
    ['resolved','UP',100,101],['resolved','DOWN',100,99],['void',null,105,105],
  ]);
  assert(result.items.every(i=>Number.isFinite(i.verifiedAt)));
  assert.equal(result.refreshing,false);
  const reopened=new MarketHistory(shared,venue,settings);
  assert.deepEqual(reopened.read(date),result);
  assert.equal(reopened.poll(),null);
  assert.equal(archive.historicalRound(start).result,'DOWN');
  assert.deepEqual(calls.map(x=>x[0]),['events','resolutions']);
});

test('incomplete, missing and conflicting official data remain provisional and are retried by date',async t=>{
  const {history,calls,setEvents,setOutcomes,advance}=fixture(t);
  setEvents([event(start,100,null),event(start+600,100,101)]);
  setOutcomes([resolved(start),resolved(start+600,[0,1])]);
  history.read(date);await history.poll();
  const pending=history.read(date);
  assert.deepEqual(pending.items.map(i=>[i.status,i.result,i.verifiedAt]),[
    ['unverified','UP',null],['missing',null,null],['unverified','DOWN',null],
  ]);
  assert.equal(pending.items[0].open,100);
  assert.equal(history.poll(),null);
  advance(60000);
  setEvents([event(start),event(start+300),event(start+600,100,99)]);
  setOutcomes([resolved(start),resolved(start+300),resolved(start+600,[0,1])]);
  history.read(date);await history.poll();
  assert(history.read(date).items.every(i=>i.verifiedAt!=null));
  assert.equal(calls.length,5);
});

test('missing Gamma prices use official crypto prices only when the market, known price and result match',async t=>{
  const {history,shared,settings,venue,calls,setEvents,setOutcomes,setPrices,advance}=fixture(t);
  const rounds=[start,start+300,start+600];
  setEvents(rounds.map(round=>event(round,100,null)));
  setOutcomes(rounds.map(round=>resolved(round)));
  const pair=(round,open,close)=>({round,conditionId:`c${round}`,open,close,source:'polymarket_crypto_price'});
  setPrices([pair(start,100,102),pair(start+300,101,102),pair(start+600,100,99)]);
  history.read(date);await history.poll();
  const result=history.read(date);
  assert.deepEqual(calls.map(([type])=>type),['events','resolutions','prices','prices','prices']);
  assert.deepEqual(result.items.map(item=>[item.status,item.close,item.closeSource]),[
    ['resolved',102,'polymarket_crypto_price'],['unverified',null,null],['unverified',99,'polymarket_crypto_price'],
  ]);
  assert(result.items[0].verifiedAt!=null);
  const reopened=new MarketHistory(shared,venue,settings);t.after(()=>reopened.close());
  assert.deepEqual(reopened.read(date),result);
  assert.equal(reopened.poll(),null);
  advance(60000);
  setPrices([pair(start+300,100,102),{...pair(start+600,100,102),conditionId:'another-market'}]);
  reopened.read(date);await reopened.poll();
  const repaired=reopened.read(date).items;
  assert(repaired[1].verifiedAt!=null);
  assert.equal(repaired[2].verifiedAt,null);
});

test('the price fallback waits if the opening protection window starts during settlement lookup',async t=>{
  const {history,venue,calls,setAllowed,setEvents,setOutcomes,setPrices}=fixture(t);
  setEvents([event(start,100,null)]);setOutcomes([resolved(start)]);
  setPrices([{round:start,conditionId:`c${start}`,open:100,close:102,source:'polymarket_crypto_price'}]);
  const fetchResolutions=venue.public.fetchResolutions;
  venue.public.fetchResolutions=async (...args)=>{
    const results=await fetchResolutions(...args);
    setAllowed(false);
    return results;
  };
  history.read(date);await history.poll();
  assert.deepEqual(calls.map(([type])=>type),['events','resolutions']);
  assert.equal(history.poll(),null);
  assert.equal(history.read(date).items[0].verifiedAt,null);
  venue.public.fetchResolutions=fetchResolutions;
  setAllowed(true);await history.poll();
  assert.equal(history.read(date).items[0].status,'resolved');
});

test('API reads one Beijing date, excludes the current unfinished round and never returns order data',async t=>{
  const {history,shared,calls}=fixture(t);
  const engine=new Engine(shared,{readiness:()=>({enabled:false})});
  const server=createApp(engine,{marketHistory:history}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}/api/market-history`;
  const result=await fetch(url);
  assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
  const data=await result.json();
  assert.equal(data.date,date);assert.equal(data.items.length,3);
  assert.deepEqual(Object.keys(data.items[0]).sort(),['close','closeSource','end','open','result','round','status','verifiedAt']);
  for(const value of ['2026-11-27','2026-02-30','date-invalid'])assert.equal((await fetch(url+'?date='+value)).status,400);
  const yesterday=await fetch(url+'?date=2026-11-25').then(r=>r.json());
  assert.equal(yesterday.items.length,288);
  assert.equal(yesterday.items[0].round,start-86400);assert.equal(yesterday.items.at(-1).end,start);
  assert.deepEqual(calls,[]);
});

test('a failed resolution request retains prices and postpones retry without finalizing',async t=>{
  const {history,setEvents,setOutcomes,advance}=fixture(t);
  setEvents([event(start)]);setOutcomes(new Error('test outage'));
  history.read(date);await history.poll();
  const result=history.read(date);
  assert.equal(result.items[0].open,100);assert.equal(result.items[0].close,101);assert.equal(result.items[0].verifiedAt,null);
  assert.match(result.error,/test outage/);
  assert.equal(history.poll(),null);
  advance(60000);setOutcomes([resolved(start)]);
  history.read(date);await history.poll();
  assert.equal(history.read(date).items[0].status,'resolved');
});
