import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownLeft, ArrowDownRight, ArrowUpRight, ArrowUp, ArrowDown, BarChart3, Bell, BookOpen, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, CirclePause, Clock3, Download, ExternalLink, FlaskConical, Gauge, Info, Layers3, LoaderCircle, Play, Radio, RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, Wallet, X, Zap } from 'lucide-react';
import './styles.css';
import { submitAction, latestSnapshot, startWithAmount, apiPath } from './api.mjs';
import HistoricalRounds from './HistoricalRounds.jsx';
import HistoryPanel from './HistoryPanel.jsx';
import Settings from './StrategySettings.jsx';
import RangeStatus,{RangeGuide} from './RangeStatus.jsx';
import Sidebar from './Sidebar.jsx';
import ReportsPage from './ReportsPage.jsx';
import {entryModeLabel,oppositeDirection} from './entry-mode.mjs';

const fmt = (n, digits = 2) => n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const cash = n => n == null ? '—' : `$${fmt(n)}`;
const signed = n => n == null ? '—' : `${n >= 0 ? '+' : '−'}$${fmt(Math.abs(n))}`;
const time = (seconds, includeSeconds = false) => new Date(seconds * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', ...(includeSeconds ? { second: '2-digit' } : {}), hour12: false });
const roundName = seconds => `${time(seconds)} – ${time(seconds + 300)}`;

function App() {
  const paperPage=location.pathname.startsWith('/range');
  const rangeMode=true;
  const momentum=false;
  const automaticMode=rangeMode;
  const pageTitle=paperPage?'区间突破模拟':'实盘交易';
  const [mode, setMode] = useState(paperPage ? 'paper' : 'live');
  const [state, setState] = useState(null);
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState(false);
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
  useEffect(() => { if (location.pathname.startsWith('/momentum') || location.pathname === '/' || location.pathname === '/paper') location.replace('/live'); }, []);
  useEffect(() => {
    let stopped = false;
    let retry;
    async function initial() {
      try {
        const response = await fetch(apiPath('state'));
        if (!response.ok) throw new Error('服务暂不可用');
        const data = await response.json();
        if (!stopped) { setState(current => latestSnapshot(current, data)); setToken(data.controlToken); setOffset(data.time - Date.now()); }
      } catch { if (!stopped) retry = setTimeout(initial, 3000); }
    }
    initial();
    const events = new EventSource(apiPath('events'));
    events.onmessage = event => {
      const data = JSON.parse(event.data); setState(current => latestSnapshot(current, data)); setOffset(data.time - Date.now()); setConnected(true);
    };
    events.onerror = () => setConnected(false);
    events.onopen = initial;
    const timer = setInterval(() => setClock(Date.now()), 250);
    return () => { stopped = true; clearTimeout(retry); events.close(); clearInterval(timer); };
  }, []);
  useEffect(() => { const pop = () => setMode(location.pathname.startsWith('/range') ? 'paper' : 'live'); addEventListener('popstate', pop); return () => removeEventListener('popstate', pop); }, []);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 5500); return () => clearTimeout(id); }, [toast]);

  const account = state?.accounts[mode];
  const sequenceLosses = account?.projectedLosses ?? account?.losses ?? 0;
  const now = clock + offset;
  const start = Math.floor(now / 300000) * 300;
  const left = Math.max(0, Math.ceil(start + 300 - now / 1000));
  const spot = state?.spot;
  const freshSpot = connected && spot && spot.round === start && now - spot.at < 8000 && !state?.errors.spot;
  const followPrevious=Boolean(account?.config.followPreviousAtOpen);
  const reverseSignal=Boolean(account?.config.reverseSignal);
  const previousPrediction=state?.previousRoundPrediction?.round===start-300?state.previousRoundPrediction:null;
  const strategySignal=automaticMode?(freshSpot?state?.entrySignal?.direction:null):reverseSignal?(freshSpot?oppositeDirection(spot.direction):null):followPrevious?previousPrediction?.outcome:freshSpot?spot.direction:null;
  const freshMarket = connected && state?.market?.round === start && now - state.market.fetchedAt < 22000 && !state?.errors.market;
  const books = freshMarket ? state.books : {};
  const activeOrders = account?.activeOrders || [];
  const pnl = account?.pnl || 0;
  const live = mode === 'live';
  const balances = live ? state?.live.balance : account?.balance;
  const change = spot?.round === start ? spot.change ?? null : null;
  const previousChange = spot?.round === start ? spot.previousChange ?? null : null;
  const bookFresh = direction => connected && books[direction] && now - books[direction].fetchedAt < 8000 && !state?.errors.books;
  const best = direction => bookFresh(direction) && books[direction]?.asks[0] ? Number(books[direction].asks[0].price) : null;
  const baseLocked = Boolean(account?.running || activeOrders.length > 0);
  const baseDirty = account && Number(base) !== account.config.baseAmount;
  useEffect(() => {
    if (account && (!editingBase || baseLocked)) setBase(String(account.config.baseAmount));
    if (baseLocked) setEditingBase(false);
  }, [mode, account?.config.baseAmount, editingBase, baseLocked]);

  function switchMode(next) { location.assign(['range','reports'].includes(next)?`/${next}`:'/live'); }
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

  return <div className={`app ${live ? 'live-mode' : ''}`}>
    <Sidebar active={paperPage?'range':'live'} onNavigate={switchMode} onSettings={()=>setModal('settings')} onGuide={()=>setModal('guide')} onConnection={()=>setModal('connection')}/>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">交易工作台 <ChevronRight size={13}/><strong>{pageTitle || (live ? '实盘交易' : '模拟交易')}</strong></div><div className="top-actions"><span className={`connection ${freshSpot && freshMarket ? 'healthy' : ''}`}><i/>{freshSpot && freshMarket ? '市场数据已连接' : !connected ? '正在连接本地服务' : '等待市场数据'}</span><span className="top-divider"/><button className="icon-button" aria-label="使用帮助" onClick={() => setModal('guide')}><CircleHelp size={18}/></button><button className="icon-button notification" aria-label="查看运行日志" onClick={() => { setTab('logs'); document.querySelector('#history')?.scrollIntoView({ behavior: 'smooth' }); }}><Bell size={18}/>{Object.keys(state?.errors || {}).length > 0 && <i/>}</button></div></header>
      <main>
        <section className="page-heading"><div><div className="eyebrow">YOUR STRATEGY. YOUR RULES.</div><h1>{pageTitle || (live ? '实盘交易' : '模拟交易')}<span className={`mode-label ${live ? 'amber' : ''}`}>{live ? <Zap size={12}/> : <FlaskConical size={12}/>} {live ? 'LIVE TRADING' : 'PAPER TRADING'}</span></h1><p>{rangeMode?(live?'跟随区间突破模拟的方向信号；实盘资金、交易记录和日志独立。':'边界区域暂停下单，回到中间区域恢复；买价严格低于 0.50。'):momentum?'官方本场方向与最新变动同向，使用 ≤ 0.50 的盘口买入；独立模拟资金。':live ? '连接你的 Polymarket 钱包，用真实资金执行策略。' : '真实市场行情，虚拟资金执行。让策略先经过市场检验。'}</p></div><div className="page-heading-actions">{!live && <button className="button secondary small" disabled={!account || busy} onClick={() => setModal('reset')}><RefreshCw size={15}/>重置模拟账户</button>}<button className="button secondary small" onClick={() => setModal('connection')}><Radio size={15}/> {live ? (state?.live.authenticated ? '钱包已连接' : '连接交易钱包') : '数据源状态'}<ChevronRight size={14}/></button></div></section>

        {Object.keys(state?.errors || {}).length > 0 && <div className="data-warning"><Info size={16}/><span>部分行情暂不可用，请查看连接详情与策略状态。<button onClick={() => setModal('connection')}>查看连接详情 <ArrowUpRight size={12}/></button></span></div>}
        {live && !state?.live.authenticated && <div className="live-notice"><ShieldCheck size={19}/><div><strong>实盘交易需要本机授权</strong><span>在本机 .env 配置钱包后连接。策略默认暂停，启用后才会使用真实资金。</span></div><button className="text-button" onClick={() => setModal('connection')}>配置说明 <ArrowUpRight size={15}/></button></div>}

        <section className="stats-grid">
          <Stat icon={Wallet} title={live ? '钱包可用余额' : '模拟可用余额'} value={cash(balances)}><span className="subtle">{live ? (state?.live.balanceAt ? `更新于 ${new Date(state.live.balanceAt).toLocaleTimeString('zh-CN')}` : '连接钱包后读取') : `初始资金 ${cash(account?.startingBalance ?? account?.config.initialBalance)}`}</span><span className="unit-tag">pUSD</span></Stat>
          <Stat icon={BarChart3} title="累计净盈亏" value={signed(pnl)} positive={pnl >= 0}><span className="subtle">{live ? '按成交与市场费率估算' : '已结算交易 · 已计入估算手续费'}</span>{!live && account?.settled > 0 && <span className="stat-percent">{fmt(pnl / (account.startingBalance ?? account.config.initialBalance) * 100)}%</span>}</Stat>
          <Stat icon={Gauge} title="策略胜率" value={account?.settled ? `${fmt(account.wins / account.settled * 100, 1)}%` : '—'}><span className="subtle"><span className="green">{account?.wins || 0} 胜</span><span className="slash">/</span>{(account?.settled || 0) - (account?.wins || 0)} 负</span><span className="subtle">共 {account?.settled || 0} 场</span></Stat>
          <Stat icon={Layers3} title="下一笔投入" value={cash(account?.nextAmount)}><span className="subtle">{sequenceLosses ? `${account?.projectedCount ? '预计连败' : '连续失利'} ${sequenceLosses} 场` : '首笔金额 · 等待入场'}</span><span className="multiplier">{2 ** sequenceLosses}×</span></Stat>
        </section>

        <div className="trading-grid"><div className="market-column">{rangeMode&&<RangeStatus state={state} mode={mode}/>}
          <section className="panel market-panel">
            <div className="market-heading"><div className="market-identity"><span className="bitcoin">₿</span><div><h2>Bitcoin <span>UP / DOWN</span></h2><p>BTC 涨跌预测 <span>·</span> 5 分钟市场</p></div></div><a className="round-link" href={`https://polymarket.com/event/btc-updown-5m-${start}`} target="_blank" rel="noreferrer"><span>{roundName(start)}</span><ExternalLink size={13}/></a></div>
            <div className="round-timing"><span className="active-label"><i/>当前场次</span><span className="round-slug">#{start}</span><span className="countdown"><Clock3 size={14}/> 距本场结束 <strong>{String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}</strong></span></div>
            <div className="round-progress"><span style={{ width: `${(300 - left) / 3}%` }}/></div>
            <HistoricalRounds momentum={automaticMode} round={start} mode={mode} entryDelay={account?.config.entryDelay ?? 5} followPreviousAtOpen={followPrevious} reverseSignal={reverseSignal}/>
            <div className="chart-toolbar"><div><span className="mini-label">BTC 官方参考价 <span className="price-source">{spot?.windowSeconds ? `CHAINLINK TWAP ${spot.windowSeconds}s` : 'CHAINLINK'}</span></span><div className="btc-value">{spot ? cash(spot.price) : '等待行情'}{change != null && <span className={change >= 0 ? 'price-change green' : 'price-change red'}>{change >= 0 ? <ArrowUpRight size={15}/> : <ArrowDownRight size={15}/>} 本场 {fmt(Math.abs(change))} ({fmt(Math.abs(spot.changePercent))}%)</span>}</div><div className="price-caption round-change-caption"><span>本场起始 {cash(spot?.round === start ? spot.currentOpen : null)}</span><span title="上一场起始价至上一场结束；收盘报价待公布时使用同源本场开盘边界">上一场 {previousChange == null ? '待公布' : <b className={previousChange >= 0 ? 'green' : 'red'}>{previousChange >= 0 ? '↑ 上涨' : '↓ 下跌'} {fmt(Math.abs(previousChange))}</b>}</span>{spot && !freshSpot && <b>数据待更新</b>}</div></div><div className="chart-range"><button className={range === 'round' ? 'active' : ''} onClick={() => setRange('round')}>本场</button><button className={range === '30m' ? 'active' : ''} onClick={() => setRange('30m')}>近 30 分钟</button></div></div>
            <PriceChart zone={rangeMode?(state?.rangeState||state?.rangeAnalysis?.candidate):null} boundary={rangeMode?state?.entrySignal?.boundary:null} edgePercent={state?.rangeConfig?.edgePercent??20} ticks={state?.ticks || []} reference={spot?.round === start ? spot.currentOpen : null} start={start} now={now} range={range}/>
            <div className="chart-legend"><span><i className="legend-price"/> Chainlink 实时参考价</span><span><i className="legend-reference"/> 本场起始价 <b>{cash(spot?.round === start ? spot.currentOpen : null)}</b></span><span className="update-time">{freshSpot ? <><i className="live-dot"/>Polymarket 实时流</> : '等待数据连接'}</span></div>
            {rangeMode&&<div className="chart-zone-legend"><span><i className="middle"/>中间区域 {Number((100-2*(state?.rangeConfig?.edgePercent??20)).toFixed(6))}% · 允许检测下单</span><span><i className="edge"/>上下边界各 {state?.rangeConfig?.edgePercent??20}% · 暂停新单</span></div>}
            <div className="outcome-grid">{['UP', 'DOWN'].map(direction => <div className={`outcome ${direction.toLowerCase()}`} key={direction}><span className="outcome-arrow">{direction === 'UP' ? <ArrowUp size={20}/> : <ArrowDown size={20}/>}</span><div><strong>{direction === 'UP' ? '看涨' : '看跌'} <span>{direction}</span></strong><small>{bookFresh(direction) ? `买一 ${fmt(Number(books[direction].bids[0]?.price || 0) * 100, 1)}¢` : '等待实时盘口'}</small></div><div className="outcome-price">{best(direction) != null ? <>{fmt(best(direction) * 100, 1)}</> : '—'}<span>卖一价格</span></div></div>)}</div>
          </section>

          <section className={`signal-bar ${strategySignal?.toLowerCase() || 'neutral'}`}><div className="signal-icon">{strategySignal==='UP'?<ArrowUp size={18}/>:strategySignal==='DOWN'?<ArrowDown size={18}/>:<Activity size={18}/>}</div><div><span className="mini-label">当前策略信号</span><p>{automaticMode?<><b className={strategySignal==='UP'?'green':strategySignal==='DOWN'?'red':''}>{strategySignal||'WAIT'}</b><span>{state?.entrySignal?.message||'等待区间突破策略信号'}{state?.entrySignal?.previousPrice!=null&&<> · {fmt(state.entrySignal.previousPrice,4)} → {fmt(state.entrySignal.latestPrice,4)}</>}</span></>:followPrevious ? previousPrediction ? <><b className={strategySignal==='UP'?'green':'red'}>{strategySignal}</b><span>跟随上一场预计方向 · 开盘后 {account?.config.entryDelay ?? 5} 秒入场{previousPrediction.source==='polymarket_last_second'?' · 末秒预测':''}</span></> : '等待上一场预计方向' : freshSpot && Number.isFinite(spot.currentOpen) ? <><b className={strategySignal === 'UP' ? 'green' : strategySignal === 'DOWN' ? 'red' : ''}>{strategySignal || '持平'}</b><span>{reverseSignal?`本场信号 ${spot.direction || '持平'} · 反向买入` : <>当前价 {spot.price >= spot.currentOpen ? '≥' : '<'} 本场起始价</>}</span></> : freshSpot ? '本场起始价待公布，暂不生成信号' : '等待有效行情后生成信号'}</p></div><div className="signal-rule">{rangeMode?'区间 / 突破 < 0.50':momentum?'官方同向 ≤ 0.50':reverseSignal?'反向买入':followPrevious?'跟随上一场':'顺势入场'}<ChevronRight size={14}/><span>每场一次</span></div></section>
        </div>

        <aside className="strategy-column">
          <section className="panel strategy-panel"><div className="panel-heading"><h2><SlidersHorizontal size={17}/>策略控制</h2><span className="version-tag">MARTINGALE</span></div><div className="strategy-name"><span className="strategy-symbol"><Layers3 size={20}/></span><div><strong>{rangeMode?'区间突破马丁策略':momentum?'官方同向马丁策略':'马丁格尔策略'}</strong><small>亏损加倍 · 获胜复位</small></div><span className="strategy-check"><Check size={14}/></span></div>
            <div className="amount-field">
              <label htmlFor="baseAmount">首笔投入金额 <Info size={12}/></label>
              <div className="amount-input"><span>$</span><input id="baseAmount" type="number" min="1" step="0.01" value={baseLocked ? String(account.config.baseAmount) : base} onFocus={() => setEditingBase(true)} onChange={e => setBase(e.target.value)} disabled={busy || !account || baseLocked}/><span>pUSD</span></div>
              {baseDirty && !baseLocked ? <p className="amount-hint">启动时自动保存并使用输入金额。</p> : account && <p className="amount-hint">生效首笔 {cash(account.config.baseAmount)} · 下一笔 {cash(account.nextAmount)}</p>}
            </div>
            <div className="strategy-details"><div><span>加倍倍数</span><strong>2.0 <span>×</span></strong></div><div><span>入场时间</span><strong>{rangeMode?'开盘立即尝试':momentum?'首个符合条件的新报价':<>开盘后 {account?.config.entryDelay ?? '—'} 秒</>}</strong></div><div><span>单场买入次数</span><strong>1 次 <ShieldCheck size={12}/></strong></div><div><span>入场模式</span><strong>{rangeMode?'区间 / 突破 < 0.50':momentum?'官方双价同向 ≤ 0.50':entryModeLabel(account?.config)}</strong></div><div><span>预计获胜后</span><strong className="green">恢复首笔金额</strong></div></div>
            <button className="advanced-button" onClick={() => setModal('settings')}>高级参数与风险限额 <Settings2 size={14}/></button>
            <div className="strategy-state"><span className={`state-dot ${account?.running ? 'running' : ''}`}/><strong>{account?.running ? '策略运行中' : '策略已暂停'}</strong><span>{account?.running ? 'RUNNING' : 'STANDBY'}</span></div>
            {account?.projectedCount > 0 && <p className="amount-hint">按预计结果续投 · {account.projectedCount} 笔待官方结算</p>}
            <button className={`button primary start-button ${account?.running ? 'stop' : ''}`} disabled={busy || !connected || !account || !token || (live && !state?.live.authenticated)} onClick={() => account.running ? action(`${mode}/stop`) : startStrategy()}>{busy ? <LoaderCircle className="spinning" size={17}/> : account?.running ? <CirclePause size={17}/> : <Play size={16} fill="currentColor"/>}{account?.running ? '暂停策略' : `启动${live ? '实盘' : '模拟'}交易`}</button>
            <div className="execution-note"><ShieldCheck size={12}/>{live ? '使用真实资金，启动前请确认参数' : '仅使用模拟资金，不产生真实订单'}</div>
          </section>

          <section className="panel cycle-panel"><div className="panel-heading"><h2>本轮资金序列</h2><span className="subtle">第 {account?.projectedCycle ?? account?.cycle ?? 1} 轮</span></div><div className="sequence">{Array.from({ length: 4 }, (_, index) => { const step = Math.max(0, sequenceLosses - 2) + index; return <React.Fragment key={step}>{index > 0 && <ChevronRight size={12}/>}<div className={step === sequenceLosses ? 'sequence-step current' : step < sequenceLosses ? 'sequence-step past' : 'sequence-step'}><span>{cash((account?.config.baseAmount || 10) * 2 ** step)}</span><small>{step === sequenceLosses ? '下一笔' : `${2 ** step}×`}</small></div></React.Fragment>; })}</div><div className="cycle-footer"><span>{account?.projectedCount ? '已结算序列盈亏' : '本轮已实现盈亏'}</span><strong className={account?.cyclePnl < 0 ? 'red' : ''}>{signed(account?.cyclePnl || 0)}</strong></div></section>
          <div className="risk-note"><Info size={15}/><p>连败时投入将指数增长。单场获胜不保证覆盖累计亏损，单笔超限会恢复首笔继续；其他限额触发时跳过本次买入并持续检查；错误不会自动暂停。</p></div>
        </aside></div>

        <HistoryPanel spot={spot} now={now} connected={connected} spotError={state?.errors.spot} key={`${mode}:${tab}:${historyClearKey}`} mode={mode} tab={tab} setTab={setTab} account={account} currentRound={start} busy={busy} onClear={kind=>setModal({type:'clear-history',kind})} onReconcile={order => setModal({type:'reconcile',order})}/>
        <footer className="footer"><span><span className="footer-dot"/>PULSE TERMINAL <span className="footer-version">v1.0</span></span><p>行情用于策略参考，结算以 Polymarket 官方结果为准。</p><span>LOCAL WORKSPACE <ShieldCheck size={12}/></span></footer>
      </main>
    </div>
    {toast && <div role="status" className={`toast ${toast.type}`}>{toast.type === 'success' ? <CheckCircle2 size={18}/> : <Info size={18}/>}<span>{toast.text}</span><button onClick={() => setToast(null)} aria-label="关闭提示"><X size={14}/></button></div>}
    {modal && <Modal onClose={() => setModal(null)} title={modal === 'settings' ? '策略参数' : modal === 'connection' ? '连接与数据源' : modal === 'guide' ? '交易规则与使用指南' : modal?.type === 'start' ? '启动实盘交易' : modal === 'reset' ? '重置模拟账户' : modal?.type==='clear-history' ? (modal.kind==='orders'?'清空模拟交易记录':'清空模拟运行日志') : '核对实盘订单'}>
      {modal === 'guide' && rangeMode && <RangeGuide config={state?.rangeConfig} entryWindow={account?.config.entryWindow}/>}
      {modal === 'guide' && momentum && <div className="guide"><div className="guide-step"><b>01</b><div><h3>官方初始价与最新变动同向</h3><p>不设置开盘延迟。开盘后的新鲜官方价格高于本场官方初始价，且最新价高于前一笔官方价时买 UP；两项均下跌时买 DOWN。持平、方向冲突或数据不完整则继续等待，默认截止开盘后 299 秒。报价按本场预言机窗口读取，最近两笔均须在 6 秒内，时间必须递增；首个开盘后报价可以与紧邻开盘前的新鲜报价比较。</p></div></div><div className="guide-step"><b>02</b><div><h3>买价不超过 0.50，每场一次</h3><p>买入使用所选方向官方卖盘，价格必须大于 0、小于 1，且不超过 0.50；不使用买一价、概率或中间价代替可成交价格。遵守 tick、最小份额、滑点和真实深度，含手续费的预算必须能够完整成交。下单前再次核对两项方向。</p></div></div><div className="guide-step"><b>03</b><div><h3>独立马丁账户</h3><p>首笔金额在启动时保存。失利翻倍，任意一场获胜复位；单笔金额超限后从首笔开始新轮。按上一单预计结果继续资金序列，官方结算在后台入账。账户、配置、交易记录和日志独立保存；重启后保持暂停。</p></div></div></div>}
      {modal === 'connection' && !live && <div className="connection-content"><div className="source-item"><Radio size={18}/><div><strong>Polymarket 官方市场与盘口</strong><p>{freshMarket?'本场市场已连接':state?.errors.market||'等待本场市场'}；{bookFresh('UP')&&bookFresh('DOWN')?'双向盘口有效':state?.errors.books||'等待有效盘口'}</p></div></div><div className="source-item"><Activity size={18}/><div><strong>Polymarket 官方初始价与价格流</strong><p>{freshSpot?'官方价格流已连接':state?.errors.spot||'等待官方价格流'}</p><p>{state?.entrySignal?.message}</p></div></div><p className="modal-copy">此页面仅执行模拟交易，账户与其他模拟盘独立，价格和盘口均来自 Polymarket 官方。</p></div>}
      {modal === 'settings' && account && <Settings rangeMode={rangeMode} rangeConfig={state?.rangeConfig} momentum={momentum} account={account} mode={mode} busy={busy} pending={activeOrders.length > 0} onSave={async config => { if (await action(`${mode}/config`, config)) setModal(null); }}/ >}
      {modal === 'connection' && live && <div className="connection-content"><div className="source-item"><Radio size={18}/><div><strong>Polymarket · 市场与盘口</strong><p>{freshMarket && bookFresh('UP') && bookFresh('DOWN') ? '已连接 · 每 1 秒检查订单簿' : state?.errors.market || state?.errors.books || '等待本场市场数据'}</p></div><span className={`source-dot ${freshMarket && bookFresh('UP') && bookFresh('DOWN') ? 'ok' : ''}`}/></div><div className="source-item"><Activity size={18}/><div><strong>Polymarket · Chainlink BTC/USD</strong><p>{freshSpot ? '已连接 · 起始价与实时价均来自 Polymarket' : state?.errors.spot || '等待参考价格'}</p></div><span className={`source-dot ${freshSpot ? 'ok' : ''}`}/></div><div className="source-item"><Wallet size={18}/><div><strong>Polymarket 交易钱包</strong><p>{state?.live.authenticated ? state.live.wallet : state?.live.configured ? '本机已配置，尚未连接' : '尚未在本机配置'}</p></div></div><p className="modal-copy">实盘请在项目根目录复制 <code>.env.example</code> 为 <code>.env</code>，仅在你自己的电脑编辑以下字段：</p><pre>POLYMARKET_PRIVATE_KEY=你的签名私钥{'\n'}POLYMARKET_WALLET_ADDRESS=你的交易钱包地址{'\n'}LIVE_TRADING_ENABLED=true</pre><p className="modal-copy">保存后重启服务。钱包需已完成 Polymarket 开通、pUSD 充值及交易授权。不要将密钥发送到聊天或填入网页。本程序不自动申请链上授权。</p><button className="button primary" disabled={busy || !state?.live.configured || !state?.live.enabled} onClick={() => action('live/connect')}>{busy ? <LoaderCircle className="spinning" size={16}/> : <Wallet size={16}/>}连接钱包并读取余额</button>{state?.live.error && <p className="red modal-copy">{state.live.error}</p>}<p className="modal-copy subtle">网络不可达时，可在 .env 设置 HTTPS_PROXY。策略不会使用演示行情替代真实行情。</p></div>}
      {modal === 'guide' && !automaticMode && <div className="guide"><div className="guide-step"><b>01</b><div><h3>以本场开始为参考，决定本场方向</h3><p>开盘后默认第 5 秒，比较 Polymarket 当前 Chainlink/TWAP 价格与本场官方起始价。上涨买 UP，下跌买 DOWN，持平则等待。默认超过开盘 45 秒即跳过本场。四种入场方向规则均按设定延迟执行：不跟随时按本场方向买入；同向买入时要求本场与上一场预计方向一致；跟随上一场时直接买上一场预计方向，不比较本场方向；反向买入时本场 UP 买 DOWN、本场 DOWN 买 UP，持平则等待。</p></div></div><div className="guide-step"><b>02</b><div><h3>一场仅买一次，持有到官方结算</h3><p>模拟盘按真实卖盘逐档计算成交和手续费。实盘发送一次 FOK 订单，深度不足不成交。结算只接受 Polymarket 官方已 resolved 的兑付数据；上一场结束后，用平台该场起始价与终止价预计输赢并继续下一场的资金序列，不等待官方结算；真实盈亏在后台确认后入账。接口尚未返回时，以同源最后一秒报价立即预测；两者均缺失时等待。预计与官方结果不同时记录差异，按官方结果入账并继续运行。</p></div></div><div className="guide-step"><b>03</b><div><h3>失利翻倍，获胜或金额超限复位</h3><p>例如首笔 $5：失利后依次为 $10、$20、$40；任意一场获胜后下一笔回到 $5。获胜按市场方向判定，非按本轮累计回本判定。盘口价格及手续费会影响实际净利润。</p></div></div><div className="guide-step"><b>04</b><div><h3>先验证，再启用实盘</h3><p>模拟盘和实盘使用独立账户状态。重启后策略保持暂停，历史和连败序列继续保留。实盘提交超时不会重试；需核对平台订单。实盘获胜份额请到 Polymarket 领取，钱包可用余额以平台读取值为准。</p></div></div><div className="guide-notice"><Info size={17}/><p>图表与信号按本场 Chainlink/TWAP 口径读取 Polymarket 价格流；实时走势不代表已确认的最终胜负。没有保证盈利的马丁策略；连续失利可能迅速耗尽余额。</p></div><a className="text-button" href="https://docs.polymarket.com/trading/quickstart" target="_blank" rel="noreferrer">Polymarket 官方接口文档 <ExternalLink size={14}/></a></div>}
      {modal?.type === 'start' && <div><p className="modal-copy">本次将使用真实资金执行区间突破策略，方向跟随区间突破模拟；资金序列独立，风险条件不满足时跳过买入并继续检查。</p><div className="confirm-values"><div>钱包<span>{modal.wallet}</span></div><div>下一笔金额<strong>{cash(modal.losses <= modal.config.maxDoublings && modal.amount * 2 ** modal.losses > modal.config.maxAmount ? modal.amount : modal.amount * 2 ** modal.losses)} pUSD</strong></div><div>单笔上限<strong>{cash(modal.config.maxAmount)} · 超限复位</strong></div><div>累计亏损上限<strong>{cash(modal.config.stopLoss)}</strong></div><div>入场模式<strong>区间突破 · 跟随模拟信号 · 买价 &lt; 0.50</strong></div><div>入场时间<strong>开盘立即检测，截止 {Number((modal.config.entryWindow/60).toFixed(4))} 分钟</strong></div><div>失利 / 获胜<strong>金额翻倍 / 恢复 {cash(modal.amount)}</strong></div></div><button className="button primary" disabled={busy} onClick={async () => { if (await action(() => startWithAmount(modal.mode, modal.amount, modal.config, token))) { setEditingBase(false); setModal(null); } }}><Zap size={16}/>确认启动实盘交易</button></div>}
      {modal === 'reset' && <div><p className="modal-copy">模拟可用资金将恢复为 {cash(account.config.initialBalance)}，本次账户统计与连败序列将归零。历史订单保留，同一场次仍不能再次买入。</p><button className="button primary" disabled={busy || account.running || activeOrders.length > 0} onClick={async () => { if (await action('paper/reset')) setModal(null); }}><RefreshCw size={16}/>重置模拟资金</button>{(account.running || activeOrders.length > 0) && <p className="modal-copy subtle">请先暂停策略并等待已有订单结算。</p>}</div>}
      {modal?.type === 'reconcile' && <Reconcile order={modal.order} busy={busy} onSave={async venueOrderId => { if (await action('live/reconcile', { id: modal.order.id, venueOrderId })) setModal(null); }}/ >}
      {modal?.type==='clear-history' && <div><p className="modal-copy">{modal.kind==='orders'?'将清空所有已结束的模拟交易记录。待处理订单、模拟余额、累计盈亏和资金序列会保留，同一场次仍不能重复买入。':'将清空模拟盘当前可见的历史运行日志，之后产生的新日志会继续显示。实盘日志保留。'}</p><button className="button primary" disabled={busy} onClick={async()=>{if(await action(`paper/${modal.kind}/clear`)){setHistoryClearKey(key=>key+1);setModal(null);}}}>{busy?<LoaderCircle className="spinning" size={16}/>:null}确认清空</button></div>}
    </Modal>}
  </div>;
}

function Stat({ icon: Icon, title, value, children, positive }) {
  return <div className="stat-card"><div className="stat-label">{title}<Icon size={16}/></div><div className={`stat-value ${positive === true ? 'green' : positive === false ? 'red' : ''}`}>{value}</div><div className="stat-bottom">{children}</div></div>;
}

function PriceChart({ ticks, reference, start, now, range,zone,boundary,edgePercent=20 }) {
  const [hover, setHover] = useState(null);
  const chartRef = useRef(null);
  const [size, setSize] = useState({ width: 900, height: 300 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(chartRef.current);
    return () => observer.disconnect();
  }, []);
  const { width, height } = size;
  const left = 14, right = width - 62, top = 16, bottom = height - 28;
  const plotWidth = Math.max(1, right - left), plotHeight = Math.max(1, bottom - top);
  const timeLabels = width < 440 ? 4 : 6;
  const points = useMemo(() => ticks.filter(t => t.time >= (range === 'round' ? start * 1000 : now - 1800000) && t.time <= now), [ticks, range, start, Math.floor(now / 1000)]);
  const bounds = points.map(p => p.price);
  if (reference) bounds.push(reference);
  const hasZone=Number.isFinite(zone?.lower)&&Number.isFinite(zone?.upper);
  if(hasZone)bounds.push(zone.lower,zone.upper);
  const entryLower=boundary?.lower??zone?.breakoutReferenceLower??zone?.lower,entryUpper=boundary?.upper??zone?.breakoutReferenceUpper??zone?.upper;
  const hasEntryZone=Number.isFinite(entryLower)&&Number.isFinite(entryUpper)&&entryUpper>entryLower;
  const middleLower=boundary?.middleLower??entryLower+(entryUpper-entryLower)*edgePercent/100,middleUpper=boundary?.middleUpper??entryUpper-(entryUpper-entryLower)*edgePercent/100;
  if(hasEntryZone)bounds.push(entryLower,entryUpper);
  const hasActualZone=Number.isFinite(zone?.actualLower)&&Number.isFinite(zone?.actualUpper);
  if(hasActualZone)bounds.push(zone.actualLower,zone.actualUpper);
  const lo = bounds.length ? Math.min(...bounds) : 0;
  const hi = bounds.length ? Math.max(...bounds) : 1;
  const pad = Math.max((hi - lo) * 0.18, hi * 0.00005, 1);
  const min = lo - pad, max = hi + pad;
  const xmin = range === 'round' ? start * 1000 : now - 1800000;
  const xmax = range === 'round' ? (start + 300) * 1000 : now;
  const x = t => left + (t - xmin) / (xmax - xmin) * plotWidth;
  const y = p => top + (max - p) / (max - min) * plotHeight;
  const path = points.map((p, i) => `${i ? 'L' : 'M'} ${x(p.time).toFixed(2)} ${y(p.price).toFixed(2)}`).join(' ');
  const last = points.at(-1);
  const onMove = event => {
    if (!points.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - rect.left) / rect.width * width;
    const point = points.reduce((best, p) => Math.abs(x(p.time) - position) < Math.abs(x(best.time) - position) ? p : best, points[0]);
    setHover(point);
  };
  const tooltipWidth = 150;
  const tooltipX = hover ? Math.min(Math.max(x(hover.time) - tooltipWidth / 2, left), Math.max(left, right - tooltipWidth)) : left;
  return <div ref={chartRef} className="price-chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="BTC 实时价格曲线与本场起始参考价">
      <defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#54d6aa" stopOpacity="0.17"/><stop offset="100%" stopColor="#54d6aa" stopOpacity="0"/></linearGradient></defs>
      {hasEntryZone&&<g className="chart-entry-zone" pointerEvents="none">
        <rect x={left} y={y(entryUpper)} width={plotWidth} height={y(middleUpper)-y(entryUpper)} fill="#c99a62" opacity="0.09"/>
        <rect x={left} y={y(middleUpper)} width={plotWidth} height={y(middleLower)-y(middleUpper)} fill="#778de9" opacity="0.16"><title>中间区域：{fmt(middleLower)} 至 {fmt(middleUpper)}，不包含两端</title></rect>
        <rect x={left} y={y(middleLower)} width={plotWidth} height={y(entryLower)-y(middleLower)} fill="#c99a62" opacity="0.09"/>
        {[['中部上沿',middleUpper],['中部下沿',middleLower]].map(([label,price])=><g key={label}><line x1={left} x2={right} y1={y(price)} y2={y(price)} stroke="#899fe9" strokeOpacity="0.7" strokeDasharray="3 5"/><text x={right-8} y={y(price)+(label==='中部上沿'?-6:14)} textAnchor="end" className="chart-middle-label">{label} {fmt(price)}</text></g>)}
      </g>}
      {Array.from({ length: 5 }, (_, i) => <g key={i}>
        <line x1={left} x2={right} y1={top + i * plotHeight / 4} y2={top + i * plotHeight / 4} stroke="#232831" strokeDasharray="3 5"/>
        <text x={right + 12} y={top + 3 + i * plotHeight / 4} className="axis-label">{bounds.length ? fmt(max - (max - min) * i / 4, 0) : '—'}</text>
      </g>)}
      {hasZone&&<g><line x1={left} x2={right} y1={y(zone.upper)} y2={y(zone.upper)} stroke="#d99676" strokeDasharray="6 4"/><line x1={left} x2={right} y1={y(zone.lower)} y2={y(zone.lower)} stroke="#8ccaac" strokeDasharray="6 4"/><text x={left+8} y={Math.max(top+10,y(zone.upper)-5)} fill="#d99676" fontSize="11">{zone.phase?'压力':'候选压力'}{zone.resistanceSource==='secondary_pivot'?'（次高峰）':''} {fmt(zone.upper)}</text><text x={left+8} y={Math.min(bottom-4,y(zone.lower)+14)} fill="#8ccaac" fontSize="11">{zone.phase?'支撑':'候选支撑'}{zone.supportSource==='secondary_pivot'?'（次低谷）':''} {fmt(zone.lower)}</text></g>}
      {hasActualZone&&[ ['实际最高',zone.actualUpper,zone.upper,'#d99676'],['实际最低',zone.actualLower,zone.lower,'#8ccaac'] ].filter(([,price,inner])=>price!==inner).map(([label,price,,color])=><g key={label}><line x1={left} x2={right} y1={y(price)} y2={y(price)} stroke={color} strokeDasharray="2 3"/><text x={right-6} y={Math.max(top+10,y(price)-4)} fill={color} fontSize="11" textAnchor="end">{label} {fmt(price)}</text></g>)}
      {reference && <line x1={left} x2={right} y1={y(reference)} y2={y(reference)} stroke="#78818f" strokeDasharray="5 5"/>}
      {points.length > 1 && <>
        <path d={`${path} L ${x(last.time)} ${bottom} L ${x(points[0].time)} ${bottom} Z`} fill="url(#chartFill)"/>
        <path d={path} fill="none" stroke="#61d9b0" strokeWidth="2.3" strokeLinejoin="round" strokeLinecap="round"/>
        <circle cx={x(last.time)} cy={y(last.price)} r="8" fill="#61d9b0" opacity=".12"/><circle cx={x(last.time)} cy={y(last.price)} r="3.5" fill="#61d9b0"/>
      </>}
      {reference && <text x={right-8} y={y(reference)-7} textAnchor="end" className="chart-target-label"><title>本场起始价</title>target</text>}
      {Array.from({ length: timeLabels }, (_, i) => <text key={i} x={left + i * plotWidth / (timeLabels - 1)} y={height - 6} className="axis-label" textAnchor={i === 0 ? 'start' : i === timeLabels - 1 ? 'end' : 'middle'}>{time((xmin + (xmax - xmin) * i / (timeLabels - 1)) / 1000)}</text>)}
      {hover && hover.time >= xmin && hover.time <= xmax && <g>
        <line x1={x(hover.time)} x2={x(hover.time)} y1={top} y2={bottom} stroke="#88929f" strokeDasharray="3 4"/>
        <circle cx={x(hover.time)} cy={y(hover.price)} r="4" fill="#dce9e3"/>
        <rect x={tooltipX} y="1" width={tooltipWidth} height="26" rx="5" fill="#28342e"/>
        <text x={tooltipX + tooltipWidth / 2} y="18" textAnchor="middle" fill="#cde8dc" fontSize="11">{time(hover.time / 1000, true)} · {fmt(hover.price)}</text>
      </g>}
    </svg>
    {points.length < 2 && <div className="chart-empty"><Activity size={24}/><span>{ticks.length ? '正在采集本场价格…' : '连接真实行情，等待价格曲线'}</span><small>曲线仅展示本机已采集的行情数据</small></div>}
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

createRoot(document.getElementById('root')).render(location.pathname.startsWith('/reports')?<ReportsPage/>:<App/>);
