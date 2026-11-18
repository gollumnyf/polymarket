import React from 'react';
import { Activity, ArrowUpRight, BarChart3, BookOpen, ExternalLink, Layers3, Settings2, ShieldCheck, SlidersHorizontal, Zap } from 'lucide-react';

export default function Sidebar({ active, onNavigate, onSettings, onGuide, onConnection }) {
  const navigate = onNavigate || (page => location.assign('/' + page));
  const pages = [['range', '区间突破模拟', Layers3, '< 0.50'], ['previous', '上场方向模拟', Layers3, '≤ 0.70'], ['copy', '跟单观察盘', Activity, '只读'], ['live', '实盘交易', Zap, 'LIVE'], ['reports', '模拟盘报表', BarChart3, null]];
  return <aside className="sidebar">
    <a href="/live" className="brand" onClick={event => { event.preventDefault(); navigate('live'); }}><span className="brand-icon"><Activity size={24} /></span>pulse<span className="brand-dot">.</span><span className="beta">TERMINAL</span></a>
    <div className="workspace"><span className="workspace-icon"><Layers3 size={18} /></span><div>我的交易空间<small>Personal workspace</small></div><span className="workspace-check"><ShieldCheck size={15} /></span></div>
    <div className="nav-label">交易工作台</div>
    <nav>{pages.map(([page, label, Icon, tag]) => <button key={page} className={'nav-item' + (active === page ? ' selected' : '')} onClick={() => navigate(page)} aria-current={active === page ? 'page' : undefined}><Icon size={18} /><span>{label}</span>{tag && <span className="nav-tag">{tag}</span>}</button>)}</nav>
    {(onSettings || onGuide) && <div className="nav-label second">工具与资源</div>}
    {onSettings && <button className="nav-item" onClick={onSettings}><SlidersHorizontal size={18} /><span>策略设置</span></button>}
    {onGuide && <button className="nav-item" onClick={onGuide}><BookOpen size={18} /><span>使用指南</span><ExternalLink size={13} /></button>}
    <div className="sidebar-bottom"><div className="market-note"><span className="mini-label">BUILT FOR</span><div><span className="poly-logo">◆</span> Polymarket <ArrowUpRight size={15} /></div><p>把交易交给规则<br />把决策留给自己。</p></div>{onConnection && <button className="profile" onClick={onConnection}><span className="avatar">P</span><span>本地交易账户<small>{active === 'live' ? '实盘交易' : '模拟交易'}</small></span><Settings2 size={16} /></button>}</div>
  </aside>;
}
