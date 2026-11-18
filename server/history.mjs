import { roundStart, money, DEFAULT_CONFIG } from './strategy.mjs';
import { safeError } from './polymarket.mjs';
import { recordRoundSignals, SIGNAL_SAMPLE_SECONDS, withReversal } from './round-signals.mjs';
import {oppositeDirection} from '../src/entry-mode.mjs';
import {mergeHistoricalRound} from './history-record.mjs';

import {HISTORY_COUNT} from '../src/history-summary.mjs';
export {HISTORY_COUNT};
const positivePrice = value => {
  if (value == null || value === '') return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
};

export function normalizeHistoricalRound(round, event, resolution) {
  const slug = `btc-updown-5m-${round}`;
  const market = event?.markets?.find(m => m.slug === slug);
  const base = { round, end: round + 300, slug, result: null, status: 'pending',
    open: null, close: null, change: null, changePercent: null };
  if (event?.slug !== slug || !market) return { ...base, status: 'unavailable' };
  base.open = positivePrice(event.eventMetadata?.priceToBeat);
  base.close = positivePrice(event.eventMetadata?.finalPrice);
  if (base.open != null && base.close != null) {
    base.change = money(base.close - base.open);
    base.changePercent = (base.close - base.open) / base.open * 100;
  }
  const final = resolution?.status === 'resolved' && resolution.conditionId === market.conditionId;
  if (!final) return base;
  const payouts = resolution.payouts?.map(Number);
  if (!payouts || payouts.length !== 2 || payouts.some(p => !Number.isFinite(p) || p < 0 || p > 1) ||
      Math.abs(payouts[0] + payouts[1] - 1) > 1e-6) return base;
  let labels;
  try { labels = Array.isArray(market.outcomes) ? market.outcomes : JSON.parse(market.outcomes); }
  catch { return { ...base, status: 'unavailable' }; }
  if (!Array.isArray(labels) || labels.length !== 2) return { ...base, status: 'unavailable' };
  labels = labels.map(label => String(label).toUpperCase());
  if (!labels.includes('UP') || !labels.includes('DOWN')) return { ...base, status: 'unavailable' };
  const winner = payouts.findIndex(p => p === 1);
  base.result = winner >= 0 && payouts[1 - winner] === 0 ? labels[winner] : null;
  base.status = base.result ? 'resolved' : 'void';
  return base;
}

// Presentation-only estimates never overwrite official history or trading predictions.
export function withHistoricalForecast(item,forecast) {
  const officialClose=positivePrice(item.close),open=positivePrice(item.open)??forecast?.open??null;
  const close=officialClose??forecast?.close??null;
  const change=open!=null&&close!=null?money(close-open):null;
  const comparison=item.status==='resolved'?item.result:
    officialClose!=null&&open!=null?(officialClose>=open?'UP':'DOWN'):null;
  return {...item,open,close,change,changePercent:change!=null?change/open*100:null,
    closeSource:officialClose!=null?'polymarket_event_metadata':forecast?forecast.source:null,
    closeAt:officialClose!=null?null:forecast?.priceAt??null,forecast:forecast||null,
    forecastComparison:comparison,
    forecastComparisonSource:['resolved','void'].includes(item.status)?'official_result':'platform_prices',
    forecastMatches:forecast?(item.status==='void'?false:comparison?forecast.outcome===comparison:null):null};
}

// History is read independently of trading ticks. Completed rounds are cached;
// failures cannot delay execution, change positions, or invent a final result.
export class RoundHistory {
  constructor(venue, { now = () => Date.now(), store = null, lookback = HISTORY_COUNT } = {}) {
    this.venue = venue; this.now = now; this.cache = new Map();
    this.store = store; this.lookback=lookback;
    this.lastAttempt = 0; this.updatedAt = null; this.currentRound = null;
    this.inflight = null; this.error = null;
  }
  starts(count=HISTORY_COUNT) {
    const current = roundStart(this.now());
    return Array.from({ length: count }, (_, i) => current - (count - i) * 300);
  }
  lastSecondForecast(item) {
    if(!this.store||this.now()<item.end*1000)return null;
    const saved=this.store.roundPrediction(item.round);
    if(['polymarket_last_second','polymarket_last_available'].includes(saved?.source)&&Number.isFinite(saved.priceAt)&&saved.priceAt<item.end*1000)return saved;
    const reference=this.store.roundOpening(item.round)||
      (saved&&Number.isFinite(saved.oracleWindow)?saved:null)||this.store.roundSignalReference(item.round);
    if(!reference||!Number.isFinite(reference.open)||reference.open<=0)return null;
    const tick=this.store.closingTick(item.round,reference.oracleWindow);
    return tick?{round:item.round,open:reference.open,close:tick.price,outcome:tick.price>=reference.open?'UP':'DOWN',
      oracleWindow:reference.oracleWindow,source:tick.source,priceAt:tick.time}:null;
  }
  snapshot(entryDelay = DEFAULT_CONFIG.entryDelay,followPreviousAtOpen=false,reverseSignal=false) {
    this.syncSaved(this.starts());
    const items = this.starts().map(round => this.cache.get(round) || this.store?.historicalRound(round) || {
      round, end: round + 300, slug: `btc-updown-5m-${round}`, result: null,
      status: 'loading', open: null, close: null, change: null, changePercent: null,
    });
    return { items: items.map(item => {
      if (this.store) recordRoundSignals(this.store,item.round,item.open,[...SIGNAL_SAMPLE_SECONDS,entryDelay]);
      const saved = this.store?.initialSignal(item.round,entryDelay) || null;
      let initial = saved?.rule === 'current_round_open' ? saved : null;
      if(reverseSignal&&initial)initial={...initial,marketDirection:initial.direction,direction:oppositeDirection(initial.direction),rule:'current_round_reverse'};
      else if(followPreviousAtOpen){
        const previous=this.store?.roundPrediction(item.round-300);
        initial=previous?{round:item.round,targetSeconds:entryDelay,observedAt:previous.priceAt??previous.observedAt,
          direction:previous.outcome,price:previous.close,referencePrice:previous.open,source:previous.source,
          rule:'previous_round_prediction'}:null;
      }
      return withReversal(withHistoricalForecast(item,this.lastSecondForecast(item)), initial);
    }), entryDelay,followPreviousAtOpen,reverseSignal,updatedAt: this.updatedAt, error: this.error };
  }
  poll() {
    if (!this.inflight&&(this.currentRound !== roundStart(this.now()) || this.now() - this.lastAttempt >= 15000)) {
      this.inflight = this.refresh().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }
  async read({entryDelay = DEFAULT_CONFIG.entryDelay,followPreviousAtOpen=false,reverseSignal=false} = {}) {
    await this.poll();
    return this.snapshot(entryDelay,followPreviousAtOpen,reverseSignal);
  }
  async refresh() {
    this.lastAttempt = this.now(); this.currentRound = roundStart(this.now());
    const starts = this.starts(this.lookback);
    for (const key of this.cache.keys()) if (!starts.includes(key)) this.cache.delete(key);
    this.syncSaved(starts);
    this.updatedAt = Math.max(this.updatedAt || 0, ...[...this.cache.values()].map(item => item.updatedAt || 0)) || null;
    const missing = starts.filter(round => {
      const item = this.cache.get(round);
      return !item || !['resolved', 'void'].includes(item.status) || item.open == null || item.close == null;
    });
    if (!missing.length) { this.error = null; return; }
    try {
      const query = new URLSearchParams({ limit: String(this.lookback) });
      for (const round of missing) query.append('slug', `btc-updown-5m-${round}`);
      const response = await this.venue.fetch(`https://gamma-api.polymarket.com/events?${query}`);
      if (!response.ok) throw new Error(`历史场次接口 HTTP ${response.status}`);
      const events = await response.json();
      if (!Array.isArray(events)) throw new Error('历史场次响应无效');
      const wanted = new Set(missing.map(round => `btc-updown-5m-${round}`));
      const selected = events.filter(event => wanted.has(event.slug));
      const conditions = [...new Set(selected.flatMap(event => event.markets || [])
        .filter(m => wanted.has(m.slug)).map(m => m.conditionId).filter(Boolean))];
      if (conditions.length > this.lookback) throw new Error('历史场次包含异常数量的市场');
      // The SDK accepts at most 20 IDs, independently of the displayed count.
      // Keep successful batches and event prices even if another batch fails.
      const resolutions=[],errors=[];
      for(let offset=0;offset<conditions.length;offset+=20){
        try{
          const batch=await this.venue.public.fetchResolutions({conditionIds:conditions.slice(offset,offset+20)});
          if(!Array.isArray(batch))throw new Error('历史结算响应无效');
          resolutions.push(...batch);
        }catch(error){errors.push(safeError(error));}
      }
      for (const round of missing) {
        const slug = `btc-updown-5m-${round}`;
        const event = selected.find(e => e.slug === slug);
        const market = event?.markets?.find(m => m.slug === slug);
        const resolution = resolutions.find(r => r.conditionId === market?.conditionId);
        const next = normalizeHistoricalRound(round, event, resolution);
        const merged=mergeHistoricalRound(this.cache.get(round),next);
        this.cache.set(round,this.store?this.store.saveHistoricalRound(merged,this.now()):{...merged,updatedAt:this.now()});
      }
      this.updatedAt = this.now(); this.error = errors.length?[...new Set(errors)].join('；'):null;
    } catch (error) { this.error = safeError(error); }
  }
  syncSaved(starts) {
    for(const round of starts){
      const saved=this.store?.historicalRound(round),cached=this.cache.get(round);
      if(!saved)continue;
      // The strategy's background history poll can settle a round without this
      // page fetching it. Prefer its latest saved result over stale page memory.
      const next=(saved.updatedAt??0)>=(cached?.updatedAt??0)?mergeHistoricalRound(cached,saved):mergeHistoricalRound(saved,cached);
      this.cache.set(round,next);
      this.updatedAt=Math.max(this.updatedAt||0,next.updatedAt||0)||null;
    }
  }
}
