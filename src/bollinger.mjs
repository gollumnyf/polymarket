export const BOLLINGER_DEFAULTS=Object.freeze({enabled:true,period:20,deviations:2,intervalSeconds:60});

export function validateBollinger(input,current=BOLLINGER_DEFAULTS){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('布林线参数必须为对象');
  for(const key of Object.keys(input))if(!Object.hasOwn(BOLLINGER_DEFAULTS,key))throw Error('不支持的布林线参数：'+key);
  const config={...current,...input};
  if(typeof config.enabled!=='boolean')throw Error('布林线开关必须为布尔值');
  if(!Number.isInteger(config.period)||config.period<2||config.period>200)throw Error('布林线周期须为 2–200 根 K 线');
  if(typeof config.deviations!=='number'||!Number.isFinite(config.deviations)||config.deviations<0.1||config.deviations>10)throw Error('标准差倍数须为 0.1–10');
  if(![15,30,60,300].includes(config.intervalSeconds))throw Error('K 线时长须为 15 秒、30 秒、1 分钟或 5 分钟');
  return config;
}

// Each candle uses its latest observed close, including the developing candle.
// Oracle windows and missing candle buckets break the rolling window.
export function bollingerBands(points,config,now=Infinity){
  if(!config?.enabled)return [];
  const {period,deviations,intervalSeconds}=config,interval=intervalSeconds*1000;
  const candles=new Map();
  for(const point of points){
    if(!Number.isFinite(point.time)||point.time>now||!Number.isFinite(point.price)||point.price<=0||!Number.isFinite(point.oracleWindow))continue;
    const bucket=Math.floor(point.time/interval)*interval,old=candles.get(bucket);
    if(!old||point.time>=old.time)candles.set(bucket,{...point,bucket});
  }
  const result=[],window=[];
  let previous=null;
  for(const candle of [...candles.values()].sort((a,b)=>a.bucket-b.bucket)){
    if(previous&&(candle.bucket!==previous.bucket+interval||candle.oracleWindow!==previous.oracleWindow))window.length=0;
    window.push(candle.price);if(window.length>period)window.shift();
    if(window.length===period){
      const middle=window.reduce((sum,p)=>sum+p,0)/period;
      const deviation=Math.sqrt(window.reduce((sum,p)=>sum+(p-middle)**2,0)/period);
      result.push({time:candle.time,bucket:candle.bucket,middle,upper:middle+deviations*deviation,
        lower:middle-deviations*deviation,segment:result.length===0||previous==null||result.at(-1).bucket!==candle.bucket-interval});
    }
    previous=candle;
  }
  return result;
}

// A candle's last observation is timestamped near its end. Preserve the last
// known band at the viewport boundary instead of blanking the first candle.
export function visibleBollingerBands(bands,{xmin,visibleThrough,intervalSeconds}){
  const visible=bands.filter(point=>point.time>=xmin&&point.time<=visibleThrough);
  if(visible[0]?.time===xmin)return visible;
  const previous=bands.findLast(point=>point.time<xmin);
  if(previous&&previous.time>=xmin-intervalSeconds*1000&&visibleThrough>=xmin&&!visible[0]?.segment)
    return [{...previous,time:xmin,segment:true},...visible];
  return visible;
}
