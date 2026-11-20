export const HISTORY_COUNT = 40;
export const HISTORY_DISPLAY_COUNT = 41;

// Count the same displayed market results as the dots, never trade PnL or forecasts.
export function summarizeHistory(items) {
  return items.reduce((counts,item)=>{
    if(item.result==='UP')counts.up++;
    else if(item.result==='DOWN')counts.down++;
    else if(item.status==='void')counts.void++;
    else counts.pending++;
    return counts;
  },{up:0,down:0,pending:0,void:0});
}

const validDirection=direction=>direction==='UP'||direction==='DOWN';

export function hasPredictedLoss(item) {
  const outcome=item.current?item.result:item.provisional;
  return item.trade?.status==='open'&&validDirection(item.trade.direction)&&validDirection(outcome)&&item.trade.direction!==outcome;
}
export function previousRoundPreview(item,currentRound,latestPrediction) {
  if(item.round!==currentRound-300||item.result||item.status==='resolved'||item.status==='void')return null;
  const fromPrices=Number.isFinite(item.open)&&item.open>0&&Number.isFinite(item.close)&&item.close>0
    ?(item.close>=item.open?'UP':'DOWN'):null;
  if(item.closeSource==='polymarket_event_metadata'&&fromPrices)return fromPrices;
  if(latestPrediction?.round===item.round&&validDirection(latestPrediction.outcome))return latestPrediction.outcome;
  if(validDirection(item.forecast?.outcome))return item.forecast.outcome;
  return fromPrices??(validDirection(item.trade?.prediction?.outcome)?item.trade.prediction.outcome:null);
}
