import React from 'react';
import {Activity,ArrowUpRight,ChevronDown,Info} from 'lucide-react';
const number=value=>Number.isFinite(value)?value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
const stamp=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
export default function RangeStatus({state}){
  const config=state?.rangeConfig,candidate=state?.rangeAnalysis?.candidate,levels=candidate?.levelAnalysis,vote=state?.rangeAnalysis?.vote,regime=state?.rangeState;
  const signal=state?.entrySignal,direction=signal?.direction,minutes=(state?.accounts?.paper?.config?.entryWindow??120)/60;
  const phase=signal?.usingSavedRange?'沿用已存区间 · 补齐中':levels?.ready?(regime?.phase==='breakout_up'?'上穿已确认':regime?.phase==='breakout_down'?'下破已确认':regime?.breakoutPendingDirection?'突破待确认':candidate.stable?'历史区间内':'边界反向'):'等待历史行情';
  return <details className="panel range-panel">
    <summary className="panel-heading range-summary"><h2><Activity size={17}/>区间与突破</h2><span className="range-summary-status">{phase}{direction?' · '+direction:''}</span><span className="range-toggle"><span className="range-expand-label">展开</span><span className="range-collapse-label">收起</span><ChevronDown size={16}/></span></summary>
    <div className="range-panel-body">
      <div className="range-metrics"><div><span>方向统计窗口</span><strong>{config?.lookbackHours??2} 小时</strong></div><div><span>当前状态</span><strong>{phase}</strong></div><div><span>历史下界 / 上界</span><strong>{number(signal?.usingSavedRange?regime?.lower:candidate?.lower)} – {number(signal?.usingSavedRange?regime?.upper:candidate?.upper)}</strong></div><div><span>买入方向</span><strong className={direction==='UP'?'green':direction==='DOWN'?'red':''}>{direction||'等待方向'}</strong></div></div>
      <div className="range-observations"><span>当前价格 <b>{number(state?.spot?.price)}</b></span><span>近 {config?.lookbackHours??2} 小时 <b className="green">UP {vote?.up??0}</b> · <b className="red">DOWN {vote?.down??0}</b></span><span>方向数据 {vote?.covered??0}/{vote?.expected??'—'} 场</span></div>
      <p className="range-data-note">当前上一场 #{vote?.previousRound??'—'}：{vote?.previousDirection??'等待场次结果'} · {vote?.previousSource==='official'?'官方最终结果':vote?.previousSource==='official_void'?'官方作废':vote?.previousDirection?'未结算，使用场次预计结果':'等待官方起止价或同源末秒价格'}；取市场场次结果，与是否下单及订单盈亏无关。</p>
      <p className="range-data-note">区间内沿用基础方向，边界附近反向；越界须同时满足距离和连续收盘场数才顺向。</p>
      <p className="range-data-note">上下界来源：近 {config?.levelLookbackHours??4} 小时官方报价，{(config?.levelLookbackHours??4)*12} 根 5 分钟实体 K 线的最高/最低价 · 每场结束重算</p>
      <p className="range-data-note">实体峰值 / 次峰值：{number(levels?.peak)} / {number(levels?.secondaryPeak)} · 实体谷值 / 次谷值：{number(levels?.valley)} / {number(levels?.secondaryValley)}</p>
      <p className="range-data-note">突破确认：距离严格超过区间宽度 × {config?.breakoutPercent??0.1}% · 连续 {config?.breakoutRounds??2} 场收盘越线</p>
      {regime?.breakoutPendingDirection&&<p className="range-data-note">固定参考下界 / 上界：{number(regime.breakoutReferenceLower)} / {number(regime.breakoutReferenceUpper)} · {regime.breakoutPendingDirection} 收盘确认 {regime.breakoutCount??0}/{config?.breakoutRounds??2} 场 · {regime.breakoutConfirmedAt?'已确认':'未确认，继续边界反向'}<br/>下破线 / 上穿线：{number(regime.breakoutReferenceLower-(regime.breakoutReferenceUpper-regime.breakoutReferenceLower)*(config?.breakoutPercent??0.1)/100)} / {number(regime.breakoutReferenceUpper+(regime.breakoutReferenceUpper-regime.breakoutReferenceLower)*(config?.breakoutPercent??0.1)/100)}{regime.breakoutLastSource&&' · 最近收盘来源：'+regime.breakoutLastSource}</p>}
      <p className="range-data-note">本场使用窗口：{stamp(levels?.start)} – {stamp(levels?.end)} · 下次更新：{stamp(levels?.end?levels.end+300000:null)}</p>
      <p className="range-data-note">有效 K 线 {levels?.validCandles??0}/{levels?.expected??((config?.levelLookbackHours??4)*12)} 根 · 最长断档 {number(Number.isFinite(levels?.maxGapMs)?levels.maxGapMs/1000:null)} 秒（仅作记录，不限制交易） · 官方起止价 {levels?.officialCandles??0} 场</p>
      <p className="range-data-note">历史补齐：{state?.historyRepair?.active??0} 场正在获取，{state?.historyRepair?.pending??0} 场排队；缺失立即补取，每场返回即重算</p>
      {state?.historyRepair?.lastError&&<p className="range-data-note">{state.historyRepair.lastError}；正在重试</p>}
      <p className="range-data-note">入场检测：开盘立即开始，截止开盘后 {Number(minutes.toFixed(4))} 分钟；每场最多买入一次</p>
      {regime?.tradeFromRound&&<p className="range-data-note">突破后最早执行场次：#{regime.tradeFromRound} · {stamp(regime.tradeFromRound*1000)}</p>}
      {!levels?.ready&&candidate?.blockingReasons?.length>0&&<div className="range-blockers"><strong>历史数据尚未就绪</strong><ul>{candidate.blockingReasons.map(reason=><li key={reason.code}>{reason.message}</li>)}</ul></div>}
      <p className="range-explanation"><Info size={14}/><span>{signal?.message||'正在读取官方历史行情'}</span></p>
    </div>
  </details>;
}
export function RangeGuide({config,entryWindow=120}){return <div className="guide">
  <div className="guide-step"><b>01</b><div><h3>历史上下界每场重算</h3><p>使用近 {config?.levelLookbackHours??4} 小时官方报价，按每个五分钟场次的起始时刻向前合成 {(config?.levelLookbackHours??4)*12} 根 5 分钟实体 K 线。最高价为上界，最低价为下界；当前场次的新价格不修改本场历史边界，每场结束后重新计算。缺失场次立即从 Polymarket 接口补取起止价，优先使用官方起止价计算实体；不因逐秒行情断档而拦截交易。补齐期间沿用同配置、同预言机的已存有效区间，补齐后立即更新；尚无任何有效区间时等待真实数据，不补造价格。</p></div></div>
  <div className="guide-step"><b>02</b><div><h3>靠近边界反向，持续越界顺向</h3><p>当前价格位于上下界之间（包含边界）即属于区间内，无需观察往返、重复触及或限制宽度。首次按近 {config?.lookbackHours??2} 小时五分钟场次 UP/DOWN 多数选向；同票取上一场结果反方向，官方未结算用已有预测，缺少方向数据时等待。价格在中部时沿用已选方向；进入上侧 20% 边界带买 DOWN，进入下侧 20% 边界带买 UP，帮助价格回到区间中部。上穿或下破后固定参考上下界；连续 {config?.breakoutRounds??2} 个已结束场次的收盘价严格超过同一突破线才确认，距离为参考区间宽度的 {config?.breakoutPercent??0.1}%。等于突破线不算，同场不重复计数，缺少收盘数据等待补齐，收盘未达标重新计数。确认前越过压力仍买 DOWN、跌破支撑仍买 UP；确认时最新价格也须越线，才从下一场开始顺向买入。已确认后持续跟随，回到固定参考区间内再重新选向。</p></div></div>
  <div className="guide-step"><b>03</b><div><h3>开盘检测与马丁资金</h3><p>从开盘立即检测，到开盘后 {Number((entryWindow/60).toFixed(4))} 分钟截止。买价严格低于 0.50，检查 tick、最小份额、深度和手续费。每场最多一次；失利翻倍，获胜复位，金额超限从首笔开始。错误记录后重试，配置、行情、每单方向依据和区间历史均保存在 SQLite。</p></div></div>
  <a className="text-button" href="https://polymarket.com/crypto" target="_blank" rel="noreferrer">查看 Polymarket 市场 <ArrowUpRight size={14}/></a>
</div>;}
