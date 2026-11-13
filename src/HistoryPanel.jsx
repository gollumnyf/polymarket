import React, { useEffect, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, Download, Layers3, LoaderCircle, RefreshCw, ShieldCheck,Trash2,Eye,EyeOff } from 'lucide-react';
import { orderTime, settlementPlaceholder } from './order-time.mjs';
import {apiPath} from './api.mjs';
import {liveOrderPrediction} from './live-prediction.mjs';

const fmt = (n, digits = 2) => n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits:digits,maximumFractionDigits:digits });
const cash = n => n == null ? '—' : `$${fmt(n)}`;
const signed = n => n == null ? '—' : `${n >= 0 ? '+' : '−'}$${fmt(Math.abs(n))}`;
const time = seconds => new Date(seconds*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
const roundName = seconds => `${time(seconds)} – ${time(seconds+300)}`;
const labels = {open:'等待结算',placing:'提交中',confirming:'成交确认中',uncertain:'待核对',won:'获胜',lost:'失利',rejected:'未成交',void:'非二元兑付'};

export default function HistoryPanel({ mode,tab,setTab,account,currentRound,onReconcile,onClear,onVisibility,busy=false,spot,now,connected,spotError }) {
  const [query,setQuery] = useState({page:1,pageSize:20,status:'all',anchor:null});
  const [result,setResult] = useState(null);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [retry,setRetry] = useState(0);
  const [expanded,setExpanded] = useState(null);
  const revision = account?.historyVersion?.[tab];
  const queryKey = JSON.stringify([mode,tab,query]);
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    setLoading(true); setError('');
    const load = async () => {
      try {
        const params = new URLSearchParams({page:String(query.page),pageSize:String(query.pageSize)});
        if (tab === 'orders') params.set('status',query.status);
        if (query.anchor != null) params.set('anchor',String(query.anchor));
        const response = await fetch(apiPath(`${mode}/${tab}?${params}`),{cache:'no-store',signal:controller.signal});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '历史数据加载失败');
        if (!stopped) setResult({key:queryKey,data});
      } catch (error) { if (!stopped) setError(error.message); }
      finally { if (!stopped) setLoading(false); }
    };
    load();
    return () => { stopped=true; controller.abort(); };
  },[mode,tab,queryKey,revision,retry]);
  const data = result?.key === queryKey ? result.data : {items:[],page:query.page,pageSize:query.pageSize,total:0,pages:1,anchor:null};
  const orders = tab === 'orders' ? data.items : [];
  const logs = tab === 'logs' ? data.items : [];
  const filter = query.status;
  const activeOrders = (account?.activeOrders || []).filter(order=>!order.isHide);
  const predictionContext={spot,now,connected,spotError};
  const invested = activeOrders.filter(o => o.session === account?.session).reduce((n,o) => n+(o.cost ?? o.budget ?? 0),0);
  const setFilter = status => { setExpanded(null); setQuery(q => ({...q,status,page:1,anchor:null})); };
  const changePage = page => {
    setExpanded(null);
    setQuery(q => ({...q,page,anchor:page === 1 ? null : data.anchor}));
  };
  async function changeVisibility(hidden){
    if(busy||!onVisibility)return;
    if(await onVisibility(tab,hidden)){
      setExpanded(null);setResult(null);setError('');
      setQuery(q=>({...q,page:1,anchor:null}));setRetry(n=>n+1);
    }
  }
  return <>
        <section className="panel history-panel" id="history"><div className="history-toolbar"><div className="table-tabs"><button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>交易记录 {tab==='orders'&&<span>{data.total}</span>}</button><button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>运行日志</button></div><div className="table-actions">{onVisibility&&<><button type="button" className="export-button" disabled={busy||loading} onClick={()=>changeVisibility(true)} title="隐藏当前标签下所有已有记录，新记录继续显示"><EyeOff size={14}/>隐藏</button>{data.hiddenCount>0&&<button type="button" className="export-button" disabled={busy||loading} onClick={()=>changeVisibility(false)} title="恢复当前标签下所有隐藏记录"><Eye size={14}/>恢复显示（{data.hiddenCount}）</button>}</>}{tab === 'orders' && <select aria-label="筛选交易状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部状态</option><option value="open">等待结算</option><option value="won">获胜</option><option value="lost">失利</option><option value="uncertain">待核对</option></select>}<a className="export-button" href={apiPath(tab==='orders'?`${mode}/export`:`${mode}/logs/export`)}><Download size={14}/>导出</a>{mode==='paper' && onClear && <button type="button" className="export-button clear-history-button" disabled={busy} onClick={()=>onClear(tab)} aria-label={tab==='orders'?'清空历史交易记录':'清空运行日志'}><Trash2 size={14}/>清空</button>}</div></div>
          <LoadStatus loading={loading} error={error} retry={() => setRetry(n => n+1)}/>
          {tab === 'orders' ? <div className="table-scroll" aria-busy={loading}><table><thead><tr><th>市场 / 场次</th><th>下单时间</th><th>结算时间</th><th>方向</th><th>投入金额</th><th>成交均价</th><th>状态</th><th>预测结果</th><th>净盈亏</th><th/></tr></thead><tbody>{orders.map(order => <React.Fragment key={order.id}><tr onClick={() => setExpanded(expanded === order.id ? null : order.id)} className="order-row"><td><div className="table-market"><span className="small-bitcoin">₿</span><div><strong>BTC Up / Down <span>5M</span><OrderRoundMarker round={order.round} currentRound={currentRound}/></strong><small>{new Date(order.round * 1000).toLocaleDateString('zh-CN')} · {roundName(order.round)}</small></div></div></td><td><OrderTime timestamp={order.createdAt}/></td><td><OrderTime timestamp={order.settledAt} placeholder={settlementPlaceholder(order)}/></td><td><span className={`direction-chip ${order.direction.toLowerCase()}`}>{order.direction === 'UP' ? <ArrowUpRight size={13}/> : <ArrowDownRight size={13}/>} {order.direction}</span></td><td><strong>{cash(order.cost ?? order.budget)}</strong><small className="table-small">{2 ** order.doubling}× 首笔金额</small></td><td>{order.price ? `${fmt(order.price * 100, 2)}¢` : '—'}</td><td><span className={`status-badge ${order.status}`}><i/>{labels[order.status]}</span></td><td><OrderPrediction order={order} currentRound={currentRound} predictionContext={predictionContext}/></td><td className={order.pnl == null ? 'subtle' : order.pnl >= 0 ? 'green' : 'red'}>{signed(order.pnl)}</td><td><ChevronDown size={14}/></td></tr>{expanded === order.id && <tr><td colSpan="10" className="expanded-order"><p>本地订单：{order.id}</p>{order.venueOrderId && <p>平台订单：{order.venueOrderId}</p>}<p>份额：{fmt(order.shares, 6)} · 手续费{order.feeEstimated ? '（估算）' : mode==='paper'?'（模拟估算）':'（实际成交）'}：{cash(order.fee)} · 信号参考价：{cash(order.referencePrice)} → {cash(order.signalPrice)}</p>{order.streakSignal&&<p>连续同向反买依据：连续 {order.streakSignal.roundsRequired} 场市场 {order.streakSignal.marketDirection} → 买 {order.streakSignal.direction}；场次 #{order.streakSignal.firstRound}–#{order.streakSignal.lastRound}；不设策略买价上限。{order.streakSignal.samples.map(sample=>`#${sample.round} ${sample.outcome}（${sample.source==='official'?'官方最终结果':'预计结果'} · ${sample.source}）`).join('；')}</p>}{order.momentumSignal&&<p>官方报价依据：{orderTime(order.momentumSignal.previousAt)?.time} · {cash(order.momentumSignal.previousPrice)} → {orderTime(order.momentumSignal.latestAt)?.time} · {cash(order.momentumSignal.latestPrice)}；窗口 {order.momentumSignal.oracleWindow}s · 最高买价 0.50</p>}{order.rangeSignal&&<p>区间依据：{order.rangeSignal.levelTimeframeMinutes===5?'5 分钟实体 K 线 / 近 '+(order.rangeSignal.levelLookbackHours??4)+' 小时 / 滞后 '+(order.rangeSignal.levelLagMinutes??0)+' 分钟':'旧版报价段价位'} · 下支撑 {cash(order.rangeSignal.lower)} / 上压力 {cash(order.rangeSignal.upper)} · 来源：{order.rangeSignal.supportSource==='rolling_extremes'?'实体最低价':order.rangeSignal.supportSource==='secondary_pivot'?'次低谷':'多次触及'} / {order.rangeSignal.resistanceSource==='rolling_extremes'?'实体最高价':order.rangeSignal.resistanceSource==='secondary_pivot'?'次高峰':'多次触及'} · {order.rangeSignal.phase==='range'?'区间固定方向':order.rangeSignal.phase==='breakout_up'?'上穿跟随':'下穿跟随'} · {order.rangeSignal.formedFrom==='confirmed_breakout'?'连续收盘确认突破':order.rangeSignal.formedFrom==='candidate_breakout'?'候选区间直接突破':'历史区间'} · 实际最低 / 最高 {cash(order.rangeSignal.actualLower)} / {cash(order.rangeSignal.actualUpper)} · 选向时 UP {order.rangeSignal.upCount} / DOWN {order.rangeSignal.downCount}</p>}{order.rangeSignal?.rangeBaseDirection&&<p>每侧边界比例：{order.rangeSignal.edgePercent??20}% · 保存的区间基础方向：{order.rangeSignal.rangeBaseDirection} · 当前规则：{order.rangeSignal.lockedDirectionRule==='boundary_return'?'边界返回选向':order.rangeSignal.lockedDirectionRule==='range_edge_reversion'?'边界反向':order.rangeSignal.lockedDirectionRule==='breakout'?'已确认突破':'区间基础方向'}</p>}{order.rangeSignal?.boundaryResumeSide&&<p>边界恢复依据：{order.rangeSignal.boundaryConfirmCount==null?'沿用此前恢复方向（当时未启用连续收盘确认）':`连续 ${order.rangeSignal.boundaryConfirmCount}/${order.rangeSignal.resumeRounds} 场收盘确认`} · 成交上限 {order.rangeSignal.executionMaxPrice??0.5} · 从{order.rangeSignal.boundaryResumeSide==='lower'?'下支撑侧向上':'上压力侧向下'}返回中部 → 买 {order.rangeSignal.boundaryResumeSide==='lower'?'UP':'DOWN'} · 恢复时间 {new Date(order.rangeSignal.boundaryResumedAt).toLocaleString('zh-CN',{hour12:false})} · 恢复价 {cash(order.rangeSignal.boundaryResumePrice)} · 中部阈值 {cash(order.rangeSignal.boundaryResumeThreshold)}</p>}{order.rangeSignal?.breakoutPendingDirection&&<p>突破依据：参考下界 {cash(order.rangeSignal.breakoutReferenceLower)} / 上界 {cash(order.rangeSignal.breakoutReferenceUpper)} · {order.rangeSignal.breakoutPendingDirection} 已确认 {order.rangeSignal.breakoutCount??0} 场 · {order.rangeSignal.breakoutConfirmedAt?'已确认，顺向买入':'未确认，边界反向'}{order.rangeSignal.breakoutLastRound&&<> · 最近确认场次 #{order.rangeSignal.breakoutLastRound}，收盘 {cash(order.rangeSignal.breakoutLastClose)}（{order.rangeSignal.breakoutLastSource}）</>}</p>}{order.rangeSignal?.directionRule==='tie_reverse_previous'&&<p>区间锁定依据（同票反向）：UP {order.rangeSignal.decisionUpCount} / DOWN {order.rangeSignal.decisionDownCount} · 上一场 #{order.rangeSignal.tiePreviousRound} {order.rangeSignal.tiePreviousDirection}（{order.rangeSignal.tiePreviousSource==='official'?'官方结果':'预测结果'} · {order.rangeSignal.tiePreviousSource}）→ 买 {order.direction}</p>}<PredictionDetails round={order.round} prediction={order.prediction||liveOrderPrediction(order,predictionContext)}/><p>{order.note || (mode==='live'?'实盘成交按平台记录核对，等待官方结果结算。':'按真实订单簿深度模拟买入，等待官方结果结算。')}</p>{order.status === 'uncertain' && <button className="button secondary small" onClick={() => onReconcile(order)}>核对平台订单 ID</button>}</td></tr>}</React.Fragment>)}</tbody></table>{!loading && !error && orders.length === 0 && <div className="empty-state"><span><Layers3 size={24}/></span><strong>{data.hiddenCount>0?'暂无可见交易':filter === 'all' ? '你的第一笔交易，从规则开始' : '暂无此状态的交易'}</strong><p>{data.hiddenCount>0?'已有记录已隐藏，新交易会继续显示；点击恢复显示可查看旧记录。':filter === 'all' ? '设置首笔金额并启动策略，交易记录将自动出现在这里。' : '切换筛选条件可查看其他订单。'}</p></div>}</div>
          : <div className="logs" aria-busy={loading}>{logs.length ? logs.map(log => <div className="log-row" key={log.id}><time>{new Date(log.time).toLocaleTimeString('zh-CN')}</time><span className={`log-level ${log.level}`}>{({ info: 'INFO', success: 'DONE', warning: 'WARN', error: 'ERROR' })[log.level]}</span><p>{log.message}</p></div>) : !loading && !error && <div className="empty-state"><Activity size={24}/><strong>暂无运行日志</strong><p>策略启动、成交和结算事件会记录在这里。</p></div>}</div>}
          <Pagination data={data} loading={loading} onPage={changePage} onSize={pageSize => { setExpanded(null); setQuery(q => ({...q,pageSize,page:1,anchor:null})); }} onRefresh={() => { setQuery(q => ({...q,page:1,anchor:null})); setRetry(n => n+1); }}/>
          <div className="table-footer"><span><ShieldCheck size={12}/>本机持久化存储 · 每场最多一次买入</span><span>{activeOrders.length ? `${activeOrders.length} 笔待处理 · ${cash(invested)} 持仓投入` : '没有可见的待处理订单'}</span></div>
        </section>

  </>;
}

function OrderTime({timestamp,placeholder='未记录'}) {
  const value = orderTime(timestamp);
  return value ? <time className="order-time" dateTime={value.iso}><span>{value.date}</span><strong>{value.time}</strong></time>
    : <span className="subtle">{placeholder}</span>;
}

export function OrderPrediction({order,currentRound,predictionContext}) {
  if (!['open','confirming','placing','uncertain'].includes(order.status))
    return order.prediction?.matches === false ? <span className="prediction-note mismatch">预测与结算不符</span> : <span className="subtle">—</span>;
  if (order.status !== 'open') return <span className="prediction-note">成交待确认</span>;
  const prediction=order.prediction||liveOrderPrediction(order,predictionContext);
  if (!prediction) return <span className="prediction-note">{order.round>=currentRound?'场次进行中 · 等待有效报价':'等待起止价或收盘前同源报价'}</span>;
  const realtime=prediction.source==='polymarket_realtime';
  return <span className={`prediction-note ${prediction.won?'expected-win':'expected-loss'}`} title={`起始 ${cash(prediction.open)} → ${realtime?'最新官方价':prediction.source==='polymarket_last_second'?'同源末秒价':prediction.source==='polymarket_last_available'?'追溯同源报价':'平台终止价'} ${cash(prediction.close)}；${realtime?`采样 ${new Date(prediction.priceAt).toLocaleTimeString('zh-CN',{hour12:false})}；场次进行中，预测随价格变化${prediction.close===prediction.open?'；持平暂按 UP 预测':''}`:`官方结算待确认${prediction.source==='polymarket_last_available'?`；采样 ${new Date(prediction.priceAt).toLocaleString('zh-CN',{hour12:false})}；距收盘 ${Number(((order.end*1000-prediction.priceAt)/1000).toFixed(3))} 秒`:''}`}`}>
    {prediction.won?'预计获胜':'预计失利'} · {prediction.outcome}{realtime?'（实时）':prediction.source==='polymarket_last_second'?'（末秒）':prediction.source==='polymarket_last_available'?'（追溯）':''}
  </span>;
}

export function PredictionDetails({prediction,round}) {
  if (!prediction) return null;
  const realtime=prediction.source==='polymarket_realtime';
  return <div className="prediction-details"><p>{realtime?'实时预测':'场次预测'}：{prediction.outcome} · {prediction.won?'预计获胜':'预计失利'} · 起始价 {cash(prediction.open)} → {realtime?'最新官方价':prediction.source==='polymarket_last_second'?'末秒价':prediction.source==='polymarket_last_available'?'追溯价':'终止价'} {cash(prediction.close)}</p>
    <p>价格来源：{realtime?'Polymarket 最新官方价格':prediction.source==='polymarket_last_available'?'Polymarket 收盘前向前追溯的最近同源采样':prediction.source==='polymarket_last_second'?'Polymarket 同源最后一秒采样':prediction.source==='polymarket_event_metadata'?'Polymarket 场次元数据':'Polymarket 场次起止价'}{prediction.priceAt&&<> · 采样 {new Date(prediction.priceAt).toLocaleString('zh-CN',{hour12:false})}{prediction.source==='polymarket_last_available'&&Number.isFinite(round)&&<> · 距收盘 {Number((((round+300)*1000-prediction.priceAt)/1000).toFixed(3))} 秒</>}</>}{realtime?' · 场次进行中，预测随价格变化':<> · 记录时间 {new Date(prediction.observedAt).toLocaleString('zh-CN',{hour12:false})} · {prediction.matches==null?'待官方结算核对':prediction.matches?'与官方结算一致':'与官方结算不一致'}</>}</p></div>;
}

export function OrderRoundMarker({round,currentRound}) {
  if (!Number.isFinite(currentRound)) return null;
  if (round === currentRound) return <span className="order-round-marker current" title="当前正在进行的场次"><span aria-hidden="true">●</span>当前场次</span>;
  if (round === currentRound-300) return <span className="order-round-marker previous" title="刚刚结束的上一场次"><span aria-hidden="true">↶</span>上一场次</span>;
  return null;
}

function LoadStatus({loading,error,retry}) {
  return loading ? <div className="history-load-status" role="status"><LoaderCircle className="spinning" size={15}/>正在加载…</div>
    : error ? <div className="history-load-status error" role="alert"><span>{error}</span><button className="text-button" onClick={retry}>重试</button></div> : null;
}

function Pagination({data,loading,onPage,onSize,onRefresh}) {
  const first = data.total ? (data.page-1)*data.pageSize+1 : 0;
  const last = Math.min(data.page*data.pageSize,data.total);
  return <nav className="history-pagination" aria-label="历史记录分页">
    <span>共 {data.total} 条 · {first}–{last} 条</span>
    <div><label>每页 <select aria-label="每页记录数" value={data.pageSize} disabled={loading} onChange={e => onSize(Number(e.target.value))}>{[10,20,50].map(size => <option key={size} value={size}>{size} 条</option>)}</select></label>
      <button className="pagination-button" disabled={loading || data.page<=1} onClick={() => onPage(data.page-1)} aria-label="上一页"><ChevronLeft size={15}/>上一页</button>
      <span aria-live="polite">第 {data.page} / {data.pages} 页</span>
      <button className="pagination-button" disabled={loading || data.page>=data.pages} onClick={() => onPage(data.page+1)} aria-label="下一页">下一页<ChevronRight size={15}/></button>
      <button className="pagination-button" disabled={loading} onClick={onRefresh} title="回到第一页并加载最新记录"><RefreshCw size={14}/>刷新</button>
    </div>
  </nav>;
}
