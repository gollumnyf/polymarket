import React from 'react';
import { Activity, ArrowUpRight, BarChart3, Grid2X2, Layers3, Settings2, Zap } from 'lucide-react';
import {PAGES} from './pages.mjs';

const icons={previous:Layers3,'loss-follow':Activity,'streak-reverse':Activity,'streak-reverse-two':Activity,
  'previous-live':Zap,'loss-follow-live':Zap,'market-history':Grid2X2,reports:BarChart3,'reports-live':BarChart3};

export default function Sidebar({ active, onNavigate, onConnection }) {
  const navigate = onNavigate || (page => location.assign('/' + page));
  const renderPage=({id:page,title:label})=>{
    const Icon=icons[page];
    return <button key={page} data-page-id={page} title={`${label} · ${page}`}
      className={'nav-item nav-item-caption' + (active === page ? ' selected' : '')}
      onClick={() => navigate(page)} aria-current={active === page ? 'page' : undefined}>
      <Icon size={18}/><span className="nav-text"><span>{label}</span><small>{page}</small></span>
      {['previous-live','loss-follow-live','reports-live'].includes(page) && <span className="nav-tag">LIVE</span>}
    </button>;
  };
  return <aside className="sidebar">
    <a href="/previous" className="brand" onClick={event => { event.preventDefault(); navigate('previous'); }}><span className="brand-icon"><Activity size={24} /></span>pulse<span className="brand-dot">.</span><span className="beta">TERMINAL</span></a>
    <div className="sidebar-menu">
      <div className="nav-label">交易工作台</div>
      <nav aria-label="交易工作台">
        <div role="group" aria-label="交易页面">{PAGES.filter(page=>page.group!=='data').map(renderPage)}</div>
        <div role="group" aria-label="数据" className="nav-data-group">{PAGES.filter(page=>page.group==='data').map(renderPage)}</div>
      </nav>
    </div>
    <div className="sidebar-bottom"><div className="market-note"><span className="mini-label">BUILT FOR</span><div><span className="poly-logo">◆</span> Polymarket <ArrowUpRight size={15} /></div><p>把交易交给规则<br />把决策留给自己。</p></div></div>
  </aside>;
}
