import { signalDirection, DEFAULT_CONFIG } from './strategy.mjs';

export const EARLY_SIGNAL_SECONDS = DEFAULT_CONFIG.entryDelay;
export const EARLY_SIGNAL_TOLERANCE = 5;
export const SIGNAL_SAMPLE_SECONDS = Object.freeze([5,10,15,20,35,40,45,50,55,60]);

export function earlySignalFromTick(round, point, openingPrice, details = {}) {
  const targetSeconds = details.targetSeconds ?? EARLY_SIGNAL_SECONDS;
  if (!Number.isInteger(targetSeconds) || targetSeconds < 0 || targetSeconds > 240 ||
      !point || !Number.isFinite(openingPrice) || openingPrice <= 0 ||
      !Number.isFinite(point.price) || point.price <= 0 || !Number.isFinite(point.time) ||
      point.time < (round + targetSeconds) * 1000 ||
      point.time > (round + targetSeconds + EARLY_SIGNAL_TOLERANCE) * 1000) return null;
  return { ...details, round, targetSeconds, observedAt: point.time,
    direction: signalDirection(openingPrice, point.price), price: point.price,
    referencePrice: openingPrice, source: 'polymarket', rule: 'current_round_open' };
}

export function withReversal(item, initial) {
  const directional = ['UP', 'DOWN'].includes(initial?.direction);
  const finalized = item.status === 'resolved' && ['UP', 'DOWN'].includes(item.result);
  return { ...item, initialSignal: initial || null,
    reversal: directional && finalized ? initial.direction !== item.result : null };
}

// Cache each observation separately so changing entry time never overwrites an
// earlier rule. Raw oracle ticks also allow filling samples after delayed opens.
export function recordRoundSignals(store, round, openingPrice, targets = SIGNAL_SAMPLE_SECONDS, details = {}) {
  for (const targetSeconds of new Set(targets)) {
    const saved = store.initialSignal(round,targetSeconds);
    if (saved?.rule === 'current_round_open') continue;
    const point = saved ? {time:saved.observedAt,price:saved.price} : store.firstOracleTick(round,targetSeconds);
    const initial = earlySignalFromTick(round,point,openingPrice,{...details,targetSeconds});
    if (initial) store.saveInitialSignal(initial);
  }
}
