import { money,resetAtAmountLimit } from './strategy.mjs';

function validPriceSource(round,prices){
  return ['polymarket_event_metadata','polymarket_crypto_price'].includes(prices.source)||
    (prices.source==='polymarket_last_second'&&Number.isFinite(prices.priceAt)&&prices.priceAt>=(round+299)*1000&&prices.priceAt<(round+300)*1000);
}

export function roundPredictionFromPrices(round,prices,now) {
  if (!prices || prices.round !== round || now<(round+300)*1000 ||
      !validPriceSource(round,prices) ||
      typeof prices.conditionId !== 'string' || !prices.conditionId ||
      ![prices.open,prices.close].every(price=>Number.isFinite(price) && price>0)) return null;
  return {round,conditionId:prices.conditionId,open:prices.open,close:prices.close,
    outcome:prices.close>=prices.open?'UP':'DOWN',source:prices.source,
    oracleWindow:prices.oracleWindow ?? null,observedAt:now,priceAt:prices.priceAt??null};
}

export function predictionFromPrices(order, prices, now) {
  if (!prices || !validPriceSource(order.round,prices) ||
      prices.round !== order.round || prices.conditionId !== order.conditionId ||
      !Number.isFinite(order.end) || now < order.end*1000 ||
      !['UP','DOWN'].includes(order.direction) ||
      ![prices.open,prices.close].every(price => Number.isFinite(price) && price > 0)) return null;
  const outcome = prices.close >= prices.open ? 'UP' : 'DOWN';
  return { orderId:order.id,open:prices.open,close:prices.close,outcome,
    won:outcome === order.direction,source:prices.source,observedAt:now,
    priceAt:prices.priceAt??null,verifiedAt:null,matches:null };
}

// Confirmed account statistics remain untouched until official settlement.
// Pending predictions only advance the stake sequence in round order.
export function projectedAccount(account, pending) {
  let sequence=resetAtAmountLimit(account), projectedCount=0, amountLimitResets=sequence===account?0:1;
  for (const order of pending) {
    if (order.status !== 'open' || !order.prediction) break;
    const advanced={...sequence,losses:order.prediction.won?0:sequence.losses+1,
      cycle:sequence.cycle+(order.prediction.won?1:0)};
    sequence=resetAtAmountLimit(advanced);
    if(sequence!==advanced)amountLimitResets++;
    projectedCount++;
  }
  // Unsettled winners are not treated as available cash or realized profit.
  const exposure=pending.reduce((sum,order) => sum+(order.cost ?? order.budget ?? 0),0);
  return {...sequence,projectedCount,amountLimitResets,
    riskPnl:money(account.pnl-exposure),confirmedLosses:account.losses};
}
