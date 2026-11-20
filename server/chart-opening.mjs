import {EventEmitter} from 'node:events';
import {roundStart} from './strategy.mjs';
import {oracleSpec} from './price-feed.mjs';

export class ChartOpening extends EventEmitter{
  constructor({fetchImpl=fetch,now=Date.now,onSpec=()=>{}}={}){
    super();this.fetch=fetchImpl;this.now=now;this.onSpec=onSpec;
    this.value=null;this.task=null;this.lastRound=null;this.retryAt=0;this.marketSpec=null;
  }
  current(){
    return this.value?.round===roundStart(this.now())?this.value:null;
  }
  publish(round,price){
    if(round!==roundStart(this.now())||this.current()||!Number.isFinite(price)||price<=0)return;
    this.value={round,price};
    this.emit('opening',this.value);
  }
  poll(){
    const now=this.now(),round=roundStart(now);
    if(this.task||this.current()||(this.lastRound===round&&now<this.retryAt))return this.task;
    this.lastRound=round;this.retryAt=now+2500;
    const slug='btc-updown-5m-'+round;
    const query=new URLSearchParams({slug,limit:'1'});
    this.task=Promise.resolve()
      .then(async()=>{
        const read=async url=>{
          const r=await this.fetch(url,{signal:AbortSignal.timeout(2000)});
          return r.ok?r.json():null;
        };
        const event=async()=>{
          const events=await read('https://gamma-api.polymarket.com/events?'+query);
          const entry=Array.isArray(events)?events.find(item=>item.slug===slug):null;
          const market=entry?.markets?.find(market=>market.slug===slug);
          if(!market||round!==roundStart(this.now()))return null;
          const spec=oracleSpec(market.cryptoMarketConfig);
          if(this.marketSpec?.round===round&&this.marketSpec.spec.topic!==spec.topic)return null;
          this.marketSpec={round,spec};
          this.onSpec(spec,round);
          return Number(entry.eventMetadata?.priceToBeat);
        };
        const officialPrice=async({seconds})=>{
          const params=new URLSearchParams({symbol:'BTC',eventStartTime:new Date(round*1000).toISOString(),
            endDate:new Date((round+300)*1000).toISOString(),variant:'fiveminute',
            twapEnabled:String(seconds>0),twapLookbackSeconds:String(seconds||60)});
          const prices=await read('https://polymarket.com/api/crypto/crypto-price?'+params);
          return Number(prices?.openPrice);
        };
        if(this.marketSpec?.round===round){
          // Both sources can publish at different times. A pending endpoint cannot hold the other back.
          const positive=async promise=>{
            const price=await promise;
            if(!Number.isFinite(price)||price<=0)throw new Error('Opening not published');
            return price;
          };
          return Promise.any([positive(event()),positive(officialPrice(this.marketSpec.spec))]);
        }
        const price=await event();
        if(Number.isFinite(price)&&price>0)return price;
        if(round===roundStart(this.now())&&this.marketSpec?.round===round)return officialPrice(this.marketSpec.spec);
        return null;
      })
      .then(price=>this.publish(round,price)).catch(()=>{/* The next display poll retries without touching trading state. */})
      .finally(()=>{this.task=null;});
    return this.task;
  }
}
