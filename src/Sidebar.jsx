import React from 'react';
import {Activity,Layers3,ShieldCheck,Zap,BarChart3,SlidersHorizontal,BookOpen,ExternalLink,ArrowUpRight,Settings2} from 'lucide-react';

export default function Sidebar({active,onNavigate,onSettings,onGuide,onConnection}){
  const navigate=onNavigate||(page=>location.assign('/'+page));
  const pages=[['range','Range simulation',Layers3,'< 0.50'],['gam','GAM mean variance',Activity,'GAM'],['live','Live trading',Zap,'LIVE'],['reports','Paper reports',BarChart3,null]];
  return <aside className="sidebar">
    <a href="/live" className="brand" onClick={event=>{event.preventDefault();navigate('live');}}><span className="brand-icon"><Activity size={24}/></span>pulse<span className="brand-dot">.</span><span className="beta">TERMINAL</span></a>
    <div className="workspace"><span className="workspace-icon"><Layers3 size={18}/></span><div>鎴戠殑浜ゆ槗绌洪棿<small>Personal workspace</small></div><span className="workspace-check"><ShieldCheck size={15}/></span></div>
    <div className="nav-label">浜ゆ槗宸ヤ綔鍙?/div>
    <nav>{pages.map(([page,label,Icon,tag])=><button key={page} className={'nav-item'+(active===page?' selected':'')} onClick={()=>navigate(page)} aria-current={active===page?'page':undefined}><Icon size={18}/><span>{label}</span>{tag&&<span className="nav-tag">{tag}</span>}</button>)}</nav>
    {(onSettings||onGuide)&&<div className="nav-label second">宸ュ叿涓庤祫婧?/div>}
    {onSettings&&<button className="nav-item" onClick={onSettings}><SlidersHorizontal size={18}/><span>绛栫暐璁剧疆</span></button>}
    {onGuide&&<button className="nav-item" onClick={onGuide}><BookOpen size={18}/><span>浣跨敤鎸囧崡</span><ExternalLink size={13}/></button>}
    <div className="sidebar-bottom"><div className="market-note"><span className="mini-label">BUILT FOR</span><div><span className="poly-logo">鈼?/span> Polymarket <ArrowUpRight size={15}/></div><p>鎶婁氦鏄撲氦缁欒鍒?br/>鎶婂喅绛栫暀缁欒嚜宸便€?/p></div>{onConnection&&<button className="profile" onClick={onConnection}><span className="avatar">P</span><span>鏈湴浜ゆ槗璐︽埛<small>{active==='live'?'Live trading':'Paper trading'}</small></span><Settings2 size={16}/></button>}</div>
  </aside>;
}
