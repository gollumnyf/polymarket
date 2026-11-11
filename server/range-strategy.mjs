export const RANGE_DEFAULTS=Object.freeze({lookbackHours:2});
export const RANGE_BUCKET_MS=5000;
// Polymarket market history can leave a whole five-minute round without
// granular RTDS samples. Keep the range usable across that bounded gap, while
// still rejecting longer outages.
export const RANGE_MAX_GAP_MS=600000;
export const LEVEL_CANDLE_MS=15*60000;
export const LEVEL_LOOKBACK_HOURS=4;
// The outer fifth of a confirmed range is treated as the boundary zone.  In
// that zone the mean-reversion signal is opposite to the price movement.
export const RANGE_EDGE_FRACTION=0.2;

export function levelWindow(now){
  const end=Math.floor(now/300000)*300000;
  return {start:end-LEVEL_LOOKBACK_HOURS*3600000,end};
}

function inspectBars(bars,start,end){
  const valid=[];let invalid=null,lastAt=null,maxGapMs=0,gapAt=null,gapCount=0;
  for(let i=0;i<bars.length;i++){
    const bar=bars[i],wanted=bar.bucket;
    if(!Number.isFinite(wanted)||wanted<start||wanted>=end||wanted%RANGE_BUCKET_MS!==0||i>0&&wanted<=bars[i-1].bucket||
      ![bar.low,bar.high,bar.open,bar.close].every(p=>Number.isFinite(p)&&p>0)||
      bar.open<bar.low||bar.open>bar.high||bar.close<bar.low||bar.close>bar.high||
      ![bar.firstAt,bar.lastAt,bar.maxGapMs].every(Number.isFinite)||bar.maxGapMs<0||
      bar.low>bar.high||bar.firstAt<wanted||bar.lastAt>=wanted+RANGE_BUCKET_MS||bar.firstAt>bar.lastAt){invalid??=bar;continue;}
    const gap=Math.max(bar.maxGapMs,bar.firstAt-wanted,wanted+RANGE_BUCKET_MS-bar.lastAt,bar.firstAt-(lastAt??start));
    if(gap>maxGapMs){maxGapMs=gap;gapAt=wanted;}
    if(gap>RANGE_MAX_GAP_MS)gapCount++;
    lastAt=bar.lastAt;valid.push(bar);
  }
  const tailGap=end-(lastAt??start);
  if(tailGap>maxGapMs){maxGapMs=tailGap;gapAt=lastAt??start;}
  if(tailGap>RANGE_MAX_GAP_MS)gapCount++;
  return {valid,invalid,maxGapMs,gapAt,gapCount};
}


// Rebuild sixteen rolling 15-minute candles at every completed five-minute round.
// The open round never changes its own historical boundaries.
export function analyzeLevels(bars,config,now){
  const {start,end}=levelWindow(now),history=inspectBars(bars.filter(bar=>bar.bucket>=start&&bar.bucket<end),start,end),candles=[];
  for(let bucket=start;bucket<end;bucket+=LEVEL_CANDLE_MS){
    const parts=history.valid.filter(bar=>bar.bucket>=bucket&&bar.bucket<bucket+LEVEL_CANDLE_MS);
    if(!parts.length)continue;
    const quality=inspectBars(parts,bucket,bucket+LEVEL_CANDLE_MS);
    candles.push({bucket,open:parts[0].open,high:Math.max(...parts.map(bar=>bar.high)),low:Math.min(...parts.map(bar=>bar.low)),close:parts.at(-1).close,
      firstAt:parts[0].firstAt,lastAt:parts.at(-1).lastAt,maxGapMs:quality.maxGapMs,complete:quality.maxGapMs<=RANGE_MAX_GAP_MS,received:parts.length});
  }
  const lower=candles.length?Math.min(...candles.map(bar=>bar.low)):null,upper=candles.length?Math.max(...candles.map(bar=>bar.high)):null;
  const result={start,end,timeframeMinutes:15,lookbackHours:4,expected:16,received:candles.length,validCandles:candles.filter(bar=>bar.complete).length,
    maxGapMs:history.maxGapMs,gapLimitMs:RANGE_MAX_GAP_MS,candles,lower,upper,actualLower:lower,actualUpper:upper,
    widthPercent:lower>0?(upper-lower)/((upper+lower)/2)*100:null,supportSource:'rolling_extremes',resistanceSource:'rolling_extremes',ready:false};
  if(history.invalid)return {...result,code:'RANGE_LEVEL_HISTORY_INVALID',message:`历史报价无效：${String(history.invalid.bucket)}`};
  if(history.maxGapMs>RANGE_MAX_GAP_MS||result.validCandles!==16)return {...result,code:'RANGE_LEVEL_HISTORY_INCOMPLETE',message:`近 4 小时有效 15 分钟 K 线 ${result.validCandles}/16 根，最长报价缺失 ${history.maxGapMs/1000} 秒，允许最多 600 秒；继续获取 Polymarket 历史数据`};
  return {...result,ready:true,code:null,message:'历史上下界已就绪，每场结束重算；仅按当前价格是否越界判断区间状态'};
}

export function validateRangeConfig(input={}){
  for(const key of Object.keys(input))if(key!=='lookbackHours')throw Error(`不支持的区间参数：${key}`);
  const config={...RANGE_DEFAULTS,...input};
  if(!Number.isInteger(config.lookbackHours)||config.lookbackHours<1||config.lookbackHours>24)throw Error('方向统计小时数必须是 1 到 24 的整数');
  return config;
}

export function classifyRange(candidate,price){
  if(!candidate.levelAnalysis.ready)return candidate;
  const inside=Number.isFinite(price)&&price>=candidate.lower&&price<=candidate.upper;
  const direction=Number.isFinite(price)?price>candidate.upper?'UP':price<candidate.lower?'DOWN':null:null;
  const width=candidate.upper-candidate.lower;
  const edgeHint=inside&&width>0
    ? price>=candidate.upper-width*RANGE_EDGE_FRACTION?'DOWN'
      : price<=candidate.lower+width*RANGE_EDGE_FRACTION?'UP':null
    : null;
  return {...candidate,stable:inside,breakoutDirection:direction,edgeHint,code:null,blockingReasons:[],message:inside?
    `当前价格 ${price.toFixed(2)} 位于历史区间 ${candidate.lower.toFixed(2)}–${candidate.upper.toFixed(2)} 内${edgeHint?`，靠近${edgeHint==='DOWN'?'上压力':'下支撑'}，倾向买${edgeHint}`:''}`:
    direction?`当前价格 ${price.toFixed(2)} ${direction==='UP'?'上穿历史最高价':'跌破历史最低价'} ${(direction==='UP'?candidate.upper:candidate.lower).toFixed(2)}，方向 ${direction}`:'等待当前有效官方报价'};
}

export function stableRange(bars,config,now,levelHistory=bars,price=null){
  const levels=analyzeLevels(levelHistory,config,now);
  const base={start:levels.start,end:levels.end,expected:2880,received:levels.candles.reduce((n,bar)=>n+bar.received,0),
    levelAnalysis:levels,lower:levels.lower,upper:levels.upper,actualLower:levels.lower,actualUpper:levels.upper,widthPercent:levels.widthPercent,
    maxGapMs:levels.maxGapMs,gapLimitMs:RANGE_MAX_GAP_MS,supportSource:'rolling_extremes',resistanceSource:'rolling_extremes',stable:false,breakoutReady:levels.ready,
    code:levels.code,message:levels.message,blockingReasons:levels.ready?[]:[{code:levels.code,message:levels.message}]};
  return classifyRange(base,price);
}

export function rangeRegime(previous,candidate,vote,spot,configId,now){
  if(!candidate.levelAnalysis.ready)return null;
  const prior=previous&&previous.configId===configId&&previous.oracleWindow===spot.windowSeconds&&previous.supportSource==='rolling_extremes'?previous:null;
  const direction=spot.price>candidate.upper?'UP':spot.price<candidate.lower?'DOWN':null,phase=direction==='UP'?'breakout_up':direction==='DOWN'?'breakout_down':'range';
  const changedWindow=!prior||prior.levelWindowEnd!==candidate.levelAnalysis.end;
  let state={...prior,configId,oracleWindow:spot.windowSeconds,levelTimeframeMinutes:15,levelLookbackHours:4,levelWindowStart:candidate.levelAnalysis.start,levelWindowEnd:candidate.levelAnalysis.end,
    lower:candidate.lower,upper:candidate.upper,actualLower:candidate.lower,actualUpper:candidate.upper,widthPercent:candidate.widthPercent,
    supportSource:'rolling_extremes',resistanceSource:'rolling_extremes',supportTouches:0,resistanceTouches:0,roundTrips:0,
    phase,formedAt:prior?.formedAt??now,changedAt:changedWindow?now:prior.changedAt,windowStart:candidate.start,windowEnd:candidate.end,
    upCount:prior?.upCount??vote.up,downCount:prior?.downCount??vote.down,expectedCount:vote.expected};
  if(direction){
    if(prior?.phase===phase)return state;
    return {...state,id:null,direction,rangeBaseDirection:null,rangeBaseDirectionRule:null,lockedDirectionRule:'breakout',lockedPreviousRound:null,lockedPreviousDirection:null,lockedPreviousSource:null,
      directionSelectedAt:now,breakoutSince:now,changedAt:now,tradeFromRound:Math.floor(now/300000)*300+300,formedFrom:'historical_breakout'};
  }
  if(prior?.phase!=='range')state={...state,id:null,formedAt:now,changedAt:now,direction:null,lockedDirectionRule:null,lockedPreviousRound:null,lockedPreviousDirection:null,lockedPreviousSource:null,
    rangeBaseDirection:null,rangeBaseDirectionRule:null,directionSelectedAt:null,breakoutSince:null,tradeFromRound:prior?.tradeFromRound??null,formedFrom:'price_in_range'};
  if(!state.direction&&vote.complete){
    const tied=vote.up===vote.down,selected=tied?(['UP','DOWN'].includes(vote.previousDirection)?(vote.previousDirection==='UP'?'DOWN':'UP'):null):vote.direction;
    if(selected)state={...state,id:null,direction:selected,rangeBaseDirection:selected,rangeBaseDirectionRule:tied?'tie_reverse_previous':'range_majority',lockedDirectionRule:tied?'tie_reverse_previous':'range_majority',
      lockedPreviousRound:tied?vote.previousRound:null,lockedPreviousDirection:tied?vote.previousDirection:null,lockedPreviousSource:tied?vote.previousSource:null,
      directionSelectedAt:now,changedAt:now,upCount:vote.up,downCount:vote.down};
  }
  // Once the range has a selected direction, move to mean reversion while
  // price hugs an edge.  The middle keeps the existing locked/vote direction.
  if(state.phase==='range' && state.rangeBaseDirection){
    if(candidate.edgeHint)state={...state,direction:candidate.edgeHint,lockedDirectionRule:'range_edge_reversion',changedAt:now,
      directionSelectedAt:state.direction===candidate.edgeHint?state.directionSelectedAt:now};
    else state={...state,direction:state.rangeBaseDirection,lockedDirectionRule:state.rangeBaseDirectionRule||'range_majority'};
  }
  return state;
}
