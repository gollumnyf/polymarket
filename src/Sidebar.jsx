import React from 'react';
import { Activity, ArrowUpRight, BarChart3, BookOpen, ExternalLink, Layers3, Settings2, ShieldCheck, SlidersHorizontal, Zap } from 'lucide-react';
import {PAGES} from './pages.mjs';

const icons={previous:Layers3,'level-limited':Layers3,bollinger:Activity,'loss-follow':Activity,
  'previous-live':Zap,reports:BarChart3,'live-reports':BarChart3};

export default function Sidebar({ active, onNavigate, onSettings, onGuide, onConnection }) {
  const navigate = onNavigate || (page => location.assign('/' + page));
  return <aside className="sidebar">
    <a href="/previous" className="brand" onClick={event => { event.preventDefault(); navigate('previous'); }}><span className="brand-icon"><Activity size={24} /></span>pulse<span className="brand-dot">.</span><span className="beta">TERMINAL</span></a>
    <div className="workspace"><span className="workspace-icon"><Layers3 size={18} /></span><div>我的交易空间<small>Personal workspace</small></div><span className="workspace-check"><ShieldCheck size={15} /></span></div>
    <div className="nav-label">交易工作台</div>
    <nav>{PAGES.map(({id:page,title:label}) => {const Icon=icons[page];return <button key={page} data-page-id={page} title={`${label} · ${page}`} className={'nav-item nav-item-caption' + (active === page ? ' selected' : '')} onClick={() => navigate(page)} aria-current={active === page ? 'page' : undefined}><Icon size={18} /><span className="nav-text"><span>{label}</span><small>{page}</small></span>{page==='previous-live' && <span className="nav-tag">LIVE</span>}</button>;})}</nav>
    {(onSettings || onGuide) && <div className="nav-label second">工具与资源</div>}
    {onSettings && <button className="nav-item nav-item-caption" onClick={onSettings} title="策略设置 · strategy-settings"><SlidersHorizontal size={18} /><span className="nav-text"><span>策略设置</span><small>strategy-settings</small></span></button>}
    {onGuide && <button className="nav-item nav-item-caption" onClick={onGuide} title="使用指南 · user-guide"><BookOpen size={18} /><span className="nav-text"><span>使用指南</span><small>user-guide</small></span><ExternalLink size={13} /></button>}
    <div className="sidebar-bottom"><div className="market-note"><span className="mini-label">BUILT FOR</span><div><span className="poly-logo">◆</span> Polymarket <ArrowUpRight size={15} /></div><p>把交易交给规则<br />把决策留给自己。</p></div>{onConnection && <button className="profile" onClick={onConnection}><span className="avatar">P</span><span>本地交易账户<small>{['live','previous-live'].includes(active) ? '实盘交易' : '模拟交易'}</small></span><Settings2 size={16} /></button>}</div>
  </aside>;
}
