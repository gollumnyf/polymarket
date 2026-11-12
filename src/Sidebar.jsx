import React from 'react';
import { Activity, ArrowUpRight, BarChart3, BookOpen, ExternalLink, Layers3, Settings2, ShieldCheck, SlidersHorizontal, Zap } from 'lucide-react';

export default function Sidebar({ active, onNavigate, onSettings, onGuide, onConnection }) {
  const navigate = onNavigate || (page => location.assign('/' + page));
  const pages = [['range', 'Range simulation', Layers3, '< 0.50'], ['gam', 'GAM mean variance', Activity, 'GAM'], ['live', 'Live trading', Zap, 'LIVE'], ['reports', 'Paper reports', BarChart3, null]];
  return <aside className="sidebar">
    <a href="/live" className="brand" onClick={event => { event.preventDefault(); navigate('live'); }}><span className="brand-icon"><Activity size={24} /></span>pulse<span className="brand-dot">.</span><span className="beta">TERMINAL</span></a>
    <div className="workspace"><span className="workspace-icon"><Layers3 size={18} /></span><div>Trading workspace<small>Personal workspace</small></div><span className="workspace-check"><ShieldCheck size={15} /></span></div>
    <div className="nav-label">Trading desk</div>
    <nav>{pages.map(([page, label, Icon, tag]) => <button key={page} className={'nav-item' + (active === page ? ' selected' : '')} onClick={() => navigate(page)} aria-current={active === page ? 'page' : undefined}><Icon size={18} /><span>{label}</span>{tag && <span className="nav-tag">{tag}</span>}</button>)}</nav>
    {(onSettings || onGuide) && <div className="nav-label second">Tools</div>}
    {onSettings && <button className="nav-item" onClick={onSettings}><SlidersHorizontal size={18} /><span>Strategy settings</span></button>}
    {onGuide && <button className="nav-item" onClick={onGuide}><BookOpen size={18} /><span>Guide</span><ExternalLink size={13} /></button>}
    <div className="sidebar-bottom"><div className="market-note"><span className="mini-label">BUILT FOR</span><div><span className="poly-logo">◆</span> Polymarket <ArrowUpRight size={15} /></div><p>Rules for execution<br />Decisions stay with you.</p></div>{onConnection && <button className="profile" onClick={onConnection}><span className="avatar">P</span><span>Local trading account<small>{active === 'live' ? 'Live trading' : 'Paper trading'}</small></span><Settings2 size={16} /></button>}</div>
  </aside>;
}
