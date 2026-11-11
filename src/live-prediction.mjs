// Display-only estimates. These never become the completed-round forecasts used
// to advance the martingale sequence or settle an account.
export function liveOrderPrediction(order,{spot,now=Date.now(),connected=true,spotError=null}={}) {
  if(order.status!=='open'||!['UP','DOWN'].includes(order.direction)||!connected||spotError)return null;
  const start=order.round*1000,end=(order.end??order.round+300)*1000;
  if(!Number.isFinite(now)||now<start||now>=end||Math.floor(now/300000)*300!==order.round)return null;
  if(spot?.sourceId!=='polymarket'||spot.round!==order.round)return null;
  if(!spot.conditionId||spot.conditionId!==order.conditionId)return null;
  if(order.oracleWindow!=null&&spot.windowSeconds!==order.oracleWindow)return null;
  if(!Number.isFinite(spot.at)||spot.at<start||spot.at>=end||spot.at>now||now-spot.at>6000)return null;
  if(![spot.currentOpen,spot.price].every(value=>Number.isFinite(value)&&value>0))return null;
  const outcome=spot.price>=spot.currentOpen?'UP':'DOWN';
  return {orderId:order.id,open:spot.currentOpen,close:spot.price,outcome,won:order.direction===outcome,
    source:'polymarket_realtime',priceAt:spot.at,observedAt:now,verifiedAt:null,matches:null};
}
