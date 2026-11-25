// Persisted shared five-second bars, compressed by the configured candle interval.
export function bollingerHistory(store,config,oracleWindow,now=Date.now()){
  if(!store||!Number.isFinite(oracleWindow))return {oracleWindow:null,points:[]};
  const interval=config.intervalSeconds*1000;
  const start=Math.floor((now-(config.period*interval+31*60000))/interval)*interval;
  const points=store.db.prepare(`SELECT last_at AS time,close AS price,oracle_window AS oracleWindow
    FROM range_price_bars WHERE oracle_window=? AND bucket IN (
      SELECT MAX(bucket) FROM range_price_bars WHERE oracle_window=? AND bucket>=? AND bucket<=? AND last_at<=?
      GROUP BY CAST(bucket/? AS INTEGER)
    ) ORDER BY bucket`)
    .all(oracleWindow,oracleWindow,start,now,now,interval);
  return {oracleWindow,points};
}

export class BollingerHistoryRepair{
  constructor({store,marketStore,venue,now=Date.now,canRunBackground=()=>true,isClosing=()=>false}){
    Object.assign(this,{store,marketStore,venue,now,canRunBackground,isClosing});
    this.queue=new Map();this.inflight=new Set();this.retryAt=new Map();this.failures=new Map();
    this.task=null;this.demand=null;this.error=null;
  }
  read(config,window){
    const now=this.now(),interval=config.intervalSeconds*1000;
    const start=Math.floor((now-(config.period*interval+31*60000))/interval)*interval;
    const end=Math.floor(now/interval)*interval;
    const local=bollingerHistory(this.marketStore,config,window,now).points;
    const remote=this.store.bollingerHistoryPrices(window,start,now);
    // Local observed candles take priority. API snapshots fill missing candles only.
    const candles=new Map(remote.filter(p=>p.time%interval===interval-1000).map(p=>[Math.floor(p.time/interval)*interval,p]));
    for(const point of local)candles.set(Math.floor(point.time/interval)*interval,point);
    const missing=[];
    for(let bucket=end-interval;bucket>=start;bucket-=interval)if(!candles.has(bucket))
      missing.push({key:window+':'+(bucket+interval-1000),window,priceAt:bucket+interval-1000});
    const key=`${window}:${config.period}:${config.intervalSeconds}`;
    if(this.demand?.key!==key){this.queue.clear();this.retryAt.clear();this.failures.clear();this.error=null;}
    this.demand={key,at:now};
    const needed=new Set(missing.map(job=>job.key));
    for(const queued of this.queue.keys())if(!needed.has(queued))this.queue.delete(queued);
    for(const job of missing)if(!this.inflight.has(job.key))this.queue.set(job.key,job);
    for(const retry of this.retryAt.keys())if(!needed.has(retry)){this.retryAt.delete(retry);this.failures.delete(retry);}
    if(!missing.length)this.error=null;
    const canFetch=typeof this.venue.fetch==='function';
    const state=!missing.length?'ready':!canFetch?'unavailable':!this.canRunBackground()?'waiting_for_opening':this.error?'retrying':'repairing';
    const points=[...candles.values()].filter(p=>p.time>=start&&p.time<=now).sort((a,b)=>a.time-b.time);
    const result={oracleWindow:window,points,repair:{state,expected:(end-start)/interval,
      available:(end-start)/interval-missing.length,missing:missing.length,active:this.inflight.size,error:this.error}};
    this.poll();return result;
  }
  poll(){
    if(this.task||!this.demand||this.isClosing()||!this.canRunBackground()||typeof this.venue.fetch!=='function'||
      this.now()-this.demand.at>120000||!this.queue.size)return this.task;
    const worker=async()=>{
      while(!this.isClosing()&&this.canRunBackground()&&this.now()-this.demand.at<=120000){
        const job=[...this.queue.values()].find(job=>(this.retryAt.get(job.key)??0)<=this.now());
        if(!job)return;
        this.queue.delete(job.key);this.inflight.add(job.key);
        try{
          const params=new URLSearchParams({symbol:'BTC',eventStartTime:new Date(job.priceAt).toISOString(),
            endDate:new Date(job.priceAt+300000).toISOString(),variant:'fiveminute',
            twapEnabled:String(job.window>0),twapLookbackSeconds:String(job.window||60)});
          const response=await this.venue.fetch('https://polymarket.com/api/crypto/crypto-price?'+params,{signal:AbortSignal.timeout(6000)});
          if(!response.ok)throw Error(`官方历史价格 HTTP ${response.status}`);
          const data=await response.json();
          const price=typeof data.openPrice==='number'||typeof data.openPrice==='string'?Number(data.openPrice):NaN;
          if(!Number.isFinite(price)||price<=0)throw Error('官方接口尚未返回该秒有效参考价');
          if(this.isClosing())return;
          this.store.saveBollingerHistoryPrice({oracleWindow:job.window,time:job.priceAt,price,observedAt:this.now()});
          this.retryAt.delete(job.key);this.failures.delete(job.key);this.error=null;
        }catch(error){
          if(this.isClosing())return;
          const failures=(this.failures.get(job.key)??0)+1;this.failures.set(job.key,failures);
          this.retryAt.set(job.key,this.now()+Math.min(30000,1000*2**Math.min(failures-1,5)));
          this.queue.set(job.key,job);this.error=error.message;
        }finally{this.inflight.delete(job.key);}
      }
    };
    this.task=Promise.resolve().then(()=>Promise.all([worker(),worker()])).finally(()=>{this.task=null;});
    return this.task;
  }
}
