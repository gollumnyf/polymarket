import RangeAdaptivePanel from './RangeAdaptivePanel.jsx';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownLeft, ArrowDownRight, ArrowUpRight, ArrowUp, ArrowDown, BarChart3, Bell, BookOpen, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, CirclePause, Clock3, Download, ExternalLink, FlaskConical, Gauge, Info, Layers3, LoaderCircle, Play, Radio, RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, Wallet, X, Zap } from 'lucide-react';
import './styles.css';
import { submitAction, latestSnapshot, startWithAmount, apiPath } from './api.mjs';
import HistoricalRounds from './HistoricalRounds.jsx';
import HistoryPanel from './HistoryPanel.jsx';
import Settings from './StrategySettings.jsx';
import ChartSettings from './ChartSettings.jsx';
import RangeStatus,{RangeGuide} from './RangeStatus.jsx';
import Sidebar from './Sidebar.jsx';
import ReportsPage from './ReportsPage.jsx';
import {entryModeLabel,oppositeDirection} from './entry-mode.mjs';
import PriceChart from './PriceChart.jsx';
import {chartOpeningReference,mergeChartPrices} from './chart-prices.mjs';
import AccountStats from './AccountStats.jsx';
import StrategyControl from './StrategyControl.jsx';
import PreviousStrategySummary from './PreviousStrategySummary.jsx';
import {connectPageStream} from './page-stream.mjs';
import {PAGE_BY_ID} from './pages.mjs';
import {stakeAmount} from './stake-amount.mjs';

const fmt = (n, digits = 2) => n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const cash = n => n == null ? '—' : `$${fmt(n)}`;
const signed = n => n == null ? '—' : `${n >= 0 ? '+' : '−'}$${fmt(Math.abs(n))}`;
const time = (seconds, includeSeconds = false) => new Date(seconds * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', ...(includeSeconds ? { second: '2-digit' } : {}), hour12: false });
const roundName = seconds => `${time(seconds)} – ${time(seconds + 300)}`;

function App() {
  const pageId=location.pathname.split('/')[1];
  const lossFollowLive=pageId==='loss-follow-live';
  const lossFollow=pageId==='loss-follow'||lossFollowLive;
  const levelLimited=location.pathname.startsWith('/level-limited');
  const previous=levelLimited||lossFollow||location.pathname.startsWith('/previous');
  const previousLive=location.pathname.startsWith('/previous-live');
  const livePage=previousLive||lossFollowLive;
  const paperPage=previous&&!livePage;
  const rangeMode=!previous;
  const momentum=false;
  const automaticMode=rangeMode||previous;
  const pageTitle=PAGE_BY_ID[pageId]?.title??'区间突破实盘';
  const [mode, setMode] = useState(paperPage ? 'paper' : 'live');
  const [state, setState] = useState(null);
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState(false);
  const [walletConnecting,setWalletConnecting]=useState(false);
  const [walletConnectError,setWalletConnectError]=useState(null);
  const [streamPrices,setStreamPrices]=useState([]);
  const [streamOpening,setStreamOpening]=useState(null);
  const [streamRange,setStreamRange]=useState(null);
  const [chartConnected,setChartConnected]=useState(false);
  const [clock, setClock] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [historyClearKey,setHistoryClearKey] = useState(0);
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(new URLSearchParams(location.search).get('settings') === '1' ? 'settings' : null);
  const [tab, setTab] = useState('orders');
  const [range, setRange] = useState('round');
  const [base, setBase] = useState('10');
  const [editingBase, setEditingBase] = useState(false);
  useEffect(() => { if (location.pathname.startsWith('/momentum') || location.pathname === '/' || location.pathname === '/paper') location.replace('/previous'); }, []);
  useEffect(() => {
    let stopped = false;
    let retry;
    let initialTask;
    async function initial() {
      if(initialTask)return initialTask;
      initialTask=(async()=>{
      try {
        const response = await fetch(apiPath('state'));
        if (!response.ok) throw new Error('服务暂不可用');
        const data = await response.json();
        if (!stopped) { setState(current => latestSnapshot(current, data)); setToken(data.controlToken); setOffset(data.time - Date.now()); }
      } catch { if (!stopped) retry = setTimeout(initial, 3000); }
      })().finally(()=>{initialTask=null;});
      return initialTask;
    }
    initial();
    const receivePrices=points=>{
      setStreamPrices(current=>mergeChartPrices(current,points).slice(-2000));
    };
    const stopStream=connectPageStream({url:apiPath('events?chart=1'),
      onState:data=>{setState(current=>latestSnapshot(current,data));setOffset(data.time-Date.now());},
      onPrices:receivePrices,onHistory:receivePrices,
      onRange:value=>setStreamRange(current=>current&&current.round>value.round?current:value),
      onOpening:opening=>setStreamOpening(previous=>previous&&previous.round>opening.round?previous:opening),
      onConnected:value=>{setConnected(value);setChartConnected(value);},
      onOpen:()=>{setClock(Date.now());void initial();},
    });
    const timer = setInterval(() => {if(!document.hidden)setClock(Date.now());}, 250);
    return () => { stopped = true; clearTimeout(retry); stopStream(); clearInterval(timer); };
  }, []);
  useEffect(() => { const pop = () => setMode(/^\/(?:previous|loss-follow|level-limited)(?:\/|$)/.test(location.pathname) ? 'paper' : 'live'); addEventListener('popstate', pop); return () => removeEventListener('popstate', pop); }, []);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 5500); return () => clearTimeout(id); }, [toast]);

  useEffect(()=>{
    if(!livePage||!token)return;
    const abort=new AbortController();
    let retry;
    setWalletConnecting(true);setWalletConnectError(null);
    async function connect(){
      try{
        const response=await fetch(apiPath('live/connect'),{method:'POST',signal:abort.signal,
          headers:{'Content-Type':'application/json','X-Control-Token':token},body:JSON.stringify({automatic:true})});
        if(response.status===202&&!abort.signal.aborted){retry=setTimeout(connect,2000);return;}
        if(!response.ok)throw Error((await response.json()).error||'钱包自动连接失败');
      }catch(error){if(!abort.signal.aborted)setWalletConnectError(error.message);}
      if(!abort.signal.aborted)setWalletConnecting(false);
    }
    void connect();
    return ()=>{abort.abort();clearTimeout(retry);};
  },[livePage,token]);

  const chartTicks=streamPrices;
  const account = state?.accounts[mode];
  const sequenceLosses = account?.projectedLosses ?? account?.losses ?? 0;
  const now = clock + offset;
  const start = Math.floor(now / 300000) * 300;
  const left = Math.max(0, Math.ceil(start + 300 - now / 1000));
  const spot = state?.spot;
  const openingReference=chartOpeningReference(chartTicks,streamOpening,start);
  const chartTarget=openingReference?.price??null;
  const chartRange=streamRange?.round===start?streamRange.zone:null;
  const latestChartPoint=chartTicks.at(-1);
  const chartPrice=latestChartPoint?.price;
  const chartFresh=chartConnected&&latestChartPoint?.time>=Math.max(start*1000,now-8000);
  const freshSpot = connected && spot && spot.round === start && now - spot.at < 8000 && !state?.errors.spot;
  const followPrevious=Boolean(account?.config.followPreviousAtOpen);
  const reverseSignal=Boolean(account?.config.reverseSignal);
  const previousPrediction=state?.previousRoundPrediction?.round===start-300?state.previousRoundPrediction:null;
  const strategySignal=previous?(state?.round===start?state.entrySignal?.direction:null):automaticMode?(freshSpot?state?.entrySignal?.direction:null):reverseSignal?(freshSpot?oppositeDirection(spot.direction):null):followPrevious?previousPrediction?.outcome:freshSpot?spot.direction:null;
  const freshMarket = connected && state?.market?.round === start && now - state.market.fetchedAt < 22000 && !state?.errors.market;
  const books = freshMarket ? state.books : {};
  const activeOrders = account?.activeOrders || [];
  const pnl = account?.pnl || 0;
  const live = mode === 'live';
  const balances = live ? state?.live.balance : account?.balance;
  const change = latestChartPoint?.time>=start*1000&&chartTarget!=null&&!openingReference?.provisional?chartPrice-chartTarget:null;
  const previousChange = spot?.round === start ? spot.previousChange ?? null : null;
  const bookFresh = direction => connected && books[direction] && now - books[direction].fetchedAt < 8000 && !state?.errors.books;
  const best = direction => bookFresh(direction) && books[direction]?.asks[0] ? Number(books[direction].asks[0].price) : null;
  const baseLocked = Boolean(account?.running || activeOrders.length > 0);
  const baseDirty = account && Number(base) !== account.config.baseAmount;
  useEffect(() => {
    if (account && (!editingBase || baseLocked)) setBase(String(account.config.baseAmount));
    if (baseLocked) setEditingBase(false);
  }, [mode, account?.config.baseAmount, editingBase, baseLocked]);

  const adaptive=!!state?.adaptiveExecution&&!live;
  const streakActive=!!(state?.entrySignal?.streakSignal||state?.entrySignal?.lockedStreak);
  const rangeEntryLabel=lossFollow?(state?.lossFollow?`跟随来源 · ${fmt(state.lossFollow.minPrice)}–${fmt(state.lossFollow.maxPrice)}`:'等待来源盘口配置'):paperPage?'盘口限价入场':previous?(account?`固定反买 · ${fmt(account.config.minPrice)}–${fmt(account.config.maxPrice)}`:'固定反买 · 等待配置'):adaptive?'RA-01.1 自动切换 · 成交 ≤ 0.50':streakActive?'反买 · 蓝色区域内 · 不限策略买价':`触发 < 0.50 / 成交 ≤ ${state?.rangeConfig?.executionMaxPrice??0.55}`;

  function switchMode(next) { location.assign(PAGE_BY_ID[next]?.path??'/previous'); }
  async function action(path, body = {}) {
    if (busy) return false;
    setBusy(true);
    try {
      const data = typeof path === 'function' ? await path() : await submitAction(path, body, token);
      setState(current => latestSnapshot(current, data));
      setToken(data.controlToken);
      setOffset(data.time - Date.now());
      setToast({ type: 'success', text: '操作成功' });
      return true;
    } catch (error) { setToast({ type: 'error', text: error.message }); return false; }
    finally { setBusy(false); }
  }
  async function startStrategy() {
    if (live) {
      const amount = Number(base);
      if (!Number.isFinite(amount) || amount < 1) {
        setToast({ type: 'error', text: '请输入至少 1 pUSD 的有效首笔金额' }); return;
      }
      setModal({ type: 'start', mode: 'live', amount, config: { ...account.config },
        losses: sequenceLosses, wallet: state.live.wallet });
    } else {
      if (await action(() => startWithAmount('paper', Number(base), account.config, token))) setEditingBase(false);
    }
  }

  const stakePreview=modal?.type==='start'?stakeAmount(modal.amount,modal.losses,lossFollow?5:0):null;
  const startPreview=stakePreview!=null&&(modal.losses>modal.config.maxDoublings||stakePreview>modal.config.maxAmount)
    ?modal.amount:stakePreview;
  return <div className={`app ${live ? 'live-mode' : ''}`}>
    <Sidebar active={pageId} onNavigate={switchMode} onConnection={()=>setModal('connection')}/>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">交易工作台 <ChevronRight size={13}/><strong>{pageTitle || (live ? '实盘交易' : '模拟交易')}</strong></div><div className="top-actions"><span className={`connection ${freshSpot && freshMarket ? 'healthy' : ''}`}><i/>{freshSpot && freshMarket ? '市场数据已连接' : !connected ? '正在连接本地服务' : '等待市场数据'}</span><span className="top-divider"/><button className="icon-button" aria-label="使用帮助" onClick={() => setModal('guide')}><CircleHelp size={18}/></button><button className="icon-button notification" aria-label="查看运行日志" onClick={() => { setTab('logs'); document.querySelector('#history')?.scrollIntoView({ behavior: 'smooth' }); }}><Bell size={18}/>{Object.keys(state?.errors || {}).length > 0 && <i/>}</button></div></header>
      <main>
        {levelLimited&&state?.levelLimit&&<div className="data-warning"><Info size={16}/><span>区间入场检查：{state.levelLimit.message}</span></div>}
        <section className="page-heading"><div><div className="eyebrow">YOUR STRATEGY. YOUR RULES.</div><h1>{pageTitle || (live ? '实盘交易' : '模拟交易')}<span className={`mode-label ${live ? 'amber' : ''}`}>{live ? <Zap size={12}/> : <FlaskConical size={12}/>} {live ? 'LIVE TRADING' : 'PAPER TRADING'}</span></h1>{!paperPage&&<p>{lossFollowLive?'上场方向模拟连续失利三笔后触发跟随，使用真实钱包执行。':previous?'固定买紧邻上一场的反方向；连续两场同向后跳过一场；同一段走势只跳过一次，之后继续反向买入检查。开盘检查盘口，卖一价须落在策略设置的价格范围内；采用马丁资金规则。':adaptive?'RA-01.1：第 60 秒确认反买方向，第 65 秒截止；连亏两笔后恢复首笔金额。':rangeMode?(live?'继续使用旧区间规则；不跟随模拟盘 RA-01，资金、订单和日志独立。':(state?.rangeConfig?.streakReverseEnabled?`连续 ${state.rangeConfig.streakReverseRounds} 场市场同向后反向锁定，仅蓝色区域内且恢复确认完成后买入。`:`边界暂停，连续 ${state?.rangeConfig?.resumeRounds??2} 场中部收盘确认后恢复；触发 < 0.50，成交 ≤ ${state?.rangeConfig?.executionMaxPrice??0.55}。`)):momentum?'官方本场方向与最新变动同向，使用 ≤ 0.50 的盘口买入；独立模拟资金。':live ? '连接你的 Polymarket 钱包，用真实资金执行策略。' : '真实市场行情，虚拟资金执行。让策略先经过市场检验。'}</p>}</div><div className="page-heading-actions">{!live && <button className="button secondary small" disabled={!account || busy} onClick={() => setModal('reset')}><RefreshCw size={15}/>重置模拟账户</button>}<button className="button secondary small" onClick={() => setModal('connection')}><Radio size={15}/> {live ? (state?.live.authenticated ? '钱包已连接' : walletConnecting?'正在连接钱包…':'连接交易钱包') : '数据源状态'}<ChevronRight size={14}/></button></div></section>

        {lossFollow&&state?.lossFollow&&<div className="data-warning"><Info size={16}/><span>
          来源：上场方向模拟 · 连续失利 {state.lossFollow.losses}/3
          {state.lossFollow.active?' · 跟随中':state.lossFollow.ready?' · 已有触发信号，下一场入场前复核':' · 等待触发'}
          {state.lossFollow.samples[0]?.source==='polymarket_realtime'?' · 含本场实时预计':''}
          {state.lossFollow.ownResult==='won'?' · 本盘已有获胜信号，暂停跟随':''}
        </span></div>}
        {Object.keys(state?.errors || {}).length > 0 && <div className="data-warning"><Info size={16}/><span>部分行情暂不可用，请查看连接详情与策略状态。<button onClick={() => setModal('connection')}>查看连接详情 <ArrowUpRight size={12}/></button></span></div>}
        {live && !state?.live.authenticated && <div className="live-notice"><ShieldCheck size={19}/><div><strong>实盘交易需要本机授权</strong><span>本机 .env 配置齐全时，刷新此页会自动连接 Polymarket。策略默认暂停，启用后才会使用真实资金。</span></div><button className="text-button" onClick={() => setModal('connection')}>配置说明 <ArrowUpRight size={15}/></button></div>}

        <AccountStats account={account} live={live} state={state}/>

        {!live&&!previous&&<RangeAdaptivePanel action={action} busy={busy} active={adaptive}/>}
        <div className="trading-grid"><div className="market-column">{rangeMode&&!adaptive&&<RangeStatus state={state} mode={mode}/>}
          <section className="panel market-panel">
            <div className="market-heading"><div className="market-identity"><span className="bitcoin">₿</span><div><h2>Bitcoin <span>UP / DOWN</span></h2><p>BTC 涨跌预测 <span>·</span> 5 分钟市场</p></div></div><a className="round-link" href={`https://polymarket.com/event/btc-updown-5m-${start}`} target="_blank" rel="noreferrer"><span>{roundName(start)}</span><ExternalLink size={13}/></a></div>
            <div className="round-timing"><span className="active-label"><i/>当前场次</span><span className="round-slug">#{start}</span><span className="countdown"><Clock3 size={14}/> 距本场结束 <strong>{String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}</strong></span></div>
            <div className="round-progress"><span style={{ width: `${(300 - left) / 3}%` }}/></div>
            <HistoricalRounds previousPrediction={previousPrediction} predictionContext={{spot,now,connected,spotError:state?.errors.spot}} activeOrders={activeOrders} momentum={automaticMode} round={start} mode={mode} entryDelay={account?.config.entryDelay ?? 5} followPreviousAtOpen={followPrevious} reverseSignal={reverseSignal}/>
            <div className="chart-toolbar"><div><span className="mini-label">BTC 官方参考价 <span className="price-source">{latestChartPoint?.oracleWindow ? `CHAINLINK TWAP ${latestChartPoint.oracleWindow}s` : 'CHAINLINK'}</span></span><div className="btc-value">{chartPrice != null ? cash(chartPrice) : '等待行情'}{change != null && <span className={change >= 0 ? 'price-change green' : 'price-change red'}>{change >= 0 ? <ArrowUpRight size={15}/> : <ArrowDownRight size={15}/>} 本场 {fmt(Math.abs(change))} ({fmt(Math.abs(change/chartTarget*100))}%)</span>}</div><div className="price-caption round-change-caption"><span>本场起始 {chartTarget==null?'待官方公布':cash(chartTarget)}{openingReference?.provisional?'（待核对）':''}</span><span title="上一场起始价至上一场结束；收盘报价待公布时使用同源本场开盘边界">上一场 {previousChange == null ? '待公布' : <b className={previousChange >= 0 ? 'green' : 'red'}>{previousChange >= 0 ? '↑ 上涨' : '↓ 下跌'} {fmt(Math.abs(previousChange))}</b>}</span>{latestChartPoint && !chartFresh && <b>数据待更新</b>}</div></div><div className="chart-range"><button className={range === 'round' ? 'active' : ''} onClick={() => setRange('round')}>本场</button><button className={range === '30m' ? 'active' : ''} onClick={() => setRange('30m')}>近 30 分钟</button></div></div>
            <PriceChart zone={previous?chartRange:adaptive?state?.adaptiveLevels:rangeMode?(state?.rangeState||state?.rangeAnalysis?.candidate):null} boundary={adaptive?null:rangeMode?state?.entrySignal?.boundary:null} edgePercent={(previous?chartRange?.edgePercent:state?.rangeConfig?.edgePercent)??20} ticks={chartTicks} reference={chartTarget} provisionalReference={openingReference?.provisional} start={start} now={now} range={range}/>
            <div className="chart-legend"><span><i className="legend-price"/> Chainlink 实时参考价</span><span><i className="legend-reference"/> 本场起始价 <b>{cash(chartTarget)}</b>{openingReference?.provisional?'（待核对）':''}</span><span className="update-time">{chartFresh ? <><i className="live-dot"/>Polymarket 实时流</> : chartConnected ? '等待本场报价' : '行情连接中'}</span></div>
            {rangeMode&&!adaptive&&<div className="chart-zone-legend"><span><i className="middle"/>中间区域 {Number((100-2*(state?.rangeConfig?.edgePercent??20)).toFixed(6))}% · 确认后可下单</span><span><i className="edge"/>上下边界各 {state?.rangeConfig?.edgePercent??20}% · 暂停新单</span></div>}
            <div className="outcome-grid">{['UP', 'DOWN'].map(direction => <div className={`outcome ${direction.toLowerCase()}`} key={direction}><span className="outcome-arrow">{direction === 'UP' ? <ArrowUp size={20}/> : <ArrowDown size={20}/>}</span><div><strong>{direction === 'UP' ? '看涨' : '看跌'} <span>{direction}</span></strong><small>{bookFresh(direction) ? `买一 ${fmt(Number(books[direction].bids[0]?.price || 0) * 100, 1)}¢` : '等待实时盘口'}</small></div><div className="outcome-price">{best(direction) != null ? <>{fmt(best(direction) * 100, 1)}</> : '—'}<span>卖一价格</span></div></div>)}</div>
          </section>

          <section className={`signal-bar ${strategySignal?.toLowerCase() || 'neutral'}`}><div className="signal-icon">{strategySignal==='UP'?<ArrowUp size={18}/>:strategySignal==='DOWN'?<ArrowDown size={18}/>:<Activity size={18}/>}</div><div><span className="mini-label">当前策略信号</span><p>{automaticMode?<><b className={strategySignal==='UP'?'green':strategySignal==='DOWN'?'red':''}>{strategySignal||'WAIT'}</b><span>{(state?.round===start?state.entrySignal?.message:null)||(previous?'等待上一场方向':'等待区间突破策略信号')}{state?.entrySignal?.previousPrice!=null&&<> · {fmt(state.entrySignal.previousPrice,4)} → {fmt(state.entrySignal.latestPrice,4)}</>}</span></>:followPrevious ? previousPrediction ? <><b className={strategySignal==='UP'?'green':'red'}>{strategySignal}</b><span>跟随上一场预计方向 · 开盘后 {account?.config.entryDelay ?? 5} 秒入场{previousPrediction.source==='polymarket_last_second'?' · 末秒预测':previousPrediction.source==='polymarket_last_available'?' · 收盘前追溯预测':''}</span></> : '等待上一场预计方向' : freshSpot && Number.isFinite(spot.currentOpen) ? <><b className={strategySignal === 'UP' ? 'green' : strategySignal === 'DOWN' ? 'red' : ''}>{strategySignal || '持平'}</b><span>{reverseSignal?`本场信号 ${spot.direction || '持平'} · 反向买入` : <>当前价 {spot.price >= spot.currentOpen ? '≥' : '<'} 本场起始价</>}</span></> : freshSpot ? '本场起始价待公布，暂不生成信号' : '等待有效行情后生成信号'}</p></div><div className="signal-rule">{rangeMode||previous?rangeEntryLabel:momentum?'官方同向 ≤ 0.50':reverseSignal?'反向买入':followPrevious?'跟随上一场':'顺势入场'}<ChevronRight size={14}/><span>每场一次</span></div></section>
        </div>

        <StrategyControl previous={previous} account={account} busy={busy} connected={connected} token={token} live={live} authenticated={state?.live.authenticated} base={base} baseLocked={baseLocked} baseDirty={baseDirty} setEditingBase={setEditingBase} setBase={setBase} onSettings={()=>setModal('settings')} onToggle={()=>account.running?action(`${mode}/stop`):startStrategy()} adaptive={adaptive} title={lossFollow?"三连亏跟随策略":previous?"固定反买马丁策略":adaptive?"RA-01.1 自适应组合":"区间突破马丁策略"} entryTime={previous?"开盘立即尝试（15 秒内）":adaptive?"第 60–65 秒":"开盘立即尝试"} entryMode={rangeEntryLabel}/></div>

        <HistoryPanel onVisibility={(kind,hidden)=>action(`${mode}/${kind}/visibility`,{hidden})} spot={spot} now={now} connected={connected} spotError={state?.errors.spot} key={`${mode}:${tab}:${historyClearKey}`} mode={mode} tab={tab} setTab={setTab} account={account} currentRound={start} busy={busy} onClear={kind=>setModal({type:'clear-history',kind})} onReconcile={order => setModal({type:'reconcile',order})}/>
        <footer className="footer"><span><span className="footer-dot"/>PULSE TERMINAL <span className="footer-version">v1.0</span></span><p>行情用于策略参考，结算以 Polymarket 官方结果为准。</p><span>LOCAL WORKSPACE <ShieldCheck size={12}/></span></footer>
      </main>
    </div>
    {toast && <div role="status" className={`toast ${toast.type}`}>{toast.type === 'success' ? <CheckCircle2 size={18}/> : <Info size={18}/>}<span>{toast.text}</span><button onClick={() => setToast(null)} aria-label="关闭提示"><X size={14}/></button></div>}
    {modal && <Modal onClose={() => setModal(null)} title={modal === 'settings' ? '策略参数' : modal === 'connection' ? '连接与数据源' : modal === 'guide' ? '交易规则与使用指南' : modal?.type === 'start' ? '启动实盘交易' : modal === 'reset' ? '重置模拟账户' : modal?.type==='clear-history' ? (modal.kind==='orders'?'清空模拟交易记录':'清空模拟运行日志') : '核对实盘订单'}>
      {modal === 'guide' && previousLive && <PreviousStrategySummary live={live}/>}
      {modal === 'guide' && lossFollow && <div className="guide"><p>上场方向模拟连续失利三笔后，下一场复核触发依据，并沿用来源盘的买入方向、跳场规则和价格范围。</p><p>跟随盘独立计算资金轮次。失利后的下一笔为上一笔 × 2 + 5 pUSD，获胜后恢复首笔并等待新一轮触发。</p>{lossFollowLive&&<p>使用真实钱包按盘口提交 FOK 订单，成交、结算和兑换在本盘核对。</p>}</div>}
      {modal === 'guide' && adaptive && <div className="guide"><p>RA-01 在开盘第 60 秒冻结方向，根据历史趋势效率与区间位置选择本场同向、趋势一致确认、连续同向反买；证据不足则空仓。</p><p>仅第 60–65 秒允许买入，使用第 60 秒后获取且不超过 3 秒的官方盘口，成交价不超过 0.50，遵守手续费、tick、份额、深度与原资金风控。每场最多买入一次。</p><p>原余额和马丁序列继续使用，旧持仓照常结算。固定 $6 对照观察与实际模拟账户独立，暂停对照不会暂停策略。实盘仍使用旧区间规则。</p><p>历史独立留出方向命中率 56.32%，不代表未来保证达到 55%，也不代表可成交胜率。</p></div>}
      {modal === 'guide' && rangeMode && !adaptive && <RangeGuide config={state?.rangeConfig} entryWindow={account?.config.entryWindow}/>}
      {modal === 'guide' && momentum && <div className="guide"><div className="guide-step"><b>01</b><div><h3>官方初始价与最新变动同向</h3><p>不设置开盘延迟。开盘后的新鲜官方价格高于本场官方初始价，且最新价高于前一笔官方价时买 UP；两项均下跌时买 DOWN。持平、方向冲突或数据不完整则继续等待，默认截止开盘后 299 秒。报价按本场预言机窗口读取，最近两笔均须在 6 秒内，时间必须递增；首个开盘后报价可以与紧邻开盘前的新鲜报价比较。</p></div></div><div className="guide-step"><b>02</b><div><h3>买价不超过 0.50，每场一次</h3><p>买入使用所选方向官方卖盘，价格必须大于 0、小于 1，且不超过 0.50；不使用买一价、概率或中间价代替可成交价格。遵守 tick、最小份额、滑点和真实深度，含手续费的预算必须能够完整成交。下单前再次核对两项方向。</p></div></div><div className="guide-step"><b>03</b><div><h3>独立马丁账户</h3><p>首笔金额在启动时保存。失利翻倍，任意一场获胜复位；单笔金额超限后从首笔开始新轮。按上一单预计结果继续资金序列，官方结算在后台入账。账户、配置、交易记录和日志独立保存；重启后保持暂停。</p></div></div></div>}
      {modal === 'connection' && !live && <div className="connection-content"><div className="source-item"><Radio size={18}/><div><strong>Polymarket 官方市场与盘口</strong><p>{freshMarket?'本场市场已连接':state?.errors.market||'等待本场市场'}；{bookFresh('UP')&&bookFresh('DOWN')?'双向盘口有效':state?.errors.books||'等待有效盘口'}</p></div></div><div className="source-item"><Activity size={18}/><div><strong>Polymarket 官方初始价与价格流</strong><p>{freshSpot?'官方价格流已连接':state?.errors.spot||'等待官方价格流'}</p><p>{state?.entrySignal?.message}</p></div></div><p className="modal-copy">此页面仅执行模拟交易，账户与其他模拟盘独立，价格和盘口均来自 Polymarket 官方。</p></div>}
      {modal === 'settings' && account && <>{previous&&<ChartSettings independent={levelLimited} disabled={busy||!token||(levelLimited&&(account.running||activeOrders.length>0))} onSave={settings=>action('chart-settings',settings)}/>}<Settings levelLimited={levelLimited} lossFollow={lossFollow} previous={previous} adaptive={adaptive} rangeMode={rangeMode} rangeConfig={state?.rangeConfig} momentum={momentum} account={account} mode={mode} busy={busy} pending={activeOrders.length > 0} onSave={async config => { if (await action(`${mode}/config`, config)) setModal(null); }}/ ></>}
      {modal === 'connection' && live && <div className="connection-content"><div className="source-item"><Radio size={18}/><div><strong>Polymarket · 市场与盘口</strong><p>{freshMarket && bookFresh('UP') && bookFresh('DOWN') ? '已连接 · 每 1 秒检查订单簿' : state?.errors.market || state?.errors.books || '等待本场市场数据'}</p></div><span className={`source-dot ${freshMarket && bookFresh('UP') && bookFresh('DOWN') ? 'ok' : ''}`}/></div><div className="source-item"><Activity size={18}/><div><strong>Polymarket · Chainlink BTC/USD</strong><p>{freshSpot ? '已连接 · 起始价与实时价均来自 Polymarket' : state?.errors.spot || '等待参考价格'}</p></div><span className={`source-dot ${freshSpot ? 'ok' : ''}`}/></div><div className="source-item"><Wallet size={18}/><div><strong>Polymarket 交易钱包</strong><p>{state?.live.authenticated ? state.live.wallet : walletConnecting ? '正在连接 Polymarket…' : state?.live.configured ? '本机已配置，尚未验证余额' : '尚未读取有效钱包配置'}</p>{state?.live.balanceAt>0&&<p>可用余额 {cash(state.live.balance)} pUSD · {new Date(state.live.balanceAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} 读取</p>}</div></div><p className="modal-copy">实盘请在项目根目录复制 <code>.env.example</code> 为 <code>.env</code>，仅在你自己的电脑编辑以下字段：</p><pre>POLYMARKET_PRIVATE_KEY=你的签名私钥{'\n'}POLYMARKET_WALLET_ADDRESS=你的交易钱包地址{'\n'}LIVE_TRADING_ENABLED=true</pre><p className="modal-copy">保存后刷新实盘页即可自动连接，也可点击下方按钮重新读取配置及余额，无需重启。钱包需已完成 Polymarket 开通、pUSD 充值及交易授权。不要将密钥发送到聊天或填入网页。本程序不自动申请链上授权。</p><button className="button primary" disabled={busy || walletConnecting || !connected || !token} onClick={() => {setWalletConnectError(null);void action('live/connect');}}>{busy ? <LoaderCircle className="spinning" size={16}/> : <Wallet size={16}/>}{state?.live.authenticated?'刷新钱包配置和余额':'连接钱包并读取余额'}</button>{(state?.live.error||(!state?.live.authenticated&&walletConnectError))&&<p className="red modal-copy">{state?.live.error||walletConnectError}</p>}{state?.redemption&&<p className="modal-copy">自动兑换：{state.redemption.configured?'已配置 Relayer':'未配置 Relayer，可在 .env 设置 POLYMARKET_RELAYER_API_KEY 和 POLYMARKET_RELAYER_SIGNER_ADDRESS 后刷新钱包'}。待兑换 {state.redemption.counts.waiting||0} · 待确认 {(state.redemption.counts.submitted||0)+(state.redemption.counts.submitting||0)} · 已兑换 {state.redemption.counts.confirmed||0} · 需核对 {(state.redemption.counts.failed||0)+(state.redemption.counts.uncertain||0)}</p>}<p className="modal-copy subtle">网络不可达时，可在 .env 设置 HTTPS_PROXY。策略不会使用演示行情替代真实行情。</p></div>}
      {modal === 'guide' && !automaticMode && <div className="guide"><div className="guide-step"><b>01</b><div><h3>以本场开始为参考，决定本场方向</h3><p>开盘后默认第 5 秒，比较 Polymarket 当前 Chainlink/TWAP 价格与本场官方起始价。上涨买 UP，下跌买 DOWN，持平则等待。默认超过开盘 45 秒即跳过本场。四种入场方向规则均按设定延迟执行：不跟随时按本场方向买入；同向买入时要求本场与上一场预计方向一致；跟随上一场时直接买上一场预计方向，不比较本场方向；反向买入时本场 UP 买 DOWN、本场 DOWN 买 UP，持平则等待。</p></div></div><div className="guide-step"><b>02</b><div><h3>一场仅买一次，持有到官方结算</h3><p>模拟盘按真实卖盘逐档计算成交和手续费。实盘发送一次 FOK 订单，深度不足不成交。结算只接受 Polymarket 官方已 resolved 的兑付数据；上一场结束后，用平台该场起始价与终止价预计输赢并继续下一场的资金序列，不等待官方结算；真实盈亏在后台确认后入账。接口尚未返回时，以同源最后一秒报价立即预测；两者均缺失时等待。预计与官方结果不同时记录差异，按官方结果入账并继续运行。</p></div></div><div className="guide-step"><b>03</b><div><h3>失利翻倍，获胜或金额超限复位</h3><p>例如首笔 $5：失利后依次为 $10、$20、$40；任意一场获胜后下一笔回到 $5。获胜按市场方向判定，非按本轮累计回本判定。盘口价格及手续费会影响实际净利润。</p></div></div><div className="guide-step"><b>04</b><div><h3>先验证，再启用实盘</h3><p>模拟盘和实盘使用独立账户状态。重启后策略保持暂停，历史和连败序列继续保留。实盘提交超时不会重试；需核对平台订单。实盘获胜份额请到 Polymarket 领取，钱包可用余额以平台读取值为准。</p></div></div><div className="guide-notice"><Info size={17}/><p>图表与信号按本场 Chainlink/TWAP 口径读取 Polymarket 价格流；实时走势不代表已确认的最终胜负。没有保证盈利的马丁策略；连续失利可能迅速耗尽余额。</p></div><a className="text-button" href="https://docs.polymarket.com/trading/quickstart" target="_blank" rel="noreferrer">Polymarket 官方接口文档 <ExternalLink size={14}/></a></div>}
      {modal?.type === 'start' && <div><p className="modal-copy">{lossFollowLive?'使用真实钱包执行三连亏跟随。与上场方向实盘使用同一钱包时，共用可用余额。':previous?'本次将使用真实资金执行上场方向策略，固定买紧邻上一场的反方向，买入价格范围见下方。资金序列独立，风控条件不满足时跳过本场。':'本次将使用真实资金执行区间突破策略，继续使用旧区间规则，不跟随 RA-01；资金序列独立，风险条件不满足时跳过买入并继续检查。'}</p><div className="confirm-values"><div>钱包<span>{modal.wallet}</span></div><div>下一笔金额<strong>{cash(startPreview)} pUSD</strong></div><div>单笔上限<strong>{cash(modal.config.maxAmount)} · 超限复位</strong></div><div>累计亏损上限<strong>{cash(modal.config.stopLoss)}</strong></div><div>入场模式<strong>{previous?rangeEntryLabel:state?.rangeConfig?.streakReverseEnabled?`连续 ${state.rangeConfig.streakReverseRounds} 场同向反买，仅蓝色区域内可买；不限策略买价`:`区间突破 · 触发 < 0.50 · 成交 ≤ ${state?.rangeConfig?.executionMaxPrice??0.55}`}</strong></div><div>入场时间<strong>开盘立即检测，截止 {modal.config.entryWindow} 秒</strong></div><div>失利 / 获胜<strong>{lossFollow?'上一笔 × 2 + 5':'金额翻倍'} / 恢复 {cash(modal.amount)}</strong></div></div><button className="button primary" disabled={busy} onClick={async () => { if (await action(() => startWithAmount(modal.mode, modal.amount, modal.config, token))) { setEditingBase(false); setModal(null); } }}><Zap size={16}/>确认启动实盘交易</button></div>}
      {modal === 'reset' && <div><p className="modal-copy">模拟可用资金将恢复为 {cash(account.config.initialBalance)}，本次账户统计与连败序列将归零。历史订单保留，同一场次仍不能再次买入。</p><button className="button primary" disabled={busy || account.running || activeOrders.length > 0} onClick={async () => { if (await action('paper/reset')) setModal(null); }}><RefreshCw size={16}/>重置模拟资金</button>{(account.running || activeOrders.length > 0) && <p className="modal-copy subtle">请先暂停策略并等待已有订单结算。</p>}</div>}
      {modal?.type === 'reconcile' && <Reconcile order={modal.order} busy={busy} onSave={async venueOrderId => { if (await action('live/reconcile', { id: modal.order.id, venueOrderId })) setModal(null); }}/ >}
      {modal?.type==='clear-history' && <div><p className="modal-copy">{modal.kind==='orders'?'将清空所有已结束的模拟交易记录。待处理订单、模拟余额、累计盈亏和资金序列会保留，同一场次仍不能重复买入。':'将清空模拟盘当前可见的历史运行日志，之后产生的新日志会继续显示。实盘日志保留。'}</p><button className="button primary" disabled={busy} onClick={async()=>{if(await action(`paper/${modal.kind}/clear`)){setHistoryClearKey(key=>key+1);setModal(null);}}}>{busy?<LoaderCircle className="spinning" size={16}/>:null}确认清空</button></div>}
    </Modal>}
  </div>;
}


function Modal({ title, children, onClose }) {
  useEffect(() => { const onKey = e => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', onKey); const prev = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { removeEventListener('keydown', onKey); document.body.style.overflow = prev; }; }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭窗口"><X size={19}/></button></div>{children}</section></div>;
}

function Reconcile({ order, busy, onSave }) {
  const [id, setId] = useState(order.venueOrderId || '');
  return <form onSubmit={e => { e.preventDefault(); onSave(id); }}><p className="modal-copy">请先到 Polymarket 核对这一场的真实订单，再粘贴完整订单 ID。系统只会读取该订单的官方成交记录，不会重发买单。</p><label className="reconcile-label">平台订单 ID<input value={id} onChange={e => setId(e.target.value)} required placeholder="0x…" pattern="0x[0-9a-fA-F]{64}"/></label><button className="button primary" disabled={busy}><RefreshCw size={16}/>保存并核对成交</button></form>;
}

createRoot(document.getElementById('root')).render(location.pathname.startsWith('/live-reports')?<ReportsPage live/>:location.pathname.startsWith('/reports')?<ReportsPage/>:<App/>);
