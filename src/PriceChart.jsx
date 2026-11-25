import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Activity} from 'lucide-react';
import {chartTimeWindow,holdChartForOpening} from './chart-prices.mjs';
const fmt=(n,digits=2)=>n==null||!Number.isFinite(Number(n))?'—':Number(n).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits});
const time=(seconds,includeSeconds=false)=>new Date(seconds*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',...(includeSeconds?{second:'2-digit'}:{}),hour12:false});

export default function PriceChart({ ticks, reference, provisionalReference=false, start, now, range,zone,boundary,edgePercent=20 }) {
  const [hover, setHover] = useState(null);
  const chartRef = useRef(null);
  const [size, setSize] = useState({ width: 900, height: 300 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(chartRef.current);
    return () => observer.disconnect();
  }, []);
  const { width, height } = size;
  const left = 14, right = width - 62, top = 16, bottom = height - 28;
  const plotWidth = Math.max(1, right - left), plotHeight = Math.max(1, bottom - top);
  const timeLabels = width < 440 ? 4 : 6;
  const {xmin,xmax,visibleThrough}=chartTimeWindow(ticks,{start,now,range});
  const waitingForTarget=holdChartForOpening({range,start,now,reference});
  const points=useMemo(()=>waitingForTarget?[]:ticks.filter(t=>t.time>=xmin&&t.time<=visibleThrough),[ticks,xmin,visibleThrough,waitingForTarget]);
  const bounds = points.map(p => p.price);
  if (reference) bounds.push(reference);
  const hasZone=Number.isFinite(zone?.lower)&&Number.isFinite(zone?.upper);
  if(hasZone)bounds.push(zone.lower,zone.upper);
  const entryLower=boundary?.lower??zone?.lower,entryUpper=boundary?.upper??zone?.upper;
  const hasEntryZone=Number.isFinite(entryLower)&&Number.isFinite(entryUpper)&&entryUpper>entryLower;
  const middleLower=boundary?.middleLower??entryLower+(entryUpper-entryLower)*edgePercent/100,middleUpper=boundary?.middleUpper??entryUpper-(entryUpper-entryLower)*edgePercent/100;
  if(hasEntryZone)bounds.push(entryLower,entryUpper);
  const hasActualZone=Number.isFinite(zone?.actualLower)&&Number.isFinite(zone?.actualUpper);
  if(hasActualZone)bounds.push(zone.actualLower,zone.actualUpper);
  const lo = bounds.length ? Math.min(...bounds) : 0;
  const hi = bounds.length ? Math.max(...bounds) : 1;
  const pad = Math.max((hi - lo) * 0.18, hi * 0.00005, 1);
  const min = lo - pad, max = hi + pad;
  const x = t => left + (t - xmin) / (xmax - xmin) * plotWidth;
  const y = p => top + (max - p) / (max - min) * plotHeight;
  const path = points.map((p, i) => `${i ? 'L' : 'M'} ${x(p.time).toFixed(2)} ${y(p.price).toFixed(2)}`).join(' ');
  const last = points.at(-1);
  const onMove = event => {
    if (!points.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - rect.left) / rect.width * width;
    const point = points.reduce((best, p) => Math.abs(x(p.time) - position) < Math.abs(x(best.time) - position) ? p : best, points[0]);
    setHover(point);
  };
  const tooltipWidth = 150;
  const tooltipX = hover ? Math.min(Math.max(x(hover.time) - tooltipWidth / 2, left), Math.max(left, right - tooltipWidth)) : left;
  return <div ref={chartRef} className="price-chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="BTC 实时价格曲线与本场起始参考价">
      <defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#54d6aa" stopOpacity="0.17"/><stop offset="100%" stopColor="#54d6aa" stopOpacity="0"/></linearGradient></defs>
      {hasZone&&zone.fallbackFrom!=null&&<text x={right-8} y={top-4} textAnchor="end" className="axis-label">上一场区间 · 更新中</text>}
      {hasEntryZone&&<g className="chart-entry-zone" pointerEvents="none">
        <rect x={left} y={y(entryUpper)} width={plotWidth} height={y(middleUpper)-y(entryUpper)} fill="#c99a62" opacity="0.09"/>
        <rect x={left} y={y(middleUpper)} width={plotWidth} height={y(middleLower)-y(middleUpper)} fill="#778de9" opacity="0.16"><title>{`中间区域：${fmt(middleLower)} 至 ${fmt(middleUpper)}，不包含两端`}</title></rect>
        <rect x={left} y={y(middleLower)} width={plotWidth} height={y(entryLower)-y(middleLower)} fill="#c99a62" opacity="0.09"/>
        {[['中部上沿',middleUpper],['中部下沿',middleLower]].map(([label,price])=><g key={label}><line x1={left} x2={right} y1={y(price)} y2={y(price)} stroke="#899fe9" strokeOpacity="0.7" strokeDasharray="3 5"/><text x={right-8} y={y(price)+(label==='中部上沿'?-6:14)} textAnchor="end" className="chart-middle-label">{label} {fmt(price)}</text></g>)}
      </g>}
      {Array.from({ length: 5 }, (_, i) => <g key={i}>
        <line x1={left} x2={right} y1={top + i * plotHeight / 4} y2={top + i * plotHeight / 4} stroke="#232831" strokeDasharray="3 5"/>
        <text x={right + 12} y={top + 3 + i * plotHeight / 4} className="axis-label">{bounds.length ? fmt(max - (max - min) * i / 4, 0) : '—'}</text>
      </g>)}
      {hasZone&&<g><line x1={left} x2={right} y1={y(zone.upper)} y2={y(zone.upper)} stroke="#d99676" strokeDasharray="6 4"/><line x1={left} x2={right} y1={y(zone.lower)} y2={y(zone.lower)} stroke="#8ccaac" strokeDasharray="6 4"/><text x={left+8} y={Math.max(top+10,y(zone.upper)-5)} fill="#d99676" fontSize="11">{zone.phase?'压力':'候选压力'}{zone.resistanceSource==='secondary_pivot'?'（次高峰）':''} {fmt(zone.upper)}</text><text x={left+8} y={Math.min(bottom-4,y(zone.lower)+14)} fill="#8ccaac" fontSize="11">{zone.phase?'支撑':'候选支撑'}{zone.supportSource==='secondary_pivot'?'（次低谷）':''} {fmt(zone.lower)}</text></g>}
      {hasActualZone&&[ ['实际最高',zone.actualUpper,zone.upper,'#d99676'],['实际最低',zone.actualLower,zone.lower,'#8ccaac'] ].filter(([,price,inner])=>price!==inner).map(([label,price,,color])=><g key={label}><line x1={left} x2={right} y1={y(price)} y2={y(price)} stroke={color} strokeDasharray="2 3"/><text x={right-6} y={Math.max(top+10,y(price)-4)} fill={color} fontSize="11" textAnchor="end">{label} {fmt(price)}</text></g>)}
      {reference && <line x1={left} x2={right} y1={y(reference)} y2={y(reference)} stroke={provisionalReference?"#d3aa64":"#78818f"} strokeDasharray="5 5"/>}
      {points.length > 1 && <>
        <path d={`${path} L ${x(last.time)} ${bottom} L ${x(points[0].time)} ${bottom} Z`} fill="url(#chartFill)"/>
        <path d={path} fill="none" stroke="#61d9b0" strokeWidth="2.3" strokeLinejoin="round" strokeLinecap="round"/>
      </>}
      {last && <>
        <circle cx={x(last.time)} cy={y(last.price)} r="8" fill="#61d9b0" opacity=".12"/><circle cx={x(last.time)} cy={y(last.price)} r="3.5" fill="#61d9b0"/>
      </>}
      {reference && <text x={right-8} y={y(reference)-7} textAnchor="end" className="chart-target-label"><title>{provisionalReference?'本场开盘时刻的 Polymarket 同源报价，等待官方起始价核对':'本场官方起始价'}</title>{provisionalReference?'target · 待核对':'target'}</text>}
      {Array.from({ length: timeLabels }, (_, i) => <text key={i} x={left + i * plotWidth / (timeLabels - 1)} y={height - 6} className="axis-label" textAnchor={i === 0 ? 'start' : i === timeLabels - 1 ? 'end' : 'middle'}>{time((xmin + (xmax - xmin) * i / (timeLabels - 1)) / 1000)}</text>)}
      {hover && hover.time >= xmin && hover.time <= xmax && <g>
        <line x1={x(hover.time)} x2={x(hover.time)} y1={top} y2={bottom} stroke="#88929f" strokeDasharray="3 4"/>
        <circle cx={x(hover.time)} cy={y(hover.price)} r="4" fill="#dce9e3"/>
        <rect x={tooltipX} y="1" width={tooltipWidth} height="26" rx="5" fill="#28342e"/>
        <text x={tooltipX + tooltipWidth / 2} y="18" textAnchor="middle" fill="#cde8dc" fontSize="11">{time(hover.time / 1000, true)} · {fmt(hover.price)}</text>
      </g>}
    </svg>
    {!points.length && <div className="chart-empty"><Activity size={24}/><span>{waitingForTarget ? '等待 Polymarket 官方起始价…' : '等待 Polymarket 行情报价…'}</span><small>曲线仅展示本机已采集的行情数据</small></div>}
  </div>;
}
