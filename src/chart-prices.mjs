// Fast display points supplement the persisted snapshot; they never feed strategy state.
export function mergeChartPrices(saved=[],stream=[]){
  const points=new Map();
  for(const source of [saved,stream])for(const point of source){
    if(Number.isFinite(point?.time)&&Number.isFinite(point?.price)&&point.price>0)points.set(point.time,point);
  }
  return [...points.values()].sort((a,b)=>a.time-b.time);
}

export function chartTimeWindow(ticks,{start,now,range}){
  // Accept the same small timestamp lead as the official feed, without crossing rounds.
  const latest=ticks.at(-1)?.time;
  const upper=Number.isFinite(latest)&&latest<=now+2000?Math.max(now,latest):now;
  return range==='round'
    ?{xmin:start*1000,xmax:(start+300)*1000,visibleThrough:Math.min(upper,(start+300)*1000-1)}
    :{xmin:upper-1800000,xmax:upper,visibleThrough:upper};
}

// Give the official target a short head start; a delayed HTTP result must not blank live quotes.
export function holdChartForOpening({range,start,now,reference}){
  return range==='round'&&!(Number.isFinite(reference)&&reference>0)&&now<start*1000+2000;
}

export function chartOpeningReference(ticks,opening,round){
  if(opening?.round===round&&Number.isFinite(opening.price)&&opening.price>0)
    return {price:opening.price,provisional:false};
  const time=round*1000,latest=ticks.at(-1);
  if(latest?.time<time||!Number.isFinite(latest?.oracleWindow))return null;
  const boundary=ticks.find(point=>point.time===time&&point.oracleWindow===latest.oracleWindow);
  return Number.isFinite(boundary?.price)&&boundary.price>0?{price:boundary.price,provisional:true}:null;
}
