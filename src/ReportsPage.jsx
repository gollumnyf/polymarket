import React,{useEffect,useMemo,useState} from 'react';
import {CalendarDays,ChevronLeft,ChevronRight,RefreshCw,LoaderCircle,Info} from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import {DAY_MS,dateKey,dateStart,recentDates,reportDates} from './report-dates.mjs';

const money=value=>Number(value??0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const signed=value=>`${value<0?'−':'+'}${money(Math.abs(value??0))}`;
const color=value=>value>0?'green':value<0?'red':'';
const monthLabel=month=>`${Number(month.slice(0,4))} 年 ${Number(month.slice(5,7))} 月`;
const periodKey=dates=>`${dates.startDate}:${dates.endDate}`;

export function ReportCalendar({data,month,selected,onSelect}){
  const cells=useMemo(()=>{
    const first=dateStart(month+'-01'),weekday=(new Date(first+8*3600000).getUTCDay()+6)%7;
    const result=[];for(let i=0;i<42;i++)result.push(dateKey(first+(i-weekday)*DAY_MS));
    if(result.slice(35).every(date=>date.slice(0,7)!==month))result.length=35;
    return result;
  },[month]);
  const days=new Map(data.days.map(day=>[day.date,day]));
  return <div className="report-calendar-scroll"><table className="report-calendar" aria-label={monthLabel(month)+'每日模拟交易收支'}><thead><tr>{['一','二','三','四','五','六','日'].map(day=><th key={day} scope="col">周{day}</th>)}</tr></thead><tbody>{Array.from({length:cells.length/7},(_,week)=><tr key={week}>{cells.slice(week*7,week*7+7).map(date=>{
    const day=days.get(date),enabled=date.slice(0,7)===month&&!!day,active=enabled&&(day.orderCount>0||day.settledCount>0),today=date===dateKey(Date.now());
    return <td key={date} className={!enabled?'report-day-disabled':''}><button disabled={!enabled} className={`report-day ${active?(day.netPnl>0?'gain':day.netPnl<0?'loss':'flat'):''}${selected===date?' selected':''}`} onClick={()=>onSelect(date)} aria-pressed={selected===date} aria-label={enabled?`${date}，已实现盈亏 ${signed(day.netPnl)} pUSD，收入 ${money(day.income)}，支出 ${money(day.spent)}，${day.orderCount} 单`:date+'，不在本页筛选范围'}><span className="report-day-number">{Number(date.slice(8))}{today&&<i>今天</i>}</span>{enabled&&(active?<><strong className={color(day.netPnl)}>{signed(day.netPnl)}</strong><span>收 {money(day.income)}</span><span>支 {money(day.spent)}</span><small>{day.orderCount} 单 · 结算 {day.settledCount} 单</small></>:<span className="report-day-empty">无交易收支</span>)}</button></td>;
  })}</tr>)}</tbody></table></div>;
}

function Metric({title,value,note,tone}){return <div className="report-metric"><span>{title}</span><strong className={tone||''}>{value}</strong><small>{note}</small></div>;}

export default function ReportsPage(){
  const [dates,setDates]=useState(()=>recentDates()),[draft,setDraft]=useState(()=>recentDates());
  const [month,setMonth]=useState(()=>recentDates().endDate.slice(0,7)),[selected,setSelected]=useState(()=>recentDates().endDate);
  const [result,setResult]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[validation,setValidation]=useState('');
  const key=periodKey(dates),data=result?.key===key?result.data:null;
  useEffect(()=>{
    let stopped=false;const controller=new AbortController();setLoading(true);setError('');
    fetch(`/range/api/paper/report?${new URLSearchParams(dates)}`,{signal:controller.signal,cache:'no-store'})
      .then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.error||'报表读取失败');return body;})
      .then(data=>{if(!stopped)setResult({key,data});}).catch(error=>{if(!stopped)setError(error.message);}).finally(()=>{if(!stopped)setLoading(false);});
    return ()=>{stopped=true;controller.abort();};
  },[key,refresh]);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden)setRefresh(value=>value+1);},30000);return ()=>clearInterval(timer);},[]);
  function apply(next){try{reportDates(next.startDate,next.endDate);setValidation('');setDates(next);setDraft(next);setMonth(next.endDate.slice(0,7));setSelected(next.endDate);setRefresh(value=>value+1);}catch(error){setValidation(error.message);}}
  const months=useMemo(()=>{const out=[];let cursor=dates.startDate.slice(0,7);while(cursor<=dates.endDate.slice(0,7)){out.push(cursor);const year=Number(cursor.slice(0,4)),m=Number(cursor.slice(5));cursor=m===12?`${String(year+1).padStart(4,'0')}-01`:`${year}-${String(m+1).padStart(2,'0')}`;}return out;},[dates]);
  const monthIndex=months.indexOf(month),summary=data?.summary,day=data?.days.find(item=>item.date===selected);
  return <div className="app reports-app"><Sidebar active="reports"/><div className="main-shell">
    <header className="topbar"><div className="breadcrumb">交易工作台 <ChevronRight size={13}/><strong>模拟盘报表</strong></div><span className="report-timezone">上海时间 · UTC+8</span></header>
    <main className="reports-main"><section className="page-heading"><div><div className="eyebrow">PAPER TRADING REPORTS</div><h1>模拟盘报表</h1><p>按日查看区间突破模拟的交易收支与实际表现。</p></div><button className="button secondary small" disabled={loading} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={15} className={loading?'report-spinning':''}/>刷新报表</button></section>
      <section id="report-content" aria-label="区间突破模拟报表" aria-busy={loading}>
        <form className="panel report-filter" onSubmit={event=>{event.preventDefault();apply(draft);}}><label>开始日期<input aria-label="报表开始日期" type="date" required value={draft.startDate} onChange={event=>setDraft({...draft,startDate:event.target.value})}/></label><span className="report-date-to">至</span><label>结束日期<input aria-label="报表结束日期" type="date" required value={draft.endDate} onChange={event=>setDraft({...draft,endDate:event.target.value})}/></label><button className="button primary small" type="submit">查询</button><div className="report-shortcuts">{[7,30,90].map(days=><button type="button" key={days} onClick={()=>apply(recentDates(days))}>近 {days} 天</button>)}</div></form>
        {validation&&<p className="report-error" role="alert">{validation}</p>}
        {error&&<div className="report-error" role="alert">报表读取失败：{error}{data?'；下方为上次成功读取的数据。':''}<button onClick={()=>setRefresh(value=>value+1)}>重试</button></div>}
        {!data&&loading&&<div className="report-loading"><LoaderCircle size={25} className="report-spinning"/>正在汇总每日收支…</div>}
        {data&&<><div className="report-period"><span>{dates.startDate} — {dates.endDate} · 区间突破模拟</span><small>更新于 {new Date(data.generatedAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}{loading?' · 更新中':''}</small></div>
          <section className="report-summary" aria-label="时间段汇总"><Metric title="总净盈亏（已结算）" value={signed(summary.netPnl)} tone={color(summary.netPnl)} note={`手续费前盈亏 ${signed(summary.grossPnl)} · pUSD`}/><Metric title="盈亏中已计入手续费" value={money(summary.settledFees)} note="已结算订单手续费，不重复扣除"/><Metric title="总单量 / 成交单量" value={`${summary.orderCount} / ${summary.filledCount}`} note={`按下单日 · 待处理 ${summary.pendingCount} · 拒单 ${summary.rejectedCount}`}/><Metric title="已结算 / 胜率" value={`${summary.settledCount} / ${summary.winRate==null?'—':summary.winRate.toFixed(1)+'%'}`} note={`${summary.wins} 胜 · ${summary.losses} 负 · ${summary.voidCount} 非二元兑付`}/><Metric title="结算收入" value={money(summary.income)} note="按结算日 · 含返还本金"/><Metric title="买入支出" value={money(summary.spent)} note={`按下单日 · 含手续费 ${money(summary.feesPaid)}`}/></section>
          <div className="report-cash-note"><Info size={15}/><span>区间净现金流 <b className={color(summary.netCashFlow)}>{signed(summary.netCashFlow)}</b> pUSD＝结算收入−买入支出；跨日持仓会使现金流与已实现盈亏不同。预计结果不计入已实现盈亏。</span></div>
          {(summary.missingFeeCount>0||summary.missingPnlCount>0)&&<p className="report-error">部分旧记录缺少费用或盈亏字段，以上金额仅汇总现有数据。</p>}
          <section className="panel report-calendar-panel"><div className="report-calendar-heading"><div><CalendarDays size={18}/><h2>{monthLabel(month)}</h2></div><span>每日大字：已实现净盈亏 · pUSD</span><div className="report-month-controls"><button aria-label="上一个月" disabled={monthIndex<=0} onClick={()=>setMonth(months[monthIndex-1])}><ChevronLeft size={18}/></button><select aria-label="日历月份" value={month} onChange={event=>setMonth(event.target.value)}>{months.map(item=><option key={item} value={item}>{monthLabel(item)}</option>)}</select><button aria-label="下一个月" disabled={monthIndex>=months.length-1} onClick={()=>setMonth(months[monthIndex+1])}><ChevronRight size={18}/></button></div></div><ReportCalendar data={data} month={month} selected={selected} onSelect={setSelected}/></section>
          {day&&<section className="panel report-day-detail"><h2>{selected} · 每日明细</h2><div className="report-day-metrics"><Metric title="已实现净盈亏" value={signed(day.netPnl)} tone={color(day.netPnl)} note={`结算 ${day.settledCount} 单 · ${day.wins} 胜 / ${day.losses} 负`}/><Metric title="结算收入 / 买入支出" value={`${money(day.income)} / ${money(day.spent)}`} note={`净现金流 ${signed(day.netCashFlow)}`}/><Metric title="支付手续费 / 结算手续费" value={`${money(day.feesPaid)} / ${money(day.settledFees)}`} note="分别按下单日 / 结算日归属"/><Metric title="下单 / 成交" value={`${day.orderCount} / ${day.filledCount}`} note={`待处理 ${day.pendingCount} · 拒单 ${day.rejectedCount}`}/></div></section>}
          <p className="report-footnote">统计当前保存的全部模拟交易记录，包含账户重置前的历史；已清空的交易不再计入。模拟初始资金和账户重置不计为收入。手续费为模拟成交时保存的估算值，净盈亏已包含对应手续费。</p>
        </>}
      </section>
    </main>
  </div></div>;
}
