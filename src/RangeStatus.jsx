import React from 'react';
import {Activity,ArrowUpRight,ChevronDown,Info} from 'lucide-react';
const number=value=>Number.isFinite(value)?value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
const stamp=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
export default function RangeStatus({state,mode='paper'}){
  const config=state?.rangeConfig,candidate=state?.rangeAnalysis?.candidate,levels=candidate?.levelAnalysis,vote=state?.rangeAnalysis?.vote,regime=state?.rangeState;
  const signal=state?.entrySignal,direction=signal?.direction,minutes=(state?.accounts?.[mode]?.config?.entryWindow??120)/60;
  const phase=signal?.code==='RANGE_RETURN_CONFIRMING'?`蓝色区域确认 ${regime?.boundaryConfirmCount??0}/${config?.resumeRounds??2}`:signal?.boundary?.paused?'边界观望 · 暂停新单':signal?.usingSavedRange?'沿用已存区间 · 补齐中':levels?.ready?(regime?.phase==='breakout_up'?'上穿已确认':regime?.phase==='breakout_down'?'下破已确认':regime?.breakoutPendingDirection?'突破待确认':candidate.stable?'历史区间内':'区间外观望'):'等待历史行情';
  return <details className="panel range-panel">
    <summary className="panel-heading range-summary"><h2><Activity size={17}/>区间与突破</h2><span className="range-summary-status">{phase}{direction?' · '+direction:''}</span><span className="range-toggle"><span className="range-expand-label">展开</span><span className="range-collapse-label">收起</span><ChevronDown size={16}/></span></summary>
    <div className="range-panel-body">
      <div className="range-metrics"><div><span>方向统计窗口</span><strong>{config?.lookbackHours??2} 小时</strong></div><div><span>当前状态</span><strong>{phase}</strong></div><div><span>历史下界 / 上界</span><strong>{number(signal?.usingSavedRange?regime?.lower:candidate?.lower)} – {number(signal?.usingSavedRange?regime?.upper:candidate?.upper)}</strong></div><div><span>买入方向</span><strong className={direction==='UP'?'green':direction==='DOWN'?'red':''}>{direction||(signal?.boundary?.paused?'暂停新单':'等待方向')}</strong></div></div>
      <div className="range-observations"><span>当前价格 <b>{number(state?.spot?.price)}</b></span><span>近 {config?.lookbackHours??2} 小时 <b className="green">UP {vote?.up??0}</b> · <b className="red">DOWN {vote?.down??0}</b></span><span>方向数据 {vote?.covered??0}/{vote?.expected??'—'} 场</span></div>
      <p className="range-data-note">当前上一场 #{vote?.previousRound??'—'}：{vote?.previousDirection??'等待场次结果'} · {vote?.previousSource==='official'?'官方最终结果':vote?.previousSource==='official_void'?'官方作废':vote?.previousDirection?'未结算，使用场次预计结果':'等待官方起止价或同源末秒价格'}；取市场场次结果，与是否下单及订单盈亏无关。</p>
      <p className="range-data-note">上下侧各 {config?.edgePercent??20}% 边界区域及区间外暂停新单；严格回到中间 {Number((100-2*(config?.edgePercent??20)).toFixed(6))}% 且连续 {config?.resumeRounds??2} 场收盘都在蓝色区域后按返回侧选向：下支撑侧回来买 UP，上压力侧回来买 DOWN；中部沿用此方向，马丁资金序列保留。已有订单继续结算，主策略保持运行。</p>
      <p className="range-data-note">上下界来源：向前平移 {config?.levelLagMinutes??15} 分钟的 {config?.levelLookbackHours??4} 小时窗口（排除最近 {config?.levelLagMinutes??15} 分钟 K 线），{(config?.levelLookbackHours??4)*12} 根 5 分钟实体 K 线的最高/最低价 · 每场结束重算</p>
      <p className="range-data-note">实体峰值 / 次峰值：{number(levels?.peak)} / {number(levels?.secondaryPeak)} · 实体谷值 / 次谷值：{number(levels?.valley)} / {number(levels?.secondaryValley)}</p>
      {signal?.boundary&&<p className="range-data-note">入场参考下界 / 上界：{number(signal.boundary.lower)} / {number(signal.boundary.upper)}；恢复区域：价格 &gt; {number(signal.boundary.middleLower)} 且 &lt; {number(signal.boundary.middleUpper)}（两端不包含）。突破确认期间沿用固定参考区间。</p>}
      {regime?.boundaryPauseSide&&<p className="range-data-note">恢复下单确认：连续 {regime.boundaryConfirmCount??0}/{config?.resumeRounds??2} 场收盘位于蓝色区域；边界收盘、缺失数据、作废均中断计数。只统计暂停后已结束场次，当前场次不计入，下单时当前价格仍须在蓝色区域。</p>}
      <p className="range-data-note">买入触发：有效卖一 &lt; 0.50；成交硬上限：{config?.executionMaxPrice??0.55}（含上限），按 tick 向下取整。</p>
      <p className="range-data-note">突破确认：距离严格超过区间宽度 × {config?.breakoutPercent??0.1}% · 连续 {config?.breakoutRounds??2} 场收盘越线</p>
      {regime?.breakoutPendingDirection&&<p className="range-data-note">固定参考下界 / 上界：{number(regime.breakoutReferenceLower)} / {number(regime.breakoutReferenceUpper)} · {regime.breakoutPendingDirection} 收盘确认 {regime.breakoutCount??0}/{config?.breakoutRounds??2} 场 · {regime.breakoutConfirmedAt?'已确认':'未确认'}<br/>下破线 / 上穿线：{number(regime.breakoutReferenceLower-(regime.breakoutReferenceUpper-regime.breakoutReferenceLower)*(config?.breakoutPercent??0.1)/100)} / {number(regime.breakoutReferenceUpper+(regime.breakoutReferenceUpper-regime.breakoutReferenceLower)*(config?.breakoutPercent??0.1)/100)}{regime.breakoutLastSource&&' · 最近收盘来源：'+regime.breakoutLastSource}</p>}
      <p className="range-data-note">本场使用窗口：{stamp(levels?.start)} – {stamp(levels?.end)} · 下次更新：{stamp(levels?.nextUpdateAt)}</p>
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
  <div className="guide-step"><b>01</b><div><h3>历史上下界每场重算</h3><p>将区间计算窗口向前平移 {config?.levelLagMinutes??15} 分钟，排除近期 K 线，再取此前 {config?.levelLookbackHours??4} 小时官方报价，合成 {(config?.levelLookbackHours??4)*12} 根 5 分钟实体 K 线。最高价为上界，最低价为下界；当前场次的新价格不修改本场历史边界，每场结束后重新计算。缺失场次立即从 Polymarket 接口补取起止价，优先使用官方起止价计算实体；不因逐秒行情断档而拦截交易。补齐期间沿用同配置、同预言机的已存有效区间，补齐后立即更新；尚无任何有效区间时等待真实数据，不补造价格。</p></div></div>
  <div className="guide-step"><b>02</b><div><h3>边界观望，中部恢复</h3><p>首次按近 {config?.lookbackHours??2} 小时五分钟场次 UP/DOWN 多数选向，同票取上一场市场结果反方向，未结算时用场次预计结果。进入上侧或下侧各 {config?.edgePercent??20}% 边界区域（含阈值），以及区间外时暂停新单；只有严格回到中间 {Number((100-2*(config?.edgePercent??20)).toFixed(6))}% 且连续 {config?.resumeRounds??2} 场收盘都在该区域才恢复下单：下支撑侧回来买 UP，上压力侧回来买 DOWN，中部持续沿用此方向；再次进入边界后按最近一侧重新选向。马丁资金序列保留。突破待确认及已确认期间使用固定参考上下界，连续 {config?.breakoutRounds??2} 场收盘越过区间宽度 × {config?.breakoutPercent??0.1}% 的突破线仍用于跟踪状态，但不绕过边界观望。已有订单继续结算，观望本身不复位首笔，也不停止策略。回到中间后仍须满足本场检测时间、每场一次和盘口条件。</p></div></div>
  <div className="guide-step"><b>03</b><div><h3>开盘检测与马丁资金</h3><p>从开盘立即检测，到开盘后 {Number((entryWindow/60).toFixed(4))} 分钟截止。卖一价严格低于 0.50 才触发，成交价允许上涨至 {config?.executionMaxPrice??0.55}（含上限），不再受相对滑点百分比限制；仍检查 tick、最小份额、深度和手续费。每场最多一次；失利翻倍，获胜复位，金额超限从首笔开始。错误记录后重试，配置、行情、每单方向依据和区间历史均保存在 SQLite。</p></div></div>
  <a className="text-button" href="https://polymarket.com/crypto" target="_blank" rel="noreferrer">查看 Polymarket 市场 <ArrowUpRight size={14}/></a>
</div>;}
