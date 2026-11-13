import React,{useEffect,useRef,useState} from 'react';
import {Activity,ChevronRight,ChevronDown} from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import HistoryPanel from './HistoryPanel.jsx';
import GamMarket from './GamMarket.jsx';
import AccountStats from './AccountStats.jsx';
import StrategyControl from './StrategyControl.jsx';
import {apiPath,latestSnapshot,submitAction,startWithAmount} from './api.mjs';

const money=value=>Number.isFinite(value)?'$'+value.toFixed(4):'—';
const pct=value=>Number.isFinite(value)?(value*100).toFixed(2)+'%':'—';
const number=(value,digits=4)=>Number.isFinite(value)?value.toFixed(digits):'—';

export default function GamMvPage(){
  const [tab,setTab]=useState('orders');
  const [state,setState]=useState(null);
  const [token,setToken]=useState('');
  const [connected,setConnected]=useState(false);
  const [connectionError,setConnectionError]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [clock,setClock]=useState(Date.now());
  const [offset,setOffset]=useState(0);
  const [historyKey,setHistoryKey]=useState(0);
  const [base,setBase]=useState('10');
  const [editingBase,setEditingBase]=useState(false);
  const actionBusy=useRef(false);

  useEffect(()=>{
    let stopped=false,retry,controller;
    const accept=data=>{
      if(stopped)return;
      setState(current=>latestSnapshot(current,data));
      setConnectionError('');
    };
    async function load(){
      clearTimeout(retry);controller?.abort();controller=new AbortController();
      try{
        const response=await fetch(apiPath('state'),{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw Error('服务暂不可用');
        const data=await response.json();
        if(!stopped){accept(data);setToken(data.controlToken);setOffset(data.time-Date.now());}
      }catch(e){
        if(!stopped&&e.name!=='AbortError'){setConnectionError(e.message);retry=setTimeout(load,3000);}
      }
    }
    load();
    const events=new EventSource(apiPath('events'));
    events.onopen=()=>{setConnected(true);load();};
    events.onmessage=event=>{
      try{accept(JSON.parse(event.data));setConnected(true);}
      catch{setConnected(false);setConnectionError('状态数据读取失败，等待重新同步');}
    };
    events.onerror=()=>{setConnected(false);setConnectionError('服务连接中断，正在重新连接');};
    const timer=setInterval(()=>setClock(Date.now()),1000);
    return ()=>{stopped=true;clearTimeout(retry);controller?.abort();events.close();clearInterval(timer);};
  },[]);

  async function action(path,body={}){
    if(actionBusy.current)return false;
    actionBusy.current=true;setBusy(true);setError('');
    try{
      const data=typeof path==='function'?await path():await submitAction(path,body,token);
      setState(current=>latestSnapshot(current,data));setToken(data.controlToken);
      return true;
    }catch(e){setError(e.message);return false;}
    finally{actionBusy.current=false;setBusy(false);}
  }
  async function clearHistory(kind){
    const text=kind==='orders'?'清空 GAM 已结束的模拟交易记录？待结算订单、余额和资金序列保留。':'清空 GAM 模拟盘的运行日志？';
    if(window.confirm(text)&&await action('paper/'+kind+'/clear'))setHistoryKey(value=>value+1);
  }

  const now=clock+offset,round=Math.floor(now/300000)*300;
  const account=state?.accounts?.paper,signal=state?.gam;
  const fresh=connected&&state?.spot?.round===round&&now-state.spot.at>=0&&now-state.spot.at<=6000&&!state?.errors?.spot;
  const direction=fresh&&!signal?.code?signal?.direction:null;
  const message=!connected?'等待服务连接':!fresh?'等待本场新鲜官方报价':signal?.message||'等待模型信号';
  const blocked=account?.entryBlock?.round===round?account.entryBlock:null;
  const baseLocked=Boolean(account?.running||account?.activeOrders?.length);
  const baseDirty=account&&Number(base)!==account.config.baseAmount;
  useEffect(()=>{
    if(account&&(!editingBase||baseLocked))setBase(String(account.config.baseAmount));
    if(baseLocked)setEditingBase(false);
  },[account?.config.baseAmount,editingBase,baseLocked]);
  async function toggleStrategy(){
    if(account.running)return action('paper/stop');
    if(await action(()=>startWithAmount('paper',Number(base),account.config,token)))setEditingBase(false);
  }

  return <div className="app"><Sidebar active="gam"/><div className="main-shell">
    <header className="topbar"><div className="breadcrumb">交易工作台 <ChevronRight size={13}/><strong>GAM 均值方差</strong></div><span className={'connection '+(connected?'healthy':'')}><i/>{connected?'服务已连接':'正在连接服务'}</span></header>
    <main>
      <section className="page-heading"><div><div className="eyebrow">GAM · MEAN VARIANCE</div><h1>GAM 均值方差 <span className="mode-label"><Activity size={12}/>模拟交易</span></h1><p>观察模型公允价值、买入边际与均值方差指标。</p></div></section>
      {(error||connectionError)&&<div className="data-warning" role="alert">{error||connectionError}</div>}
      <AccountStats account={account}/>
      <div className="trading-grid"><div className="market-column">
      <details className="panel range-panel">
        <summary className="panel-heading range-summary"><h2><Activity size={17}/>GAM 模型状态</h2><span className="range-summary-status">{direction?'模型偏向 '+direction:message}</span><span className="range-toggle"><span className="range-expand-label">展开</span><span className="range-collapse-label">收起</span><ChevronDown size={16}/></span></summary>
        <div className="range-panel-body">
          <div className="range-metrics"><div><span>模型边际</span><strong className={direction?'green':''}>{direction?'达到阈值':'等待'}</strong></div><div><span>UP / DOWN 公允价值</span><strong>{pct(signal?.fairUp)} / {pct(signal?.fairDown)}</strong></div><div><span>目标残差</span><strong>{pct(signal?.targetResidual)}</strong></div><div><span>双边报价合计（未扣手续费）</span><strong>{money(signal?.arbitrage?.totalCost)}</strong></div></div>
          <div className="range-observations"><span>相对起始价 d <b>{number(signal?.d,5)}</b></span><span>波动输入 v <b>{number(signal?.v,5)}</b></span><span>剩余秒数 τ <b>{number(signal?.tau,1)}</b></span><span>订单流输入 OFI <b>{number(signal?.ofi,3)}</b></span><span>模型得分 z <b>{number(signal?.z)}</b></span></div>
          <p className="range-data-note">模型公允价值减去对应卖一价达到 {pct(state?.gamModel?.minEdge)} 时产生方向信号，实际买入仍须通过行情、盘口与账户限制。目标残差和双边报价目前仅用于展示。</p>
        </div>
      </details>
      <GamMarket state={state} now={now} connected={connected}/><section className={'signal-bar '+(direction?.toLowerCase()||'neutral')}><div className="signal-icon"><Activity size={18}/></div><div><span className="mini-label">当前模型信号</span><p><b>{direction||'等待'}</b><span>{message}</span></p></div></section></div>
        <StrategyControl account={account} busy={busy} connected={connected} token={token} base={base} baseLocked={baseLocked} baseDirty={baseDirty} setEditingBase={setEditingBase} setBase={setBase} onToggle={toggleStrategy} title="GAM 均值方差马丁策略" entryTime="开盘立即检测" entryMode="GAM 估值边际 · 买价 ≤ 0.50"/>
      </div>
      {blocked&&<p className="range-data-note">最近一次未买入原因：{blocked.message}</p>}
      <HistoryPanel onVisibility={(kind,hidden)=>action(`paper/${kind}/visibility`,{hidden})} key={historyKey} mode="paper" tab={tab} setTab={setTab} account={account} currentRound={round} connected={connected} spot={state?.spot} now={now} spotError={state?.errors?.spot} busy={busy} onClear={clearHistory}/>
    </main>
  </div></div>;
}
