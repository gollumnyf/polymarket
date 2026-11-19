import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {createApp} from '../server/index.mjs';
import {PROJECT_ROOT,readService,stopService,serviceUrl,waitForStarted,runConsole} from '../scripts/service-control.mjs';

async function fixture(t,enabled=true){
  const store=new Store(':memory:'),engine=new Engine(store,{readiness:()=>({enabled:false})});
  let calls=0,server;
  const onShutdown=()=>{calls++;engine.stop('paper');engine.stop('live');server.close();server.closeAllConnections();};
  server=createApp(engine,{onShutdown:enabled?onShutdown:null}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.close();server.closeAllConnections();store.close();});
  return {store,engine,base:`http://127.0.0.1:${server.address().port}`,calls:()=>calls};
}

test('service shutdown verifies the project and token, then pauses strategies and confirms the listener closes',async t=>{
  const {store,engine,base,calls}=await fixture(t);await engine.start('paper');
  const service=await readService(base);assert.equal(service.name,'polymarket-btc-console');assert.equal(service.shutdownEnabled,true);
  assert.equal((await fetch(`${base}/api/service/shutdown`,{method:'POST'})).status,403);assert.equal(calls(),0);
  const state=await(await fetch(`${base}/api/state`)).json();
  assert.equal((await fetch(`${base}/api/service/shutdown`,{method:'POST',headers:{Origin:'https://example.com','X-Control-Token':state.controlToken}})).status,403);
  assert.equal(calls(),0);assert.equal(store.account('paper').running,true);
  await assert.rejects(stopService(base,{root:resolve(PROJECT_ROOT,'other-project')}),/不是本项目/);
  assert.equal(calls(),0);assert.equal(store.account('paper').running,true);
  assert.deepEqual(await stopService(base),{stopped:true});assert.equal(calls(),1);
  assert.equal(store.account('paper').running,false);assert.equal(store.account('live').running,false);
  assert.deepEqual(await stopService(base),{alreadyStopped:true});
});

test('control refuses a service without the shutdown capability and leaves it running',async t=>{
  const {base,calls}=await fixture(t,false);
  await assert.rejects(stopService(base),/尚不支持/);assert.equal(calls(),0);
  assert.equal((await readService(base)).shutdownEnabled,false);
});

test('a connection reset while shutdown closes the listener is retried rather than reported as a stop failure',async t=>{
  const {base,calls}=await fixture(t);let healthCalls=0;
  const fetchImpl=(url,options)=>{
    if(url.endsWith('/api/health')&&++healthCalls===2)return Promise.reject(Object.assign(Error('fetch failed'),{cause:{code:'UND_ERR_SOCKET'}}));
    return fetch(url,options);
  };
  assert.deepEqual(await stopService(base,{fetchImpl}),{stopped:true});
  assert.equal(calls(),1);assert.ok(healthCalls>=3);
});

test('control does not stop another application listening on the configured port',async t=>{
  let requests=0;
  const server=createServer((req,res)=>{requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,service:{name:'another-app',root:PROJECT_ROOT}}));}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.close();server.closeAllConnections();});
  const base=`http://127.0.0.1:${server.address().port}`;
  await assert.rejects(stopService(base),/不是本项目/);assert.equal(requests,1);assert.equal(server.listening,true);
  assert.equal(serviceUrl(3100),'http://127.0.0.1:3100');
  for(const port of [0,65536,'invalid','3100/other'])assert.throws(()=>serviceUrl(port),/PORT/);
});

test('slow startup beyond the old 20-second limit succeeds and transient probe failures are retried',async()=>{
  let clock=0,checks=0;const messages=[],service={pid:42};
  const result=await waitForStarted('http://127.0.0.1:3100',{exitCode:null},{
    now:()=>clock,wait:async ms=>{clock+=ms;},progress:line=>messages.push(line),
    read:async()=>{checks++;if(clock===25000)throw Object.assign(Error('socket reset'),{code:'SERVICE_UNREACHABLE'});return clock>=30000?service:null;}
  });
  assert.equal(result,service);assert.equal(clock,30000);assert.ok(checks>40);assert.ok(messages.length>=5);
});

test('startup reports process exit immediately, rejects a foreign service, and ends at its deadline',async()=>{
  await assert.rejects(waitForStarted('unused',{exitCode:1}),/代码 1/);
  await assert.rejects(waitForStarted('unused',{exitCode:null},{read:async()=>{throw Error('不是本项目的服务');}}),/不是本项目/);
  let clock=0;
  await assert.rejects(waitForStarted('unused',{exitCode:null},{timeoutMs:1000,now:()=>clock,wait:async ms=>{clock+=ms;},read:async()=>null,progress:()=>{}}),/后台进程可能仍在启动/);
  assert.equal(clock,1000);
});

test('console remains usable after startup failure and can stop the subsequently ready service',async t=>{
  const {base,calls}=await fixture(t);const messages=[];
  await runConsole(base,{answers:['3'],ensure:async()=>{throw Error('启动等待超时');},open:async()=>assert.fail('must not open on failure'),write:line=>messages.push(line)});
  assert.equal(calls(),1);assert.ok(messages.some(line=>line.includes('启动等待超时')));assert.ok(messages.some(line=>line.includes('3. 停止整个服务')));
});

test('console exit preserves an existing running strategy and does not stop the service',async t=>{
  const {base,store,engine,calls}=await fixture(t);await engine.start('paper');const opened=[];
  await runConsole(base,{answers:['2','5','0'],ensure:readService,open:async url=>opened.push(url),write:()=>{}});
  assert.deepEqual(opened,[`${base}/previous`,`${base}/previous-live`,`${base}/live-reports`]);assert.equal(calls(),0);
  assert.equal(store.account('paper').running,true);assert.ok(await readService(base));
});

test('console keeps a command entered while the service is starting',async()=>{
  const input=new PassThrough(),lines=createInterface({input}),messages=[];let release;
  const ready=new Promise(resolve=>{release=resolve;});
  const task=runConsole('unused',{answers:lines,ensure:async()=>{await ready;return {pid:42};},openOnStart:false,stop:async()=>assert.fail('must keep service'),write:line=>messages.push(line)});
  input.end('0\n');await new Promise(resolve=>setImmediate(resolve));release();
  try{await task;}finally{lines.close();}
  assert.ok(messages.some(line=>line.includes('已关闭控制台')));
});
