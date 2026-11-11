export function orderTime(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    date:date.toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' }),
    time:date.toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }),
    iso:date.toISOString(),
  };
}

export function settlementPlaceholder(order) {
  return order.status === 'rejected' ? '未成交' : ['won','lost','void'].includes(order.status) ? '未记录' : '待结算';
}
