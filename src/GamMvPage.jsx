import React, { useEffect, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Play, Square } from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import HistoryPanel from './HistoryPanel.jsx';

const money = value => value == null || !Number.isFinite(Number(value)) ? '鈥? : `$${Number(value).toFixed(4)}`;
const pct = value => value == null || !Number.isFinite(Number(value)) ? '鈥? : `${(Number(value) * 100).toFixed(2)}%`;
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '鈥?;
const statusText = { open: '寰呯粨绠?, placing: '涓嬪崟涓?, confirming: '纭涓?, won: '鑾疯儨', lost: '澶辫触', void: '浣滃簾', rejected: '宸叉嫆缁?, uncertain: '寰呮牳瀵? };

export default function GamMvPage() {
  const [tab, setTab] = useState('orders'); const [state, setState] = useState(null); const [orders, setOrders] = useState([]); const [logs, setLogs] = useState([]); const [token, setToken] = useState(''); const [error, setError] = useState('');
  const api = path => `/gam/api/${path}`;
  async function load() {
    try {
      const response = await fetch(api('state')); if (!response.ok) throw Error('鏈嶅姟鏆備笉鍙敤');
      const data = await response.json(); setState(data); setToken(data.controlToken);
      const [ordersResponse, logsResponse] = await Promise.all([fetch(api('paper/orders?page=1&pageSize=50')), fetch(api('paper/logs?page=1&pageSize=50'))]);
      if (ordersResponse.ok) setOrders((await ordersResponse.json()).items || []);
      if (logsResponse.ok) setLogs((await logsResponse.json()).items || []);
    } catch (e) { setError(e.message); }
  }
  async function action(path) {
    try { const response = await fetch(api(path), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Control-Token': token }, body: '{}' }); const data = await response.json(); if (!response.ok) throw Error(data.error); await load(); }
    catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); const events = new EventSource(api('events')); events.onmessage = event => { const data = JSON.parse(event.data); setState(data); load(); }; events.onerror = () => setError('绛夊緟妯℃嫙鏈嶅姟杩炴帴'); return () => events.close(); }, []);
  const signal = state?.gam; const account = state?.accounts?.paper;
  const entryReady = signal?.direction && ((signal.direction === 'UP' ? signal.fairUp - signal.upCost : signal.fairDown - signal.downCost) >= (state?.gamModel?.minEdge ?? 0.02));
  return <div className="app"><Sidebar active="gam" onNavigate={page => location.assign('/' + page)} /><div className="main-shell"><header className="topbar"><div className="breadcrumb">浜ゆ槗宸ヤ綔鍙?<ChevronPlaceholder /> <strong>GAM + 鍧囧€兼柟宸ā鎷?/strong></div><span className="connection healthy"><i />妯℃嫙鏈嶅姟</span></header><main>
    <section className="page-heading"><div><div className="eyebrow">GAM 路 MEAN VARIANCE 路 ARBITRAGE</div><h1>GAM + 鍧囧€兼柟宸ā鎷?<span className="mode-label"><Activity size={12} /> 妯℃嫙浜ゆ槗</span></h1><p>鏍规嵁 BTC 鍋忕銆佹尝鍔ㄧ巼銆佸墿浣欐椂闂村拰璁㈠崟娴佸け琛′及璁?Up / Down 浠峰€硷紝骞舵帶鍒舵柟鍚戞€ф畫宸€?/p></div></section>
    {error && <div className="data-warning">{error}</div>}
    <section className="stats-grid"><div className="stat-card"><div className="stat-label">妯℃嫙浣欓</div><div className="stat-value">{money(account?.balance)}</div></div><div className="stat-card"><div className="stat-label">Up 鍏厑浠峰€?/div><div className="stat-value">{pct(signal?.fairUp)}</div></div><div className="stat-card"><div className="stat-label">Down 鍏厑浠峰€?/div><div className="stat-value">{pct(signal?.fairDown)}</div></div><div className="stat-card"><div className="stat-label">鐩爣娈嬪樊</div><div className="stat-value">{pct(signal?.targetResidual)}</div></div></section>
    <details className="panel range-panel" open><summary className="panel-heading range-summary"><h2><Activity size={17} />GAM 鐘舵€佷笌浼板€?/h2><span className="range-summary-status">{signal?.message || '绛夊緟琛屾儏'}</span></summary><div className="range-panel-body"><div className="range-metrics"><div><span>涔板叆淇″彿</span><strong className={entryReady ? 'green' : ''}>{entryReady ? `涔板叆 ${signal.direction}` : '绛夊緟鏉′欢'}</strong></div><div><span>Up / Down 浼板€?/span><strong>{pct(signal?.fairUp)} / {pct(signal?.fairDown)}</strong></div><div><span>鐩爣鏂瑰悜鎬ф畫宸?/span><strong>{pct(signal?.targetResidual)}</strong></div><div><span>濂楀埄鐘舵€?/span><strong>{signal?.arbitrage?.available ? '瀛樺湪濂楀埄绌洪棿' : '绛夊緟閰嶅鏈轰細'}</strong></div></div><div className="range-observations"><span>d <b>{Number(signal?.d || 0).toFixed(5)}</b></span><span>v <b>{Number(signal?.v || 0).toFixed(5)}</b></span><span>蟿 <b>{Number(signal?.tau || 0).toFixed(1)} 绉?/b></span><span>OFI <b>{Number(signal?.ofi || 0).toFixed(3)}</b></span><span>z <b>{Number(signal?.z || 0).toFixed(4)}</b></span></div><p className="range-data-note">涔板叆瑙﹀彂锛氬叕鍏佷环鍊?鈭?瀵瑰簲鏂瑰悜鍗栦竴浠?鈮?鏈€浣庤竟闄?{pct(state?.gamModel?.minEdge)}锛屽悓鏃剁洏鍙ｃ€佷綑棰濄€佹渶灏忎唤棰濆拰鎵嬬画璐规鏌ラ€氳繃銆?/p><p className="range-data-note">Mean-Variance锛毼?{state?.gamModel?.gamma ?? '鈥?}锛屾柟鍚戞€ф畫宸笂闄?Rmax {state?.gamModel?.maxResidual ?? '鈥?}銆傚凡鏈変竴渚т粨浣嶈秴杩囩洰鏍囨畫宸椂锛屼笅涓€姝ヤ拱鍏ュ彟涓€渚ц繘琛屽鍐层€?/p></div></details>
    <div className="trading-grid"><div className="market-column"><section className="panel market-panel"><div className="panel-heading"><h2>Up / Down 甯傚満</h2><span className="version-tag">{signal?.direction || 'WAIT'}</span></div><div className="outcome-grid"><div className="outcome up"><ArrowUp size={20} /><div><strong>UP</strong><small>涔板叆鎴愭湰 {money(signal?.upCost)}</small></div><div className="outcome-price">{pct(signal?.fairUp)}</div></div><div className="outcome down"><ArrowDown size={20} /><div><strong>DOWN</strong><small>涔板叆鎴愭湰 {money(signal?.downCost)}</small></div><div className="outcome-price">{pct(signal?.fairDown)}</div></div></div></section><section className="panel"><div className="panel-heading"><h2>閰嶅濂楀埄</h2></div><p>{signal?.arbitrage ? `Up + Down 鎴愭湰 ${money(signal.arbitrage.totalCost)}锛屽鍒╄竟闄?${money(signal.arbitrage.edge)}銆俙 : '绛夊緟涓や晶鐩樺彛銆?}</p></section></div><aside className="strategy-column"><section className="panel strategy-panel"><div className="panel-heading"><h2>绛栫暐鎺у埗</h2><span className="version-tag">GAM + MV</span></div><p>褰撳墠淇″彿锛?b>{signal?.message || '绛夊緟琛屾儏'}</b></p><div className="button-row"><button className="button primary" onClick={() => action('paper/start')}><Play size={15} />鍚姩</button><button className="button secondary" onClick={() => action('paper/stop')}><Square size={15} />鍋滄</button></div></section></aside></div>
    <section className="panel history-panel"><div className="panel-heading"><h2>浜ゆ槗璁板綍</h2><span className="range-summary-status">鍏?{orders.length} 绗?/span></div><div className="table-scroll"><table><thead><tr><th>鍦烘</th><th>涔板叆鏃堕棿</th><th>鏂瑰悜</th><th>鎶曞叆閲戦</th><th>鎴愪氦浠?/th><th>鐘舵€?/th><th>鐩堜簭</th></tr></thead><tbody>{orders.map(order => <tr key={order.id}><td>#{order.round}</td><td>{time(order.createdAt)}</td><td><span className={`direction-chip ${String(order.direction).toLowerCase()}`}>{order.direction}</span></td><td>{money(order.cost ?? order.budget)}</td><td>{money(order.price)}</td><td><span className={`status-badge ${order.status}`}><i />{statusText[order.status] || order.status}</span></td><td className={order.pnl >= 0 ? 'green' : 'red'}>{order.pnl == null ? '鈥? : money(order.pnl)}</td></tr>)}</tbody></table>{orders.length === 0 && <div className="empty-state"><strong>鏆傛棤浜ゆ槗璁板綍</strong><p>婊¤冻涔板叆鏉′欢骞跺惎鍔ㄦā鎷熷悗锛岃鍗曚細鏄剧ず鍦ㄨ繖閲屻€?/p></div>}</div></section>
    <section className="panel history-panel"><div className="panel-heading"><h2>杩愯鏃ュ織</h2><span className="range-summary-status">鏈€杩?{logs.length} 鏉?/span></div><div className="table-scroll"><table><thead><tr><th>鏃堕棿</th><th>绾у埆</th><th>鍐呭</th></tr></thead><tbody>{logs.map(log => <tr key={log.id}><td>{time(log.time)}</td><td>{log.level}</td><td>{log.message}</td></tr>)}</tbody></table>{logs.length === 0 && <div className="empty-state"><strong>鏆傛棤鏃ュ織</strong></div>}</div></section>
  <HistoryPanel mode="paper" tab={tab} setTab={setTab} account={account} currentRound={Math.floor(Date.now() / 300000) * 300} connected={true} spot={state?.spot} now={Date.now()} spotError={state?.errors?.spot} /></main></div></div>;
}

function ChevronPlaceholder() { return <span className="breadcrumb-chevron">鈥?/span>; }

