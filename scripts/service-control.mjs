import {spawn} from 'node:child_process';
import {mkdirSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';

export const PROJECT_ROOT=resolve(fileURLToPath(new URL('../',import.meta.url)));
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const samePath=(a,b)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);

export function serviceUrl(port=process.env.PORT||3100){
  const value=Number(port);
  if(!Number.isInteger(value)||value<1||value>65535)throw Error('PORT 必须是 1 到 65535 之间的整数');
  return `http://127.0.0.1:${value}`;
}

export async function readService(base,{root=PROJECT_ROOT,fetchImpl=fetch}={}){
  let response;
  try{response=await fetchImpl(`${base}/api/health`,{signal:AbortSignal.timeout(2500)});}
  catch(error){if(error.cause?.code==='ECONNREFUSED')return null;throw Object.assign(Error(`无法确认 ${base} 的服务身份：${error.message}`),{code:'SERVICE_UNREACHABLE',cause:error});}
  let data;try{data=await response.json();}catch(error){throw Object.assign(Error(`${base} 没有返回完整的服务身份数据`),{code:'SERVICE_UNREACHABLE',cause:error});}
  const service=data.service;
  if(!response.ok||!data.ok||service?.name!=='polymarket-btc-console'||typeof service.root!=='string'||!samePath(service.root,root))
    throw Error(`${base} 不是本项目的服务，未执行操作`);
  return service;
}

export async function stopService(base,options={}){
  const fetchImpl=options.fetchImpl||fetch;
  const service=await readService(base,options);
  if(!service)return {alreadyStopped:true};
  if(!service.shutdownEnabled)throw Error('当前服务版本尚不支持控制台停止，请先更新服务');
  const response=await fetchImpl(`${base}/api/state`,{signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error(`读取服务控制信息失败：HTTP ${response.status}`);
  const state=await response.json();
  if(typeof state.controlToken!=='string'||!state.controlToken)throw Error('服务没有返回有效控制令牌');
  const stopped=await fetchImpl(`${base}/api/service/shutdown`,{method:'POST',headers:{Origin:base,'X-Control-Token':state.controlToken,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
  const result=await stopped.json();
  if(!stopped.ok||!result.ok)throw Error(result.error||`停止请求失败：HTTP ${stopped.status}`);
  if(result.instanceId!==service.instanceId)throw Error('服务实例已改变，请重新执行停止操作');
  const deadline=Date.now()+35000;
  while(Date.now()<deadline){
    let current;
    try{current=await readService(base,options);}catch(error){if(error.code!=='SERVICE_UNREACHABLE')throw error;await sleep(250);continue;}
    if(!current)return {stopped:true};
    if(current.instanceId!==service.instanceId)return {stopped:true,replaced:true};
    await sleep(250);
  }
  throw Error('停止请求已发送，35 秒内服务尚未退出，请检查 data/server-error.log');
}

export async function waitForStarted(base,child,{timeoutMs=90000,now=Date.now,wait=sleep,read=readService,progress=console.log}={}){
  const started=now(),deadline=started+timeoutMs;let nextProgress=started+5000;
  while(now()<deadline){
    if(child.exitCode!=null)throw Error(`服务启动后退出，代码 ${child.exitCode}，请检查 data/server-error.log`);
    if(child.signalCode)throw Error(`服务启动被信号 ${child.signalCode} 中断，请检查 data/server-error.log`);
    try{const service=await read(base);if(service)return service;}
    catch(error){if(error.code!=='SERVICE_UNREACHABLE')throw error;}
    if(now()>=nextProgress){progress(`正在等待服务就绪：${Math.floor((now()-started)/1000)} 秒（最长 ${timeoutMs/1000} 秒）`);nextProgress=now()+5000;}
    await wait(Math.min(500,Math.max(0,deadline-now())));
  }
  throw Error(`已等待 ${timeoutMs/1000} 秒，服务尚未就绪；后台进程可能仍在启动，请查看 data/server-out.log 和 data/server-error.log。可重新双击启动脚本连接服务。`);
}

async function ensureService(base){
  const existing=await readService(base);
  if(existing)return existing;
  const folder=resolve(PROJECT_ROOT,'data');mkdirSync(folder,{recursive:true});
  const output=openSync(resolve(folder,'server-out.log'),'a'),errors=openSync(resolve(folder,'server-error.log'),'a');
  let child;
  try{
    child=spawn(process.execPath,['--use-env-proxy','--env-file-if-exists=.env','server/index.mjs'],{cwd:PROJECT_ROOT,detached:true,windowsHide:true,stdio:['ignore',output,errors]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  }finally{closeSync(output);closeSync(errors);}
  console.log('正在启动后台服务，策略保持暂停，请稍候…');
  return waitForStarted(base,child);
}

const stoppedMessage=result=>result.alreadyStopped?'服务已经停止。':result.replaced?'原服务已停止，检测到新的服务实例，已保留新实例。':'服务已停止，行情采集与结算检查已结束。';

async function openBrowser(url){
  if(process.platform!=='win32')throw Error(`请在浏览器打开 ${url}`);
  const child=spawn('cmd.exe',['/d','/c','start','""',url],{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`打开浏览器失败，请手动访问 ${url}`)));});
}

export async function runConsole(base,{answers,ensure=ensureService,stop=stopService,open=openBrowser,write=console.log,openOnStart=true}={}){
  // Subscribe before startup awaits so keys entered during startup stay queued.
  const pendingAnswers=answers[Symbol.asyncIterator]?.()||answers[Symbol.iterator]();
  const connect=async()=>{const service=await ensure(base);write(`服务正在运行：${base} · PID ${service.pid}`);};
  try{await connect();if(openOnStart)await open(`${base}/previous`);}catch(error){write(error.message);}
  const menu=()=>write('\n==================================================\n  Polymarket BTC 5M 服务控制台\n  1. 打开上场方向模拟\n  2. 打开上场方向实盘\n  3. 停止整个服务并退出\n  4. 重试启动 / 检查服务\n  5. 打开实盘报表\n  6. 打开模拟盘报表\n  0. 关闭控制窗口，后台服务继续运行\n==================================================\n日志：data/server-out.log 和 data/server-error.log\n请选择 [1/2/3/4/5/6/0]，按回车确认：');
  menu();
  for await(const answer of pendingAnswers){
    const action=answer.trim();
    if(action==='0'){write('已关闭控制台，后台服务继续运行。需要停止时请双击“停止服务.bat”。');return;}
    try{
      if(action==='3'){write('正在暂停策略并停止服务，请稍候…');write(stoppedMessage(await stop(base)));return;}
      if(['1','2','5','6'].includes(action))await open(`${base}/${action==='1'?'previous':action==='2'?'previous-live':action==='5'?'live-reports':'reports'}`);
      else if(action==='4')await connect();
      else write('请输入 1、2、3、4、5、6 或 0。');
    }catch(error){write(error.message);}
    menu();
  }
}

async function main(){
  const action=process.argv[2]||'--status',base=serviceUrl();
  if(action==='--console'){
    const lines=createInterface({input:process.stdin,output:process.stdout,terminal:!!process.stdin.isTTY});
    try{await runConsole(base,{answers:lines,openOnStart:!process.argv.includes('--no-browser')});}finally{lines.close();}
    return;
  }
  if(action==='--stop'){
    const result=await stopService(base);
    console.log(stoppedMessage(result));return;
  }
  if(action!=='--ensure'&&action!=='--status')throw Error('不支持的服务控制操作');
  const service=action==='--ensure'?await ensureService(base):await readService(base);
  if(!service){console.log(`服务未运行：${base}`);process.exitCode=1;return;}
  console.log(`服务正在运行：${base} · PID ${service.pid}`);
  console.log('日志：data/server-out.log 和 data/server-error.log');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=2;});
