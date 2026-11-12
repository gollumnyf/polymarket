import React, { useEffect, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Play, Square, ChevronRight, Clock3 } from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import HistoryPanel from './HistoryPanel.jsx';
const money = value => value == null || !Number.isFinite(Number(value)) ? '-' : `$${Number(value).toFixed(4)}`;
const pct = value => value == null || !Number.isFinite(Number(value)) ? '-' : `${(Number(value) * 100).toFixed(2)}%`;

export default function GamMvPage() {
  const [tab, setTab] = useState('orders');
  const [state, setState] = useState(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const api = path => `/gam/api/${path}`;
  async function load() {
    try {
      const response = await fetch(api('state'));
      if (!response.ok) throw Error('鏈嶅姟鏆備笉鍙敤');
      const data = await response.json(); setState(data); setToken(data.controlToken);
    } catch (e) { setError(e.message); }
  }
  async function action(path) {
    try {
      const response = await fetch(api(path), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Control-Token': token }, body: '{}' });
      const data = await response.json(); if (!response.ok) throw Error(data.error); setState(data); await load();
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); const events = new EventSource(api('events')); events.onmessage = event => setState(JSON.parse(event.data)); events.onerror = () => setError('绛夊緟妯℃嫙鏈嶅姟杩炴帴'); return () => events.close(); }, []);
  const signal = state?.gam; const account = state?.accounts?.paper;
  const edge = signal?.direction === 'UP' ? signal.fairUp - signal.upCost : signal?.direction === 'DOWN' ? signal.fairDown - signal.downCost : -1;
  const ready = edge >= (state?.gamModel?.minEdge ?? 0.02);
  return <div className="app"><Sidebar active="gam" onNavigate={page => location.assign('/' + page)} /><div className="main-shell">
    <header className="topbar"><div className="breadcrumb">Trading desk <ChevronRight size={13} /> <strong>GAM mean variance</strong></div><span className="connection healthy"><i />Service connected</span></header>
    <main><section className="page-heading"><div><div className="eyebrow">YOUR STRATEGY. YOUR RULES.</div><h1>GAM mean variance <span className="mode-label"><Activity size={12} /> PAPER TRADING</span></h1><p>BTC state estimation, residual control, and paired arbitrage.</p></div></section>
      {error && <div className="data-warning">{error}</div>}
      <section className="stats-grid"><div className="stat-card"><div className="stat-label">妯℃嫙鍙敤浣欓</div><div className="stat-value">{money(account?.balance)}</div></div><div className="stat-card"><div className="stat-label">Up 鍏厑浠峰€</div><div className="stat-value">{pct(signal?.fairUp)}</div></div><div className="stat-card"><div className="stat-label">Down 鍏厑浠峰€</div><div className="stat-value">{pct(signal?.fairDown)}</div></div><div className="stat-card"><div className="stat-label">鐩爣娈嬪樊</div><div className="stat-value">{pct(signal?.targetResidual)}</div></div></section>
      <details className="panel range-panel" open><summary className="panel-heading range-summary"><h2><Activity size={17} />GAM model state</h2><span className="range-summary-status">{ready ? `BUY ${signal.direction}` : signal?.message || "WAIT"}</span></summary><div className="range-panel-body"><div className="range-metrics"><div><span>Entry condition</span><strong className={ready ? "green" : ""}>{ready ? "READY" : "WAITING"}</strong></div><div><span>Up / Down fair value</span><strong>{pct(signal?.fairUp)} / {pct(signal?.fairDown)}</strong></div><div><span>Target residual</span><strong>{pct(signal?.targetResidual)}</strong></div><div><span>Paired arbitrage</span><strong>{signal?.arbitrage?.available ? "AVAILABLE" : "WAITING"}</strong></div></div><div className="range-observations"><span>d <b>{Number(signal?.d || 0).toFixed(5)}</b></span><span>v <b>{Number(signal?.v || 0).toFixed(5)}</b></span><span>tau <b>{Number(signal?.tau || 0).toFixed(1)} sec</b></span><span>OFI <b>{Number(signal?.ofi || 0).toFixed(3)}</b></span><span>z <b>{Number(signal?.z || 0).toFixed(4)}</b></span></div><p className="range-data-note">BUY when fair value minus the matching ask is at least {pct(state?.gamModel?.minEdge)} and all risk checks pass.</p></div></details>
      <div className="trading-grid"><div className="market-column"><GamMarket state={state} signal={signal} /><section className="signal-bar"><div className="signal-icon"><Activity size={18} /></div><div><span className="mini-label">当前策略信号</span><p><b>{ready ? `买入 ${signal.direction}` : '等待'}</b><span>{signal?.message || '等待有效行情和入场边际'}</span></p></div></section></div><aside className="strategy-column"><section className="panel strategy-panel"><div className="panel-heading"><h2>策略控制</h2><span className="version-tag">GAM + MV</span></div><p>当前信号：<b>{signal?.message || '等待行情'}</b></p><div className="button-row"><button className="button primary" onClick={() => action('paper/start')}><Play size={15} />启动策略</button><button className="button secondary" onClick={() => action('paper/stop')}><Square size={15} />暂停策略</button></div></section></aside></div>
      <HistoryPanel mode="paper" tab={tab} setTab={setTab} account={account} currentRound={Math.floor(Date.now() / 300000) * 300} connected={true} spot={state?.spot} now={Date.now()} spotError={state?.errors?.spot} />
    </main></div></div>;
}

function GamMarket({ state, signal }) {
  const now = state?.time || Date.now();
  const round = Math.floor(now / 300000) * 300;
  const left = Math.max(0, round + 300 - Math.floor(now / 1000));
  const ticks = (state?.ticks || []).filter(point => point.time >= round * 1000).slice(-180);
  const values = ticks.map(point => Number(point.price)).filter(Number.isFinite);
  const min = Math.min(...values, Number(state?.spot?.price) || 0); const max = Math.max(...values, Number(state?.spot?.price) || 1); const span = Math.max(1, max - min);
  const points = values.map((value, index) => `${(index / Math.max(1, values.length - 1)) * 100},${100 - ((value - min) / span) * 82 - 9}`).join(' ');
  const book = state?.books || {};
  return <section className="panel market-panel"><div className="market-heading"><div className="market-identity"><span className="bitcoin">₿</span><div><h2>Bitcoin <span>UP / DOWN</span></h2><p>BTC 公允价值与盘口 · 5 分钟市场</p></div></div><span className="round-link">第 {round} 场</span></div><div className="round-timing"><span className="active-label"><i />当前场次</span><span className="round-slug">#{round}</span><span className="countdown"><Clock3 size={14} /> 距离结束 <strong>{String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}</strong></span></div><div className="round-progress"><span style={{ width: `${Math.min(100, ((300 - left) / 3))}%` }} /></div><div className="chart-toolbar"><div><span className="mini-label">BTC 实时参考价</span><div className="btc-value">{money(state?.spot?.price)}</div><div className="price-caption">本场起始价 {money(state?.spot?.currentOpen)}</div></div><div className="chart-range"><button className="active">本场</button><button>近 30 分钟</button></div></div><div className="gam-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={points} fill="none" stroke="#72c9a5" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg></div><div className="chart-legend"><span><i className="legend-price" /> Chainlink 实时参考价</span><span><i className="legend-reference" /> 本场起始价 <b>{money(state?.spot?.currentOpen)}</b></span></div><div className="outcome-grid"><div className="outcome up"><ArrowUp size={20} /><div><strong>看涨 UP</strong><small>卖一 {money(book.UP?.asks?.[0]?.price || signal?.upCost)}</small></div><div className="outcome-price">{pct(signal?.fairUp)}<span>公允价值</span></div></div><div className="outcome down"><ArrowDown size={20} /><div><strong>看跌 DOWN</strong><small>卖一 {money(book.DOWN?.asks?.[0]?.price || signal?.downCost)}</small></div><div className="outcome-price">{pct(signal?.fairDown)}<span>公允价值</span></div></div></div></section>;
}

