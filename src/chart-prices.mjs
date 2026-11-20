// Fast display points supplement the persisted snapshot; they never feed strategy state.
export function mergeChartPrices(saved=[],stream=[]){
  const points=new Map();
  for(const source of [saved,stream])for(const point of source){
    if(Number.isFinite(point?.time)&&Number.isFinite(point?.price)&&point.price>0)points.set(point.time,point);
  }
  return [...points.values()].sort((a,b)=>a.time-b.time);
}
