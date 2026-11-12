import React, { useEffect, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Play, Square, ChevronRight } from 'lucide-react';
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
      <div className="trading-grid"><div className="market-column"><section className="panel market-panel"><div className="panel-heading"><h2>Up / Down market</h2><span className="version-tag">{signal?.direction || "WAIT"}</span></div><div className="outcome-grid"><div className="outcome up"><ArrowUp size={20} /><div><strong>UP</strong><small>Ask {money(signal?.upCost)}</small></div><div className="outcome-price">{pct(signal?.fairUp)}<span>Fair value</span></div></div><div className="outcome down"><ArrowDown size={20} /><div><strong>DOWN</strong><small>Ask {money(signal?.downCost)}</small></div><div className="outcome-price">{pct(signal?.fairDown)}<span>Fair value</span></div></div></div></section><section className="signal-bar"><div className="signal-icon"><Activity size={18} /></div><div><span className="mini-label">Current signal</span><p><b>{ready ? `BUY ${signal.direction}` : "WAIT"}</b><span>{signal?.message || "Waiting for valid market data"}</span></p></div></section></div><aside className="strategy-column"><section className="panel strategy-panel"><div className="panel-heading"><h2>Strategy control</h2><span className="version-tag">GAM + MV</span></div><p>Signal: <b>{signal?.message || "Waiting"}</b></p><div className="button-row"><button className="button primary" onClick={() => action("paper/start")}><Play size={15} />Start</button><button className="button secondary" onClick={() => action("paper/stop")}><Square size={15} />Pause</button></div></section></aside></div>
      <HistoryPanel mode="paper" tab={tab} setTab={setTab} account={account} currentRound={Math.floor(Date.now() / 300000) * 300} connected={true} spot={state?.spot} now={Date.now()} spotError={state?.errors?.spot} />
    </main></div></div>;
}

