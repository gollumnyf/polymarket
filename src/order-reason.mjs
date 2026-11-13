// Older orders can only be described from their archived decision evidence.
// Never infer an old reason from today's strategy configuration or signal.
export function orderReason(order) {
  if(order.entryReason)return order.entryReason;
  const s=order.streakSignal,r=order.rangeSignal,m=order.momentumSignal;
  if(s)return `历史依据还原：当时采用连续 ${s.roundsRequired} 场 ${s.marketDirection} 的反买方向 ${order.direction}，触发区间 #${s.firstRound}–#${s.lastRound}。${s.lastRound===order.round-300?'触发区间紧邻本场。':'当时沿用了更早的触发记录，并非本场紧前 N 场。'}依据：${s.samples.map(x=>`#${x.round} ${x.outcome}（${x.source==='official'?'官方结果':'预计结果'}）`).join('、')}。`;
  if(r){
    if(r.directionRule==='boundary_return'||r.lockedDirectionRule==='boundary_return')return `历史依据还原：从${r.boundaryResumeSide==='lower'?'下支撑侧向上':'上压力侧向下'}返回中间区域，${r.boundaryConfirmCount==null?'当时未保存连续收盘确认数':`连续 ${r.boundaryConfirmCount} 场收盘确认`}后采用 ${order.direction}；下单参考价 ${r.price}，支撑 ${r.lower}，压力 ${r.upper}。`;
    if(r.phase==='breakout_up'||r.phase==='breakout_down')return `历史依据还原：连续 ${r.breakoutCount??'未记录'} 场收盘确认${order.direction==='UP'?'向上':'向下'}突破，买 ${order.direction}；参考下界 ${r.breakoutReferenceLower} / 上界 ${r.breakoutReferenceUpper}。`;
    if(r.directionRule==='tie_reverse_previous'||r.lockedDirectionRule==='tie_reverse_previous')return `历史依据还原：选向时 UP ${r.decisionUpCount??r.upCount} / DOWN ${r.decisionDownCount??r.downCount} 同票，取当时上一场 #${r.tiePreviousRound??r.lockedPreviousRound} ${r.tiePreviousDirection??r.lockedPreviousDirection} 的反方向，区间内沿用 ${order.direction}。`;
    return `历史依据还原：区间内沿用 ${order.direction}；选向时 UP ${r.upCount} / DOWN ${r.downCount}，下单参考价 ${r.price}，支撑 ${r.lower}，压力 ${r.upper}。`;
  }
  if(m)return `历史依据还原：本场初始价 ${order.referencePrice}，最近两笔官方价格 ${m.previousPrice} → ${m.latestPrice}，本场方向和最新变动同向，买 ${order.direction}。`;
  return '此旧订单未保存完整下单原因，无法准确还原；新订单会保存下单时的策略及价格依据。';
}
