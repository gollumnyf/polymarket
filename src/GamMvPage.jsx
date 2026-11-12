import React, { useEffect, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Play, Square } from 'lucide-react';
import Sidebar from './Sidebar.jsx';

const money = value => value == null || !Number.isFinite(Number(value)) ? '—' : `$${Number(value).toFixed(4)}`;
const pct = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(2)}%`;
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const statusText = { open: '待结算', placing: '下单中', confirming: '确认中', won: '获胜', lost: '失败', void: '作废', rejected: '已拒绝', uncertain: '待核对' };

export default function GamMvPage() {
  const [state, setState] = useState(null); const [orders, setOrders] = useState([]); const [logs, setLogs] = useState([]); const [token, setToken] = useState(''); const [error, setError] = useState('');
  const api = path => `/gam/api/${path}`;
  async function load() {
    try {
      const response = await fetch(api('state')); if (!response.ok) throw Error('服务暂不可用');
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
  useEffect(() => { load(); const events = new EventSource(api('events')); events.onmessage = event => { const data = JSON.parse(event.data); setState(data); load(); }; events.onerror = () => setError('等待模拟服务连接'); return () => events.close(); }, []);
  const signal = state?.gam; const account = state?.accounts?.paper;
  const entryReady = signal?.direction && ((signal.direction === 'UP' ? signal.fairUp - signal.upCost : signal.fairDown - signal.downCost) >= (state?.gamModel?.minEdge ?? 0.02));
  return <div className="app"><Sidebar active="gam" onNavigate={page => location.assign('/' + page)} /><div className="main-shell"><header className="topbar"><div className="breadcrumb">交易工作台 <ChevronPlaceholder /> <strong>GAM + 均值方差模拟</strong></div><span className="connection healthy"><i />模拟服务</span></header><main>
    <section className="page-heading"><div><div className="eyebrow">GAM · MEAN VARIANCE · ARBITRAGE</div><h1>GAM + 均值方差模拟 <span className="mode-label"><Activity size={12} /> 模拟交易</span></h1><p>根据 BTC 偏离、波动率、剩余时间和订单流失衡估计 Up / Down 价值，并控制方向性残差。</p></div></section>
    {error && <div className="data-warning">{error}</div>}
    <section className="stats-grid"><div className="stat-card"><div className="stat-label">模拟余额</div><div className="stat-value">{money(account?.balance)}</div></div><div className="stat-card"><div className="stat-label">Up 公允价值</div><div className="stat-value">{pct(signal?.fairUp)}</div></div><div className="stat-card"><div className="stat-label">Down 公允价值</div><div className="stat-value">{pct(signal?.fairDown)}</div></div><div className="stat-card"><div className="stat-label">目标残差</div><div className="stat-value">{pct(signal?.targetResidual)}</div></div></section>
    <details className="panel range-panel" open><summary className="panel-heading range-summary"><h2><Activity size={17} />GAM 状态与估值</h2><span className="range-summary-status">{signal?.message || '等待行情'}</span></summary><div className="range-panel-body"><div className="range-metrics"><div><span>买入信号</span><strong className={entryReady ? 'green' : ''}>{entryReady ? `买入 ${signal.direction}` : '等待条件'}</strong></div><div><span>Up / Down 估值</span><strong>{pct(signal?.fairUp)} / {pct(signal?.fairDown)}</strong></div><div><span>目标方向性残差</span><strong>{pct(signal?.targetResidual)}</strong></div><div><span>套利状态</span><strong>{signal?.arbitrage?.available ? '存在套利空间' : '等待配对机会'}</strong></div></div><div className="range-observations"><span>d <b>{Number(signal?.d || 0).toFixed(5)}</b></span><span>v <b>{Number(signal?.v || 0).toFixed(5)}</b></span><span>τ <b>{Number(signal?.tau || 0).toFixed(1)} 秒</b></span><span>OFI <b>{Number(signal?.ofi || 0).toFixed(3)}</b></span><span>z <b>{Number(signal?.z || 0).toFixed(4)}</b></span></div><p className="range-data-note">买入触发：公允价值 − 对应方向卖一价 ≥ 最低边际 {pct(state?.gamModel?.minEdge)}，同时盘口、余额、最小份额和手续费检查通过。</p><p className="range-data-note">Mean-Variance：γ {state?.gamModel?.gamma ?? '—'}，方向性残差上限 Rmax {state?.gamModel?.maxResidual ?? '—'}。已有一侧仓位超过目标残差时，下一步买入另一侧进行对冲。</p></div></details>
    <div className="trading-grid"><div className="market-column"><section className="panel market-panel"><div className="panel-heading"><h2>Up / Down 市场</h2><span className="version-tag">{signal?.direction || 'WAIT'}</span></div><div className="outcome-grid"><div className="outcome up"><ArrowUp size={20} /><div><strong>UP</strong><small>买入成本 {money(signal?.upCost)}</small></div><div className="outcome-price">{pct(signal?.fairUp)}</div></div><div className="outcome down"><ArrowDown size={20} /><div><strong>DOWN</strong><small>买入成本 {money(signal?.downCost)}</small></div><div className="outcome-price">{pct(signal?.fairDown)}</div></div></div></section><section className="panel"><div className="panel-heading"><h2>配对套利</h2></div><p>{signal?.arbitrage ? `Up + Down 成本 ${money(signal.arbitrage.totalCost)}，套利边际 ${money(signal.arbitrage.edge)}。` : '等待两侧盘口。'}</p></section></div><aside className="strategy-column"><section className="panel strategy-panel"><div className="panel-heading"><h2>策略控制</h2><span className="version-tag">GAM + MV</span></div><p>当前信号：<b>{signal?.message || '等待行情'}</b></p><div className="button-row"><button className="button primary" onClick={() => action('paper/start')}><Play size={15} />启动</button><button className="button secondary" onClick={() => action('paper/stop')}><Square size={15} />停止</button></div></section></aside></div>
    <section className="panel history-panel"><div className="panel-heading"><h2>交易记录</h2><span className="range-summary-status">共 {orders.length} 笔</span></div><div className="table-scroll"><table><thead><tr><th>场次</th><th>买入时间</th><th>方向</th><th>投入金额</th><th>成交价</th><th>状态</th><th>盈亏</th></tr></thead><tbody>{orders.map(order => <tr key={order.id}><td>#{order.round}</td><td>{time(order.createdAt)}</td><td><span className={`direction-chip ${String(order.direction).toLowerCase()}`}>{order.direction}</span></td><td>{money(order.cost ?? order.budget)}</td><td>{money(order.price)}</td><td><span className={`status-badge ${order.status}`}><i />{statusText[order.status] || order.status}</span></td><td className={order.pnl >= 0 ? 'green' : 'red'}>{order.pnl == null ? '—' : money(order.pnl)}</td></tr>)}</tbody></table>{orders.length === 0 && <div className="empty-state"><strong>暂无交易记录</strong><p>满足买入条件并启动模拟后，订单会显示在这里。</p></div>}</div></section>
    <section className="panel history-panel"><div className="panel-heading"><h2>运行日志</h2><span className="range-summary-status">最近 {logs.length} 条</span></div><div className="table-scroll"><table><thead><tr><th>时间</th><th>级别</th><th>内容</th></tr></thead><tbody>{logs.map(log => <tr key={log.id}><td>{time(log.time)}</td><td>{log.level}</td><td>{log.message}</td></tr>)}</tbody></table>{logs.length === 0 && <div className="empty-state"><strong>暂无日志</strong></div>}</div></section>
  </main></div></div>;
}

function ChevronPlaceholder() { return <span className="breadcrumb-chevron">›</span>; }
