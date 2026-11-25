import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Agent,get} from 'node:http';
import {connectPageStream} from '../src/page-stream.mjs';
import {coalescedRefresh} from '../src/coalesced-refresh.mjs';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {createApp} from '../server/index.mjs';

test('a visible page uses one stream; hidden pages release it and ignore old frames',()=>{
  const document=new EventTarget(),window=new EventTarget(),sources=[],frames=[],connections=[];
  document.hidden=false;
  class Source extends EventTarget{
    constructor(url){super();this.url=url;sources.push(this);}
    close(){this.closed=true;}
    send(type,value){this.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(value)}));}
  }
  const stop=connectPageStream({url:'/loss-follow/api/events?chart=1',document,window,EventSource:Source,
    onConnected:value=>connections.push(value),onState:value=>frames.push(['state',value]),
    onPrices:value=>frames.push(['prices',value]),onHistory:()=>{},onOpening:()=>{},onRange:()=>{}});
  assert.equal(sources.length,1);sources[0].onopen();
  sources[0].send('message',{time:1});sources[0].send('chart-prices',[{price:100}]);
  assert.deepEqual(frames,[['state',{time:1}],['prices',[{price:100}]]]);
  document.hidden=true;document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(sources[0].closed,true);assert.equal(connections.at(-1),false);
  sources[0].send('chart-prices',[{price:999}]);assert.equal(frames.length,2);
  document.hidden=false;document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(sources.length,2);
  window.dispatchEvent(new Event('pagehide'));assert.equal(sources[1].closed,true);
  window.dispatchEvent(new Event('pageshow'));assert.equal(sources.length,3);
  stop();assert.equal(sources[2].closed,true);
  document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pageshow'));
  assert.equal(sources.length,3);
});

test('history revisions coalesce without cancelling an unfinished request',async()=>{
  const release=[];let count=0;
  const refresh=coalescedRefresh(()=>{count++;return new Promise(resolve=>release.push(resolve));});
  const first=refresh.refresh();await Promise.resolve();assert.equal(count,1);
  for(let i=0;i<10;i++)assert.equal(refresh.refresh(),first);
  release.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(count,2);
  refresh.refresh();refresh.close();release.shift()();await first;
  assert.equal(count,2);await refresh.refresh();assert.equal(count,2);
});

async function fixture(t){
  const store=new Store(':memory:'),feed=new EventEmitter(),opening=new EventEmitter(),range=new EventEmitter();
  const round=Math.floor(Date.now()/300000)*300;
  opening.current=()=>({round,price:74000});range.current=()=>({round,zone:{lower:73000,upper:75000}});
  const engine=new Engine(store,{readiness:()=>({enabled:false})});
  const server=createApp(engine,{lossFollowEngine:engine,previousEngine:engine,
    chart:{feed,opening,range,store}}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();store.close();});
  return {store,feed,opening,range,engine,base:`http://127.0.0.1:${server.address().port}`};
}

test('combined SSE delivers market frames independently of engine snapshots and cleans listeners',async t=>{
  const {base,feed,opening,range,engine}=await fixture(t),abort=new AbortController();
  t.after(()=>abort.abort());
  const response=await fetch(base+'/loss-follow/api/events?chart=1',{signal:abort.signal});
  const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();let buffer='';
  const next=async()=>{
    while(!buffer.includes('\n\n')){const {value,done}=await reader.read();assert.equal(done,false);buffer+=value;}
    const end=buffer.indexOf('\n\n'),frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
    const lines=frame.split('\n'),event=lines[0].startsWith('event: ')?lines.shift().slice(7):'message';
    return [event,JSON.parse(lines[0].slice(6))];
  };
  assert.equal((await next())[0],'message');
  assert.deepEqual(await next(),['chart-opening',opening.current()]);
  assert.deepEqual(await next(),['chart-range',range.current()]);
  const point={time:Date.now(),price:74005};feed.emit('price',point,[point]);
  assert.deepEqual(await next(),['chart-prices',[point]]);
  engine.emit('update',{time:2});assert.deepEqual(await next(),['message',{time:2}]);
  abort.abort();
  for(let i=0;i<20&&feed.listenerCount('price');i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(feed.listenerCount('price'),0);assert.equal(engine.listenerCount('update'),0);
  assert.equal(opening.listenerCount('opening'),0);assert.equal(range.listenerCount('range'),0);
});

test('three dashboard streams leave HTTP connection capacity for paginated orders',async t=>{
  const {base}=await fixture(t),agent=new Agent({keepAlive:true,maxSockets:6}),requests=[];
  t.after(()=>{for(const req of requests)req.destroy();agent.destroy();});
  const streams=['/previous','/loss-follow','/previous'].map(path=>new Promise((resolve,reject)=>{
    const req=get(base+path+'/api/events?chart=1',{agent},res=>{res.resume();resolve(res);});
    requests.push(req);req.on('error',reject);
  }));
  await Promise.all(streams);
  const result=await new Promise((resolve,reject)=>{
    const req=get(base+'/loss-follow/api/paper/orders?page=1&pageSize=20&status=all',{agent},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({res,body}));
    });requests.push(req);req.on('error',reject);
    req.setTimeout(2000,()=>req.destroy(Error('pagination blocked by persistent streams')));
    const timer=setTimeout(()=>req.destroy(Error('pagination queued behind persistent streams')),3000);
    req.once('close',()=>clearTimeout(timer));
  });
  assert.equal(result.res.statusCode,200);assert.match(result.res.headers['server-timing'],/^db;dur=\d+\.\d+/);
  assert.equal(JSON.parse(result.body).pageSize,20);
});
