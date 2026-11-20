// Display-only estimates. These never become the completed-round forecasts used
// to advance the martingale sequence or settle an account.
export function liveRoundPrediction(round,{spot,now=Date.now(),connected=true,spotError=null}={},endRound=round+300) {
  if(!connected||spotError)return null;
  const start=round*1000,end=endRound*1000;
  if(!Number.isFinite(now)||now<start||now>=end||Math.floor(now/300000)*300!==round)return null;
  if(spot?.sourceId!=='polymarket'||spot.round!==round||!spot.conditionId)return null;
  if(!Number.isFinite(spot.at)||spot.at<start||spot.at>=end||spot.at>now||now-spot.at>6000)return null;
  if(![spot.currentOpen,spot.price].every(value=>Number.isFinite(value)&&value>0))return null;
  return {open:spot.currentOpen,close:spot.price,outcome:spot.price>=spot.currentOpen?'UP':'DOWN',
    source:'polymarket_realtime',priceAt:spot.at,observedAt:now,verifiedAt:null,matches:null};
}

export function liveOrderPrediction(order,context={}) {
  if(order.status!=='open'||!['UP','DOWN'].includes(order.direction))return null;
  const spot=context.spot;
  if(!spot?.conditionId||spot.conditionId!==order.conditionId)return null;
  if(order.oracleWindow!=null&&spot.windowSeconds!==order.oracleWindow)return null;
  const prediction=liveRoundPrediction(order.round,context,order.end??order.round+300);
  return prediction&&{...prediction,orderId:order.id,won:order.direction===prediction.outcome};
}
