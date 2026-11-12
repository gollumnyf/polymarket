import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownRight, ArrowUpRight, Clock3, RotateCcw } from 'lucide-react';
import {apiPath} from './api.mjs';
import {HISTORY_COUNT,summarizeHistory} from './history-summary.mjs';
import {positionHistoryTooltip} from './history-tooltip.mjs';

const price = value => value == null ? '待公布' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatTime = seconds => new Date(seconds * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const sampleTime = milliseconds => new Date(milliseconds).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second:'2-digit',hour12: false });
const resultLabel = item => item.result || (item.status === 'void' ? '非二元兑付' : item.status === 'unavailable' ? '数据待补充' : '等待官方结算');

export default function HistoricalRounds({ round, mode = 'paper', entryDelay = 5,followPreviousAtOpen=false,reverseSignal=false,momentum=false }) {
  const [history, setHistory] = useState({ items: [], error: null });
  const [hovered, setHovered] = useState(null);
  const id = useId();
  const tooltipRef = useRef(null);
  const hideTimer = useRef(null);
  const keepOpen = () => clearTimeout(hideTimer.current);
  const hide = () => { keepOpen(); hideTimer.current=setTimeout(()=>setHovered(null),160); };
  useEffect(()=>()=>clearTimeout(hideTimer.current),[]);
  useEffect(() => {
    let stopped = false;
    let timer;
    const controller = new AbortController();
    setHovered(null);
    const load = async () => {
      try {
        const response = await fetch(apiPath(`history?mode=${mode}`), { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('历史结果暂不可用');
        const data = await response.json();
        if (!stopped && data.mode === mode && data.entryDelay === entryDelay && Boolean(data.followPreviousAtOpen)===followPreviousAtOpen && Boolean(data.reverseSignal)===reverseSignal) setHistory(data);
      } catch (error) {
        if (!stopped) setHistory(current => ({ ...current, error: error.message }));
      } finally { if (!stopped) timer = setTimeout(load, 15000); }
    };
    load();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [round, mode, entryDelay,followPreviousAtOpen,reverseSignal]);
  useEffect(() => {
    const clear = event => {
      if(event.target instanceof Node&&tooltipRef.current?.contains(event.target))return;
      clearTimeout(hideTimer.current);setHovered(null);
    };
    addEventListener('scroll', clear, true); addEventListener('resize', clear);
    return () => { removeEventListener('scroll', clear, true); removeEventListener('resize', clear); };
  }, []);
  const items = Array.from({ length: HISTORY_COUNT }, (_, i) => {
    const start = round - (HISTORY_COUNT - i) * 300;
    const item = history.items.find(item => item.round === start);
    if (!item) return { round: start, end: start + 300, status: 'loading' };
    return history.mode === mode && history.entryDelay === entryDelay && Boolean(history.followPreviousAtOpen)===followPreviousAtOpen && Boolean(history.reverseSignal)===reverseSignal ? item
      : { ...item,initialSignal:null,reversal:null,trade:null,entryBlock:null };
  });
  const counts = summarizeHistory(items);
  const active = hovered && items.find(item => item.round === hovered.round);
  useLayoutEffect(() => {
    if (!active || !hovered || !tooltipRef.current) return;
    const panel=tooltipRef.current;
    const height=panel.scrollHeight+panel.offsetHeight-panel.clientHeight;
    const layout=positionHistoryTooltip(hovered.anchor,hovered.preferredWidth,height,window.innerWidth,window.innerHeight);
    if(!hovered.ready||Object.keys(layout).some(key=>layout[key]!==hovered[key]))
      setHovered(current=>current&&current.round===hovered.round?{...current,...layout,ready:true}:current);
  }, [active, hovered]);
  const show = (event, item) => {
    keepOpen();
    const bounds = event.currentTarget.getBoundingClientRect();
    const width = Math.min(item.entryBlock&&!item.trade?360:258, window.innerWidth - 24);
    setHovered({round:item.round,width,preferredWidth:width,ready:false,left:12,top:12,
      anchor:{top:bounds.top,bottom:bounds.bottom,left:bounds.left,right:bounds.right}});
  };
  return <div className="round-history">
    <div className="round-history-heading"><div className="round-history-counts" title="按展示场次的官方最终结果统计；尚无结果的场次不计入 UP/DOWN"><span>最近 {HISTORY_COUNT} 场</span><span className="green"><i className="history-key up"/>UP {counts.up} 场</span><span className="red"><i className="history-key down"/>DOWN {counts.down} 场</span>{counts.pending>0&&<span>待定 {counts.pending} 场</span>}{counts.void>0&&<span>作废 {counts.void} 场</span>}</div><div><span><i className="history-key reversal"/>反转 · {momentum?'实际买入':<>第 {entryDelay} 秒</>}</span><span><i className="history-key pending"/>待结算</span></div><small title="每行从左到右，再从上到下">早 → 近</small></div>
    <div className="round-history-dots" role="group" aria-label={`最近 ${HISTORY_COUNT} 场 BTC 五分钟市场最终结果，从左到右、从上到下按时间从早到近排列`}>
      {items.map(item => <a href={`https://polymarket.com/event/btc-updown-5m-${item.round}`} target="_blank" rel="noopener noreferrer" key={item.round} className={`round-marker ${item.result?.toLowerCase() || 'pending'}${item.reversal === true ? ' reversed' : ''}`} aria-label={`${formatTime(item.round)} 至 ${formatTime(item.end)}，${resultLabel(item)}${item.reversal === true ? `，反转，初始 ${item.initialSignal.direction}` : ''}`} aria-describedby={active?.round === item.round ? id : undefined} onMouseEnter={event => show(event, item)} onMouseLeave={hide} onFocus={event => show(event, item)} onBlur={hide} onClick={event => show(event, item)}><span className="round-result-dot">{item.reversal === true && <RotateCcw size={10} strokeWidth={2.5}/>}</span></a>)}
    </div>
    {history.error && <p className="round-history-error">历史数据更新暂不可用，已确认结果继续保留。</p>}
    {active && createPortal(<div ref={tooltipRef} id={id} role="tooltip" tabIndex={0} onMouseEnter={keepOpen} onMouseLeave={hide} onFocus={keepOpen} onBlur={hide} data-placement={hovered.placement} className="round-history-tooltip" style={{ left: hovered.left, top: hovered.top, width: hovered.width, maxHeight:hovered.maxHeight, visibility:hovered.ready?'visible':'hidden' }}>
      <div className="round-tooltip-heading"><strong>BTC 5 分钟</strong><span className={active.result === 'UP' ? 'green' : active.result === 'DOWN' ? 'red' : ''}>{active.result === 'UP' ? <ArrowUpRight size={13}/> : active.result === 'DOWN' ? <ArrowDownRight size={13}/> : <Clock3 size={12}/>} {resultLabel(active)}</span></div>
      <p className="round-tooltip-date">{new Date(active.round * 1000).toLocaleDateString('zh-CN')} · {formatTime(active.round)} – {formatTime(active.end)}</p>
      <HistoricalRoundDetails active={active} mode={mode} entryDelay={entryDelay} followPreviousAtOpen={followPreviousAtOpen} reverseSignal={reverseSignal} momentum={momentum}/>
      <p className="round-tooltip-source">{momentum?'按实际买入方向与本场最终结果标记反转；未买入场次不推测反转。':followPreviousAtOpen?`跟随模式：开盘后第 ${entryDelay} 秒起，按上一场预计 UP/DOWN 方向入场，反转比较该方向与本场官方结果。`:reverseSignal?`反向模式：开盘第 ${entryDelay} 秒起将本场信号取反，UP 买 DOWN、DOWN 买 UP；反转标记比较买入方向与官方结果。`:<>按当前{mode === 'live' ? '实盘' : '模拟盘'}入场配置：开盘第 {entryDelay} 秒起取首个有效价格，最迟第 {entryDelay + 5} 秒，按本场起始价比较。</>}实际依据见上方；缺少记录时不推测反转。点击圆圈可在新标签页打开 Polymarket 本场市场。</p>
    </div>, document.body)}
  </div>;
}

export function HistoricalRoundDetails({active,mode='paper',entryDelay=5,followPreviousAtOpen=false,reverseSignal=false,momentum=false}) {
  const estimated=active.closeSource==='polymarket_last_second';
  const expected=Number.isFinite(active.open)&&Number.isFinite(active.close)?(active.close>=active.open?'UP':'DOWN'):null;
  const comparisonLabel=active.status==='void'?'官方非二元兑付':active.forecastComparisonSource==='official_result'?'官方结果':'接口价格方向';
  return <><dl>
        <div><dt>场次</dt><dd>#{active.round}</dd></div>
        <div><dt>起始金额</dt><dd>{price(active.open)}</dd></div>
        <div><dt>终止金额{estimated?'（预测）':''}</dt><dd>{price(active.close)}</dd></div>
        <div><dt>变动金额</dt><dd className={active.change > 0 ? 'green' : active.change < 0 ? 'red' : ''}>{active.change == null ? '待公布' : `${active.change >= 0 ? '+' : '−'}${price(Math.abs(active.change))}`} {active.changePercent != null && <small>({active.changePercent >= 0 ? '+' : ''}{active.changePercent.toFixed(3)}%)</small>}</dd></div>
        <div><dt>终止价来源</dt><dd>{estimated?<>Polymarket 同源末秒采样<br/>{sampleTime(active.closeAt)} · {active.forecast?.oracleWindow===0?'Chainlink':`TWAP ${active.forecast?.oracleWindow}s`}</>:active.closeSource==='polymarket_event_metadata'?'Polymarket 接口终止价':'待获取有效数据'}</dd></div>
        {!active.result&&active.status!=='void'&&expected&&<div><dt>预计方向</dt><dd className={expected==='UP'?'green':'red'}>{expected} · 待官方结算</dd></div>}
        {active.forecast&&!estimated&&<div><dt>末秒预测记录</dt><dd>{active.forecast.outcome} · {price(active.forecast.close)}<br/>{sampleTime(active.forecast.priceAt)}</dd></div>}
        {active.forecastMatches===true&&<div><dt>预测核对</dt><dd className="green">与{comparisonLabel}一致</dd></div>}
        <div><dt>{momentum?'实际买入信号':<>第 {entryDelay} 秒入场信号</>}</dt><dd className={active.initialSignal?.direction === 'UP' ? 'green' : active.initialSignal?.direction === 'DOWN' ? 'red' : ''}>{active.initialSignal ? active.initialSignal.direction || '持平' : '未记录'}</dd></div>
        {active.initialSignal && <div><dt>{followPreviousAtOpen?'上一场预测依据':'采样时刻 / 价格'}</dt><dd>{followPreviousAtOpen?sampleTime(active.initialSignal.observedAt):`第 ${((active.initialSignal.observedAt-active.round*1000)/1000).toFixed(1)} 秒`} · {price(active.initialSignal.price)}</dd></div>}
        {reverseSignal&&active.initialSignal&&<div><dt>本场原始信号</dt><dd>{active.initialSignal.marketDirection || '持平'}</dd></div>}
        <div><dt>方向反转</dt><dd className={active.reversal === true ? 'reversal-text' : ''}>{active.reversal === true ? `${active.initialSignal.direction} → ${active.result} ↻` : active.reversal === false ? '未反转' : !active.initialSignal ? '缺少入场时刻数据' : !active.result ? '待最终结果' : '初始信号持平'}</dd></div>
        <div><dt>{mode === 'live' ? '实盘订单' : '模拟订单'}</dt><dd className={active.trade?.status === 'lost' ? 'red' : active.trade?.status === 'won' ? 'green' : ''}>{!active.trade ? '未参与' : `${active.trade.direction} · ${active.trade.status === 'won' ? '获胜' : active.trade.status === 'lost' ? '失利' : active.trade.status === 'rejected' ? '未成交' : '待确认 / 结算'}`}</dd></div>
      </dl>
      {!active.trade&&active.entryBlock&&<p className="round-entry-block"><strong>未买入原因</strong><span>{active.entryBlock.message}</span><small>记录时间 {sampleTime(active.entryBlock.at)}{active.entryBlock.evidenceAvailable?' · 检查依据已保存':' · 旧版依据不完整'}</small></p>}
      {active.forecastMatches===false&&<p className="round-forecast-mismatch" role="status"><strong>末秒预测与{comparisonLabel}不一致</strong><span>预测 {active.forecast.outcome} → {active.status==='void'?'非二元兑付':active.forecastComparison}{active.forecastComparisonSource==='platform_prices'?' · 仍待官方结算':''}</span></p>}
      {estimated&&<p className="round-forecast-note">末秒价格仅作预测，接口返回终止价后自动替换；最终方向以官方结算为准。</p>}
    </>;
}
