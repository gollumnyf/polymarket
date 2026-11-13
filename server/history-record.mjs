import {money} from './strategy.mjs';

// An incomplete refresh may add prices, but must never erase a final payout.
export function mergeHistoricalRound(previous,item) {
  if(!previous)return item;
  if(!item)return previous;
  const final=value=>['resolved','void'].includes(value?.status);
  const next={...previous,...item};
  if(final(previous)&&!final(item)){
    next.status=previous.status;next.result=previous.result;
  }else if(item.status==='unavailable'&&previous.status!=='unavailable'){
    next.status=previous.status;next.result=previous.result;
  }
  for(const key of ['open','close'])next[key]=item[key]??previous[key]??null;
  next.change=next.open!=null&&next.close!=null?money(next.close-next.open):null;
  next.changePercent=next.change!=null?(next.close-next.open)/next.open*100:null;
  return next;
}
