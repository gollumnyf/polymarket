import {feePerShare,money} from './strategy.mjs';

export const LEAD_DEFAULTS={windowSeconds:15,movePercent:0.05,leadPercent:0.02,firstMaxPrice:0.55,pairProfit:0.03,delayMs:500,minRemaining:30};
export function leadConfig(input={}){
  const c={...LEAD_DEFAULTS,...input};
  const ranges={windowSeconds:[5,60],movePercent:[0.001,2],leadPercent:[0.001,2],firstMaxPrice:[0.01,0.99],pairProfit:[0.001,0.5],delayMs:[250,10000],minRemaining:[10,240]};
  for(const k of Object.keys(c))if(!ranges[k]||typeof c[k]!=='number'||!Number.isFinite(c[k])||c[k]<ranges[k][0]||c[k]>ranges[k][1])throw Error('无效参数：'+k);
  return c;
}
export function leadSignal(samples,now,config){
  const out={direction:null,code:'LEAD_WAIT',message:'等待两路新鲜且完整的同窗口行情'};
  const moves={};
  for(const source of ['binance','official']){
    const rows=samples.filter(x=>x.source===source&&x.receivedAt<=now&&Math.abs(x.time-x.receivedAt)<=5000&&x.price>0).sort((a,b)=>a.receivedAt-b.receivedAt);
    const latest=rows.at(-1),target=now-config.windowSeconds*1000;
    const first=rows.findLast(x=>x.receivedAt<=target);
    if(!latest||!first||now-latest.receivedAt>3000||now-latest.time>6000||target-first.receivedAt>2000)return out;
    const window=rows.filter(x=>x.receivedAt>=first.receivedAt);
    if(window.some((x,i)=>i&&x.receivedAt-window[i-1].receivedAt>3000))return out;
    moves[source]=(latest.price/first.price-1)*100;
  }
  const lead=moves.binance-moves.official,direction=moves.binance>0?'UP':'DOWN';
  const valid=Math.abs(moves.binance)>=config.movePercent&&(direction==='UP'?lead>=config.leadPercent:lead<=-config.leadPercent);
  return {...out,...moves,lead,direction:valid?direction:null,code:valid?null:'LEAD_TOO_SMALL',message:`Binance ${config.windowSeconds}s ${moves.binance.toFixed(4)}%，官方 ${moves.official.toFixed(4)}%，差 ${lead.toFixed(4)}%；${valid?'动量与领先差达到阈值，选择 '+direction:'未达到同向领先阈值'}`};
}
// Equal-share second leg; walk actual asks and reject partial-depth simulations.
export function sharesQuote(book,shares,cap,schedule){
  const tick=Number(book?.tickSize),minimum=Number(book?.minOrderSize);
  if(!(tick>0&&tick<1)||!Number.isFinite(minimum)||minimum<0||!(shares>0)||shares<minimum)throw Error('盘口 tick、最小份额或配对份额无效');
  let remaining=shares,notional=0,fee=0;
  const asks=(book.asks||[]).map(x=>({price:Number(x.price),size:Number(x.size)})).filter(x=>x.price>0&&x.price<1&&x.size>0&&Number.isFinite(x.size)).sort((a,b)=>a.price-b.price);
  for(const x of asks){
    if(Math.abs(x.price/tick-Math.round(x.price/tick))>1e-6)throw Error('卖盘价格不符合 tick');
    if(x.price>cap+1e-10)break;
    const n=Math.min(remaining,x.size);notional+=n*x.price;fee+=n*feePerShare(x.price,schedule);remaining-=n;if(remaining<1e-8)break;
  }
  if(remaining>1e-8)throw Error('配对盘口深度不足或价格超出上限');
  return {shares,notional:money(notional),fee:money(fee),cost:money(notional+fee),price:notional/shares,priceLimit:cap};
}
