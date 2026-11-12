export const HISTORY_COUNT = 40;

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
