import React,{useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowDownRight,ArrowUpRight,ChevronLeft,ChevronRight,Minus,RefreshCw} from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import {DAY_MS,REPORT_TIMEZONE,dateKey,dateStart} from './report-dates.mjs';
import {positionHistoryTooltip} from './history-tooltip.mjs';
import {arrangeMarketHistory,MARKET_STREAK_MIN} from './market-history-layout.mjs';

const clock=new Intl.DateTimeFormat('zh-CN',{timeZone:REPORT_TIMEZONE,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const amount=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
const time=seconds=>clock.format(seconds*1000);
const showPrice=value=>value==null?'暂无':amount.format(value);
const tileTone=item=>item.result?.toLowerCase()??'neutral';
const settled=item=>item.verifiedAt!=null;
function label(item){
  if(item.status==='void'||item.status==='unverified-void')return settled(item)?'已核验作废':'作废待核验';
  if(item.result)return `${item.result} · ${settled(item)?'已核验':'待核验'}`;
  return item.status==='missing'?'暂无数据':'待核验';
}

function RoundTooltip({item,anchor,id,streak}){
  const ref=useRef(null),[layout,setLayout]=useState(null);
  useLayoutEffect(()=>{
    const panel=ref.current;
    setLayout(positionHistoryTooltip(anchor,250,panel.scrollHeight+panel.offsetHeight-panel.clientHeight,window.innerWidth,window.innerHeight));
  },[anchor,item,streak]);
  const approximate=['polymarket_last_second','polymarket_last_available'].includes(item.closeSource);
  return createPortal(<div ref={ref} id={id} role="tooltip" className="round-history-tooltip market-round-tooltip" style={layout?{left:layout.left,top:layout.top,width:layout.width,maxHeight:layout.maxHeight}:{width:250,visibility:'hidden'}}>
    <div className="market-tooltip-heading"><strong>{time(item.round)}–{time(item.end)}</strong><span>{label(item)}</span></div>
    {streak&&<p className="market-tooltip-streak">连续 {streak} 场 {item.result}</p>}
    <dl><div><dt>开盘价</dt><dd>{showPrice(item.open)}</dd></div><div><dt>{approximate?'预计收盘价':'收盘价'}</dt><dd>{showPrice(item.close)}</dd></div></dl>
  </div>,document.body);
}

export default function MarketHistoryPage(){
  const [date,setDate]=useState(()=>dateKey(Date.now()));
  const [response,setResponse]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(null);
  const [hovered,setHovered]=useState(null),tooltipId=useId();
  const [refreshStartedAt,requestRefresh]=useState(null),[refreshFeedback,setRefreshFeedback]=useState(null);
  const today=dateKey(Date.now()),data=response?.date===date?response:null;
  const feedback=refreshFeedback?.startedAt===refreshStartedAt?refreshFeedback:null;
  const manuallyRefreshing=refreshStartedAt!=null&&!feedback;
  useEffect(()=>{
    const controller=new AbortController();
    let timer,feedbackTimer,reportRefresh=refreshStartedAt!=null;
    const finishRefresh=ok=>{
      if(!reportRefresh)return;
      reportRefresh=false;
      feedbackTimer=setTimeout(()=>setRefreshFeedback({startedAt:refreshStartedAt,ok}),Math.max(0,350-(performance.now()-refreshStartedAt)));
    };
    const load=async()=>{
      let next=15000;
      try{
        if(document.hidden)return;
        const res=await fetch(`/api/market-history?${new URLSearchParams({date})}`,{cache:'no-store',signal:controller.signal});
        const payload=await res.json();
        if(!res.ok)throw Error(payload.error||'历史场次读取失败');
        next=payload.refreshing?3500:date===dateKey(Date.now())||payload.items.some(item=>!settled(item))?15000:null;
        if(!controller.signal.aborted){setResponse(payload);setError(null);finishRefresh(true);}
      }catch(error){
        if(!controller.signal.aborted){setError({date,message:error.message});finishRefresh(false);}
      }
      finally{
        if(!controller.signal.aborted){setLoading(false);if(next!=null)timer=setTimeout(load,next);}
      }
    };
    setLoading(true);load();
    return()=>{controller.abort();clearTimeout(timer);clearTimeout(feedbackTimer);};
  },[date,refreshStartedAt]);
  useEffect(()=>{
    const dismiss=()=>setHovered(null);
    const escape=e=>{if(e.key==='Escape')dismiss();};
    addEventListener('scroll',dismiss,true);addEventListener('resize',dismiss);addEventListener('keydown',escape);
    return()=>{removeEventListener('scroll',dismiss,true);removeEventListener('resize',dismiss);removeEventListener('keydown',escape);};
  },[]);

  function change(next){
    if(next&&next<=today&&next!==date){setHovered(null);requestRefresh(null);setDate(next);}
  }
  const shift=days=>change(dateKey(dateStart(date)+days*DAY_MS));
  const show=(event,item)=>setHovered({round:item.round,anchor:event.currentTarget.getBoundingClientRect()});
  const active=hovered&&data?.items.find(item=>item.round===hovered.round);
  const {hours,streaks,longest}=arrangeMarketHistory(data?.items??[],dateStart(date)/1000);
  const up=data?.items.filter(item=>settled(item)&&item.result==='UP').length??0;
  const down=data?.items.filter(item=>settled(item)&&item.result==='DOWN').length??0;
  const unverified=data?.items.filter(item=>!settled(item)).length??0;
  const voided=(data?.items.length??0)-up-down-unverified;

  return <div className="app"><Sidebar active="market-history"/><div className="main-shell">
    <header className="topbar"><div className="breadcrumb">交易工作台 <ChevronRight size={13}/><strong>历史场次</strong></div><span className="report-timezone">北京时间 · UTC+8</span></header>
    <main className="reports-main market-history-main">
      <section className="page-heading"><div><h1>历史场次</h1><p>BTC 五分钟市场 · 每格显示开盘时间</p></div></section>
      <section className="panel market-history-panel" aria-label="历史场次日期与数据" aria-busy={loading&&!data}>
        <div className="market-history-toolbar">
          <div className="market-date-controls report-month-controls">
            <button type="button" aria-label="前一天" onClick={()=>shift(-1)}><ChevronLeft size={17}/></button>
            <input aria-label="场次日期（北京时间）" type="date" value={date} max={today} onChange={e=>change(e.target.value)}/>
            <button type="button" aria-label="后一天" disabled={date>=today} onClick={()=>shift(1)}><ChevronRight size={17}/></button>
            <button type="button" onClick={()=>change(today)}>今天</button>
            <button type="button" aria-label="刷新场次" disabled={manuallyRefreshing} onClick={()=>requestRefresh(performance.now())}>
              <RefreshCw size={15} className={manuallyRefreshing?'report-spinning':undefined}/>{manuallyRefreshing?'刷新中…':'刷新'}
            </button>
            <span className={`market-refresh-feedback${feedback?.ok===false?' failed':''}`} role="status">
              {feedback&&(feedback.ok?'刷新已完成':'刷新失败')}
            </span>
          </div>
          {data&&<div className="market-history-counts" aria-label="场次统计">
            <span className="green">UP {up}</span><span className="red">DOWN {down}</span>
            {unverified>0&&<span>待核验 {unverified}</span>}{voided>0&&<span>作废 {voided}</span>}
            {data.refreshing&&<span role="status">核验中</span>}
            <span className="market-longest-streak">最长同向 {longest.length>0?<strong>{longest.length} 场 · {longest.directions.join(' / ')}</strong>:'—'}</span>
            <span className="market-streak-key">连续同向 ≥ {MARKET_STREAK_MIN} 场</span>
          </div>}
        </div>
        {error?.date===date&&<p className="report-error" role="alert">{error.message}</p>}
        {data?.error&&<p className="report-error" role="status">官方接口暂不可用，已保存的场次仍可查看。</p>}
        {!data&&loading&&<p className="report-loading">正在读取历史场次…</p>}
        {data?.items.length===0&&<p className="report-loading">所选日期暂无已结束场次。</p>}
        {data?.items.length>0&&<div className="market-hour-list">
          {hours.map(([hour,items])=>{
            const start=String(hour).padStart(2,'0'),end=String(hour+1).padStart(2,'0');
            const interval=`${start}:00–${end}:00`;
            return <div className="market-hour" key={hour}>
              <span className="market-hour-label" title={interval}>{start} 时</span>
              <div className="market-hour-grid" role="group" aria-label={`${interval} 的五分钟场次`}>
                {items.map(item=>{
                  const Icon=item.result==='UP'?ArrowUpRight:item.result==='DOWN'?ArrowDownRight:Minus;
                  const streak=streaks.get(item.round);
                  return <button key={item.round} type="button"
                    className={`market-round ${tileTone(item)}${settled(item)?' verified':''}${streak?' market-streak':''}`}
                    aria-label={`${time(item.round)}，${label(item)}${streak?`，连续 ${streak} 场 ${item.result}`:''}，开盘价 ${showPrice(item.open)}，收盘价 ${showPrice(item.close)}`}
                    aria-describedby={active?.round===item.round?tooltipId:undefined}
                    onMouseEnter={e=>show(e,item)} onMouseLeave={()=>setHovered(null)} onFocus={e=>show(e,item)} onBlur={()=>setHovered(null)} onClick={e=>show(e,item)}>
                    <Icon size={15} aria-hidden="true"/><span>{time(item.round)}</span>
                    {streak&&<span className="market-streak-count" aria-hidden="true">{streak}</span>}
                  </button>;
                })}
              </div>
            </div>;
          })}
        </div>}
      </section>
      {active&&<RoundTooltip key={active.round} item={active} anchor={hovered.anchor} id={tooltipId} streak={streaks.get(active.round)}/>}
    </main>
  </div></div>;
}
