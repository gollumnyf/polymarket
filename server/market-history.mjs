import {DAY_MS,REPORT_TIMEZONE,dateKey,dateStart} from '../src/report-dates.mjs';
import {normalizeHistoricalRound} from './history.mjs';
import {safeError} from './polymarket.mjs';
import {ROUND_SECONDS,roundStart} from './strategy.mjs';

const RETRY_MS=60000,BATCH_SIZE=20,LEASE_MS=120000;
const price=value=>Number.isFinite(value)&&value>0?value:null;
const direction=value=>value==='UP'||value==='DOWN'?value:null;
const fromPrices=(open,close)=>open!=null&&close!=null?(close>=open?'UP':'DOWN'):null;
const final=row=>row?.status==='void'||row?.status==='resolved'&&direction(row.result);
const slug=round=>`btc-updown-5m-${round}`;
const eventSource='polymarket_event_metadata',priceSource='polymarket_crypto_price';
const matchesPrice=(known,received)=>known==null||Math.abs(known-received)<=1e-6;
const predictionPriority=['polymarket_event_metadata','polymarket_crypto_price','polymarket_last_second','polymarket_last_available'];

function indexRows(rows){return new Map(rows.map(row=>[row.round,row]));}

export class MarketHistory {
  constructor(store,venue,{sources=[],canRefresh=()=>true,now=Date.now}={}){
    this.store=store;this.venue=venue;this.stores=[...new Set([store,...sources])];
    this.now=now;this.canRefresh=canRefresh;this.pending=new Map();this.closed=false;
    this.inflight=null;this.controller=null;this.retryAfter=0;this.error=null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS market_history_cache (
      round INTEGER PRIMARY KEY, status TEXT NOT NULL,
      result TEXT CHECK(result IN ('UP','DOWN')), open REAL, close REAL,
      checked_at INTEGER NOT NULL, verified_at INTEGER, close_source TEXT
    )`);
    if(!store.db.prepare('PRAGMA table_info(market_history_cache)').all().some(column=>column.name==='close_source'))
      store.db.exec('ALTER TABLE market_history_cache ADD COLUMN close_source TEXT');
  }

  read(date=dateKey(this.now())){
    const now=this.now(),start=dateStart(date)/1000;
    if(date>dateKey(now))throw Error('请选择今天或更早的日期');
    const end=Math.min(start+DAY_MS/1000,roundStart(now));
    const select=(store,fields,table)=>indexRows(store.db.prepare(`SELECT ${fields} FROM ${table} WHERE round>=? AND round<?`).all(start,end));
    const cached=select(this.store,'*','market_history_cache');
    const history=this.stores.map(store=>select(store,'round,status,result,open,close','round_history'));
    const forecasts=this.stores.map(store=>select(store,'round,outcome AS result,open_price AS open,close_price AS close,source','round_predictions'));
    const openings=this.stores.map(store=>select(store,'round,open_price AS open,oracle_window','round_openings'));
    const votes=select(this.store,'round,outcome AS result,open_price AS open,close_price AS close,source','range_votes');
    const savedPrices=new Map();
    for(const item of this.store.db.prepare('SELECT round,oracle_window,open_price AS open,close_price AS close FROM range_market_prices WHERE round>=? AND round<?').all(start,end)){
      const group=savedPrices.get(item.round)??[];group.push(item);savedPrices.set(item.round,group);
    }
    const items=[];
    for(let round=start;round<end;round+=ROUND_SECONDS){
      const cache=cached.get(round);
      if(cache?.verified_at!=null){
        items.push({round,end:round+ROUND_SECONDS,status:cache.status,result:cache.result,open:cache.open,close:cache.close,
          closeSource:cache.close_source??eventSource,verifiedAt:cache.verified_at});
        continue;
      }
      if(!this.closed&&now-(cache?.checked_at??-Infinity)>=RETRY_MS&&!this.inflight?.rounds.includes(round))
        this.pending.set(round,now+LEASE_MS);

      const rows=[cache,...history.map(rows=>rows.get(round))].filter(Boolean);
      const vote=votes.get(round);
      const resolution=rows.find(final)??(vote?.source==='official_void'?{status:'void'}:vote?.source==='official'&&direction(vote.result)?{status:'resolved',result:vote.result}:null);
      const candidates=[...forecasts.map(rows=>rows.get(round)),vote];
      const forecast=predictionPriority.map(source=>candidates.find(row=>row?.source===source&&direction(row.result))).find(Boolean);
      const opening=openings.map(rows=>rows.get(round)).find(row=>price(row?.open));
      const matching=savedPrices.get(round)??[];
      const platform=opening?matching.find(row=>row.oracle_window===opening.oracle_window):matching.length===1?matching[0]:null;
      const open=rows.map(row=>price(row.open)).find(Boolean)??price(platform?.open)??price(vote?.open)??price(forecast?.open)??price(opening?.open);
      const savedClose=rows.find(row=>price(row.close));
      const metadataClose=savedClose?.close??null;
      const platformClose=price(platform?.close);
      const close=metadataClose??platformClose??price(vote?.close)??price(forecast?.close);
      const result=resolution?.status==='void'?null:direction(resolution?.result)??fromPrices(open,close)??direction(forecast?.result);
      const status=resolution?.status==='void'?'unverified-void':result?'unverified':open!=null||close!=null||rows.some(row=>row.status==='pending')?'pending':'missing';
      items.push({round,end:round+ROUND_SECONDS,status,result,open,close,verifiedAt:null,
        closeSource:savedClose?(savedClose.close_source??eventSource):platformClose!=null?priceSource:vote?.close!=null?vote.source:forecast?.source??null});
    }
    const refreshing=this.inflight?.rounds.some(round=>round>=start&&round<end)||[...this.pending.keys()].some(round=>round>=start&&round<end);
    return {date,timezone:REPORT_TIMEZONE,items,refreshing:Boolean(refreshing),error:items.some(item=>item.verifiedAt==null)?this.error:null};
  }

  poll(){
    if(this.closed||this.inflight||!this.canRefresh()||this.now()<this.retryAfter)return null;
    const now=this.now();
    for(const [round,until] of this.pending)if(until<=now)this.pending.delete(round);
    const rounds=[...this.pending.keys()].slice(0,BATCH_SIZE);
    if(!rounds.length)return null;
    for(const round of rounds)this.pending.delete(round);
    this.controller=new AbortController();
    const signal=this.controller.signal;
    const task=this.refresh(rounds,signal).catch(error=>{
      if(this.closed)return;
      this.error=safeError(error);this.retryAfter=this.now()+RETRY_MS;
      for(const round of rounds)this.pending.set(round,this.now()+LEASE_MS);
    }).finally(()=>{this.inflight=null;this.controller=null;});
    this.inflight={rounds,task};return task;
  }

  async refresh(rounds,signal){
    const query=new URLSearchParams({limit:String(rounds.length)});
    for(const round of rounds)query.append('slug',slug(round));
    const response=await this.venue.fetch(`https://gamma-api.polymarket.com/events?${query}`,{signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
    if(!response.ok)throw Error(`官方场次接口 HTTP ${response.status}`);
    const result=await response.json();
    if(!Array.isArray(result))throw Error('官方场次响应无效');
    const wanted=new Set(rounds.map(slug));
    const events=new Map(result.filter(event=>wanted.has(event.slug)).map(event=>[event.slug,event]));
    const markets=new Map([...events].map(([key,event])=>[key,event.markets?.find(market=>market.slug===key)]));
    const conditionIds=[...new Set([...markets.values()].map(market=>market?.conditionId).filter(Boolean))];
    if(this.closed)return;
    if(!this.canRefresh()){
      for(const round of rounds)this.pending.set(round,this.now()+LEASE_MS);
      return;
    }
    let resolutions=[],resolutionError=null;
    if(conditionIds.length){
      try{
        const results=await this.venue.public.fetchResolutions({conditionIds},
          {retries:0,timeout:5000,signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
        if(!Array.isArray(results))throw Error('官方结算响应无效');
        resolutions=results;
      }catch(error){resolutionError=error;}
    }
    if(this.closed)return;
    const settlement=new Map(resolutions.map(row=>[row.conditionId,row]));
    const checked=[];
    let priceError=null;
    for(const round of rounds){
      const key=slug(round),event=events.get(key),market=markets.get(key);
      const item=normalizeHistoricalRound(round,event,settlement.get(market?.conditionId));
      let source=item.close==null?null:eventSource;
      if(final(item)&&(item.open==null||item.close==null)){
        if(!this.canRefresh()){
          this.pending.set(round,this.now()+LEASE_MS);
          continue;
        }
        try{
          const pair=await this.venue.roundPrices({round,end:item.end,conditionId:market.conditionId},
            {event,signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
          if(this.closed)return;
          if(pair?.round===round&&pair.conditionId===market.conditionId&&pair.source===priceSource&&price(pair.open)&&price(pair.close)&&
             matchesPrice(item.open,pair.open)&&matchesPrice(item.close,pair.close)){
            item.open??=pair.open;item.close??=pair.close;
            source??=priceSource;
          }
        }catch(error){if(this.closed)return;priceError??=error;}
      }
      checked.push({item,source});
    }
    const checkedAt=this.now();
    this.store.transaction(()=>{
      for(const {item,source} of checked){
        const consistent=item.status==='void'||item.result===fromPrices(item.open,item.close);
        const verifiedAt=final(item)&&item.open!=null&&item.close!=null&&consistent?checkedAt:null;
        this.store.db.prepare(`INSERT INTO market_history_cache (round,status,result,open,close,checked_at,verified_at,close_source)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(round) DO UPDATE SET status=excluded.status,result=excluded.result,
          open=COALESCE(excluded.open,market_history_cache.open),close=COALESCE(excluded.close,market_history_cache.close),
          close_source=COALESCE(excluded.close_source,market_history_cache.close_source),
          checked_at=excluded.checked_at,verified_at=excluded.verified_at WHERE market_history_cache.verified_at IS NULL`)
          .run(item.round,item.status,item.result,item.open,item.close,checkedAt,verifiedAt,source);
      }
    });
    this.error=resolutionError||priceError?safeError(resolutionError??priceError):null;
    if(resolutionError)this.retryAfter=checkedAt+RETRY_MS;
  }

  close(){this.closed=true;this.controller?.abort();this.pending.clear();}
}
