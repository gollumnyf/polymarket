export const RANGE_DEFAULTS=Object.freeze({lookbackHours:2,levelLookbackHours:4,levelLagMinutes:15,edgePercent:20,breakoutPercent:0.1,breakoutRounds:2});
export const RANGE_BUCKET_MS=5000;
// Body candles need endpoints, not continuous intermediate RTDS samples.
export const LEVEL_CANDLE_MS=5*60000;
export const LEVEL_LOOKBACK_HOURS=4;
// The outer fifth of a confirmed range is treated as the boundary zone.  In
// that zone the mean-reversion signal is opposite to the price movement.
export const RANGE_EDGE_FRACTION=RANGE_DEFAULTS.edgePercent/100;

export function levelWindow(now,hours=LEVEL_LOOKBACK_HOURS,lagMinutes=RANGE_DEFAULTS.levelLagMinutes){
  const end=Math.floor(now/300000)*300000-lagMinutes*60000;
  return {start:end-hours*3600000,end};
}

function inspectBars(bars,start,end){
  const valid=[];let invalid=null,lastAt=null,maxGapMs=0,gapAt=null;
  for(let i=0;i<bars.length;i++){
    const bar=bars[i],wanted=bar.bucket;
    if(!Number.isFinite(wanted)||wanted<start||wanted>=end||wanted%RANGE_BUCKET_MS!==0||i>0&&wanted<=bars[i-1].bucket||
      ![bar.low,bar.high,bar.open,bar.close].every(p=>Number.isFinite(p)&&p>0)||
      bar.open<bar.low||bar.open>bar.high||bar.close<bar.low||bar.close>bar.high||
      ![bar.firstAt,bar.lastAt,bar.maxGapMs].every(Number.isFinite)||bar.maxGapMs<0||
      bar.low>bar.high||bar.firstAt<wanted||bar.lastAt>=wanted+RANGE_BUCKET_MS||bar.firstAt>bar.lastAt){invalid??=bar;continue;}
    const gap=Math.max(bar.maxGapMs,bar.firstAt-wanted,wanted+RANGE_BUCKET_MS-bar.lastAt,bar.firstAt-(lastAt??start));
    if(gap>maxGapMs){maxGapMs=gap;gapAt=wanted;}
    lastAt=bar.lastAt;valid.push(bar);
  }
  const tailGap=end-(lastAt??start);
  if(tailGap>maxGapMs){maxGapMs=tailGap;gapAt=lastAt??start;}
  return {valid,invalid,maxGapMs,gapAt};
}


// Rebuild rolling five-minute body candles at every completed round.
// The open round never changes its own historical boundaries.
export function analyzeLevels(bars,config,now,officialRounds=[]){
  const lagMinutes=config.levelLagMinutes??RANGE_DEFAULTS.levelLagMinutes;
  const {start,end}=levelWindow(now,config.levelLookbackHours,lagMinutes),history=inspectBars(bars.filter(bar=>bar.bucket>=start&&bar.bucket<end),start,end),candles=[];
  for(let bucket=start;bucket<end;bucket+=LEVEL_CANDLE_MS){
    const parts=history.valid.filter(bar=>bar.bucket>=bucket&&bar.bucket<bucket+LEVEL_CANDLE_MS);
    const official=officialRounds.find(item=>item.round*1000===bucket&&[item.open,item.close].every(value=>Number.isFinite(value)&&value>0));
    if(!parts.length&&!official)continue;
    const quality=inspectBars(parts,bucket,bucket+LEVEL_CANDLE_MS);
    const open=official?.open??parts[0].open,close=official?.close??parts.at(-1).close;
    const complete=!!official||parts[0].firstAt<bucket+RANGE_BUCKET_MS&&parts.at(-1).lastAt>=bucket+LEVEL_CANDLE_MS-RANGE_BUCKET_MS;
    candles.push({bucket,open,high:Math.max(open,close),low:Math.min(open,close),close,
      firstAt:parts[0]?.firstAt??null,lastAt:parts.at(-1)?.lastAt??null,maxGapMs:quality.maxGapMs,complete,source:official?'polymarket_crypto_price':'polymarket_rtds_endpoints',received:parts.length});
  }
  const bodyHighs=[...new Set(candles.map(bar=>bar.high))].sort((a,b)=>b-a),bodyLows=[...new Set(candles.map(bar=>bar.low))].sort((a,b)=>a-b);
  const upper=bodyHighs[0]??null,lower=bodyLows[0]??null;
  const result={start,end,lagMinutes,nextUpdateAt:Math.floor(now/300000)*300000+300000,timeframeMinutes:5,lookbackHours:config.levelLookbackHours,expected:config.levelLookbackHours*12,received:candles.length,validCandles:candles.filter(bar=>bar.complete).length,
    peak:bodyHighs[0]??null,secondaryPeak:bodyHighs[1]??null,valley:bodyLows[0]??null,secondaryValley:bodyLows[1]??null,
    maxGapMs:history.maxGapMs,officialCandles:candles.filter(bar=>bar.source==='polymarket_crypto_price').length,candles,lower,upper,actualLower:lower,actualUpper:upper,
    widthPercent:lower>0?(upper-lower)/((upper+lower)/2)*100:null,supportSource:'rolling_extremes',resistanceSource:'rolling_extremes',ready:false};
  // Invalid raw samples cannot override valid authoritative endpoint prices.
  if(result.validCandles!==result.expected)return {...result,code:'RANGE_LEVEL_HISTORY_INCOMPLETE',message:`向前平移 ${lagMinutes} 分钟的 ${config.levelLookbackHours} 小时窗口，有效 5 分钟 K 线 ${result.validCandles}/${result.expected} 根，缺少 ${result.expected-result.validCandles} 场起止价；正在立即从 Polymarket 接口补齐`};
  return {...result,ready:true,code:null,message:'历史上下界已就绪，每场结束重算；仅按当前价格是否越界判断区间状态'};
}

export function validateRangeConfig(input={}){
  for(const key of Object.keys(input))if(!Object.hasOwn(RANGE_DEFAULTS,key))throw Error(`不支持的区间参数：${key}`);
  const config={...RANGE_DEFAULTS,...input};
  if(!Number.isFinite(config.edgePercent)||config.edgePercent<0||config.edgePercent>=50)throw Error('每侧边界比例必须大于等于 0 且小于 50%');
  if(!Number.isInteger(config.lookbackHours)||config.lookbackHours<1||config.lookbackHours>24)throw Error('方向统计小时数必须是 1 到 24 的整数');
  if(!Number.isInteger(config.levelLookbackHours)||config.levelLookbackHours<1||config.levelLookbackHours>24)throw Error('历史区间小时数必须是 1 到 24 的整数');
  if(!Number.isInteger(config.levelLagMinutes)||config.levelLagMinutes<0||config.levelLagMinutes>1440||config.levelLagMinutes%5!==0)throw Error('区间计算滞后分钟数必须为 0 到 1440 之间的 5 分钟整数倍');
  if(!Number.isFinite(config.breakoutPercent)||config.breakoutPercent<0||config.breakoutPercent>100)throw Error('突破距离比例必须为 0 到 100 之间的数字');
  if(!Number.isInteger(config.breakoutRounds)||config.breakoutRounds<1||config.breakoutRounds>48)throw Error('突破确认场数必须为 1 到 48 的整数');
  return config;
}

export function classifyRange(candidate,price){
  if(!candidate.levelAnalysis.ready)return candidate;
  const inside=Number.isFinite(price)&&price>=candidate.lower&&price<=candidate.upper;
  const direction=Number.isFinite(price)?price>candidate.upper?'UP':price<candidate.lower?'DOWN':null:null;
  const width=candidate.upper-candidate.lower,edgeFraction=(candidate.edgePercent??RANGE_DEFAULTS.edgePercent)/100;
  const edgeHint=inside&&width>0
    ? price>=candidate.upper-width*edgeFraction?'DOWN'
      : price<=candidate.lower+width*edgeFraction?'UP':null
    : null;
  return {...candidate,stable:inside,breakoutDirection:direction,edgeHint,code:null,blockingReasons:[],message:inside?
    `当前价格 ${price.toFixed(2)} 位于历史区间 ${candidate.lower.toFixed(2)}–${candidate.upper.toFixed(2)} 内${edgeHint?`，靠近${edgeHint==='DOWN'?'上压力':'下支撑'}，暂停下单`:''}`:
    direction?`当前价格 ${price.toFixed(2)} ${direction==='UP'?'上穿历史最高价':'跌破历史最低价'} ${(direction==='UP'?candidate.upper:candidate.lower).toFixed(2)}，越界期间暂停下单`:'等待当前有效官方报价'};
}

// Use the same frozen reference as breakout confirmation until that regime ends.
export function rangeBoundary(state,price){
  const edgePercent=state.edgePercent??RANGE_DEFAULTS.edgePercent,edgeFraction=edgePercent/100,middlePercent=Number((100-2*edgePercent).toFixed(6));
  const lower=state.breakoutReferenceLower??state.lower,upper=state.breakoutReferenceUpper??state.upper,width=upper-lower;
  if(!Number.isFinite(price)||!Number.isFinite(lower)||!Number.isFinite(upper)||width<=0)
    return {paused:true,code:'RANGE_BOUNDARY_INVALID',message:'区间上下界未形成有效宽度，暂无中间区域，等待区间更新'};
  const middleLower=lower+width*edgeFraction,middleUpper=upper-width*edgeFraction;
  const side=price<=middleLower?'lower':price>=middleUpper?'upper':null;
  const position=price<lower?'已跌破下支撑位':price>upper?'已上穿上压力位':side==='lower'?`已进入下侧 ${edgePercent}% 边界区域`:`已进入上侧 ${edgePercent}% 边界区域`;
  return {paused:!!side,side,edgePercent,middlePercent,lower,upper,middleLower,middleUpper,code:side?'RANGE_BOUNDARY_WAIT':null,
    message:side?`${position}，暂停新单：当前价 ${price.toFixed(2)} ${side==='lower'?'≤':'≥'} ${side==='lower'?middleLower.toFixed(2):middleUpper.toFixed(2)}；参考支撑 ${lower.toFixed(2)} / 压力 ${upper.toFixed(2)}。等待价格 > ${middleLower.toFixed(2)} 且 < ${middleUpper.toFixed(2)}，回到中间 ${middlePercent}% 后买 ${side==='lower'?'UP':'DOWN'}，并沿用原资金序列；已有订单继续结算`:null};
}

export function stableRange(bars,config,now,levelHistory=bars,price=null,officialRounds=[]){
  const levels=analyzeLevels(levelHistory,config,now,officialRounds);
  const base={edgePercent:config.edgePercent??RANGE_DEFAULTS.edgePercent,breakoutPercent:config.breakoutPercent??0.1,breakoutRounds:config.breakoutRounds??2,start:levels.start,end:levels.end,expected:config.levelLookbackHours*12,received:levels.candles.reduce((n,bar)=>n+bar.received,0),
    levelAnalysis:levels,lower:levels.lower,upper:levels.upper,actualLower:levels.lower,actualUpper:levels.upper,widthPercent:levels.widthPercent,
    maxGapMs:levels.maxGapMs,supportSource:'rolling_extremes',resistanceSource:'rolling_extremes',stable:false,breakoutReady:levels.ready,
    code:levels.code,message:levels.message,blockingReasons:levels.ready?[]:[{code:levels.code,message:levels.message}]};
  return classifyRange(base,price);
}

// Only the consecutive streak ending at the latest completed round can confirm.
export function rangeRegime(previous,candidate,vote,spot,configId,now){
  if(!candidate.levelAnalysis.ready)return null;
  const prior=previous&&previous.configId===configId&&previous.oracleWindow===spot.windowSeconds&&previous.supportSource==='rolling_extremes'?previous:null;
  const round=Math.floor(now/300000)*300,percent=candidate.breakoutPercent??0.1,required=candidate.breakoutRounds??2;
  let state={...prior,edgePercent:candidate.edgePercent??RANGE_DEFAULTS.edgePercent,configId,oracleWindow:spot.windowSeconds,levelTimeframeMinutes:candidate.levelAnalysis.timeframeMinutes,levelLookbackHours:candidate.levelAnalysis.lookbackHours,levelLagMinutes:candidate.levelAnalysis.lagMinutes??0,levelWindowStart:candidate.levelAnalysis.start,levelWindowEnd:candidate.levelAnalysis.end,
    lower:candidate.lower,upper:candidate.upper,actualLower:candidate.lower,actualUpper:candidate.upper,widthPercent:candidate.widthPercent,
    supportSource:'rolling_extremes',resistanceSource:'rolling_extremes',supportTouches:0,resistanceTouches:0,roundTrips:0,
    phase:prior?.phase??'range',formedAt:prior?.formedAt??now,changedAt:prior?.changedAt??now,windowStart:candidate.start,windowEnd:candidate.end,
    upCount:prior?.upCount??vote.up,downCount:prior?.downCount??vote.down,expectedCount:vote.expected};
  const clearConfirmation=()=>{Object.assign(state,{breakoutReferenceLower:null,breakoutReferenceUpper:null,breakoutPendingDirection:null,breakoutStartRound:null,breakoutLastRound:null,breakoutCount:0,breakoutLastClose:null,breakoutLastSource:null,breakoutConfirmedAt:null});};
  const resetRange=()=>{Object.assign(state,{phase:'range',direction:null,rangeBaseDirection:null,rangeBaseDirectionRule:null,lockedDirectionRule:null,lockedPreviousRound:null,lockedPreviousDirection:null,lockedPreviousSource:null,directionSelectedAt:null,breakoutSince:null,tradeFromRound:null,formedAt:now,formedFrom:'price_in_range'});clearConfirmation();};
  const outside=(price,lower,upper)=>price>upper?'UP':price<lower?'DOWN':null;
  const beyond=(price,lower,upper,direction)=>direction==='UP'?price>upper+(upper-lower)*percent/100:price<lower-(upper-lower)*percent/100;
  // Old immediate-breakout states cannot bypass the new confirmation requirement.
  if(state.phase!=='range'&&!state.breakoutConfirmedAt)resetRange();
  if(state.breakoutConfirmedAt){
    if(outside(spot.price,state.breakoutReferenceLower,state.breakoutReferenceUpper)===state.breakoutPendingDirection){
      state.direction=state.breakoutPendingDirection;
      return finish();
    }
    resetRange();
  }
  if(state.breakoutPendingDirection){
    Object.assign(state,{breakoutCount:0,breakoutLastRound:null,breakoutLastClose:null,breakoutLastSource:null});
    for(let closed=state.breakoutStartRound;closed<round;closed+=300){
      const evidence=candidate.completedRounds?.find(item=>item.round===closed);
      if(evidence?.invalid||!evidence||!Number.isFinite(evidence.close)||evidence.close<=0||
        !beyond(evidence.close,state.breakoutReferenceLower,state.breakoutReferenceUpper,state.breakoutPendingDirection)){
        Object.assign(state,{breakoutCount:0,breakoutLastRound:null,breakoutLastClose:null,breakoutLastSource:null});
        continue;
      }
      Object.assign(state,{breakoutLastRound:closed,breakoutCount:(state.breakoutCount??0)+1,breakoutLastClose:evidence.close,breakoutLastSource:evidence.source});
    }
    if(state.breakoutCount>=required){
        if(beyond(spot.price,state.breakoutReferenceLower,state.breakoutReferenceUpper,state.breakoutPendingDirection)){
          Object.assign(state,{phase:state.breakoutPendingDirection==='UP'?'breakout_up':'breakout_down',direction:state.breakoutPendingDirection,lockedDirectionRule:'breakout',breakoutSince:now,breakoutConfirmedAt:now,directionSelectedAt:now,tradeFromRound:round,formedFrom:'confirmed_breakout'});
          return finish();
        }
        clearConfirmation();
    }
    else if(state.breakoutStartRound<round&&state.breakoutCount===0)clearConfirmation();
  }
  if(!state.breakoutPendingDirection){
    const direction=outside(spot.price,candidate.lower,candidate.upper);
    if(direction&&beyond(spot.price,candidate.lower,candidate.upper,direction))Object.assign(state,{breakoutPendingDirection:direction,breakoutReferenceLower:candidate.lower,breakoutReferenceUpper:candidate.upper,breakoutStartRound:round,breakoutLastRound:null,breakoutCount:0,breakoutLastClose:null,breakoutLastSource:null,breakoutConfirmedAt:null});
  }
  if(!state.rangeBaseDirection&&vote.complete){
    const tied=vote.up===vote.down,selected=tied?(['UP','DOWN'].includes(vote.previousDirection)?(vote.previousDirection==='UP'?'DOWN':'UP'):null):vote.direction;
    if(selected)Object.assign(state,{rangeBaseDirection:selected,rangeBaseDirectionRule:tied?'tie_reverse_previous':'range_majority',lockedPreviousRound:tied?vote.previousRound:null,lockedPreviousDirection:tied?vote.previousDirection:null,lockedPreviousSource:tied?vote.previousSource:null,upCount:vote.up,downCount:vote.down});
  }
  const lower=state.breakoutReferenceLower??candidate.lower,upper=state.breakoutReferenceUpper??candidate.upper,width=upper-lower,edgeFraction=state.edgePercent/100;
  const edge=spot.price>upper||(width>0&&spot.price>=upper-width*edgeFraction)?'DOWN':spot.price<lower||(width>0&&spot.price<=lower+width*edgeFraction)?'UP':null;
  state.phase='range';state.direction=edge??state.rangeBaseDirection??null;
  state.lockedDirectionRule=edge?'range_edge_reversion':state.rangeBaseDirectionRule??null;
  if(state.direction!==prior?.direction)state.directionSelectedAt=now;
  return finish();
  function finish(){
    const boundary=rangeBoundary(state,spot.price);
    if(boundary.side){
      // Remember the latest side, including a jump across the entire middle.
      if(state.boundaryPauseSide!==boundary.side)state.boundaryPausedAt=now;
      state.boundaryPauseSide=boundary.side;
    }else if(!boundary.paused&&state.boundaryPauseSide){
      const side=state.boundaryPauseSide,direction=side==='lower'?'UP':'DOWN';
      Object.assign(state,{boundaryPauseSide:null,boundaryResumeSide:side,boundaryResumedAt:now,
        boundaryResumePrice:spot.price,boundaryResumeThreshold:side==='lower'?boundary.middleLower:boundary.middleUpper,
        direction,rangeBaseDirection:direction,rangeBaseDirectionRule:'boundary_return',lockedDirectionRule:'boundary_return',
        lockedPreviousRound:null,lockedPreviousDirection:null,lockedPreviousSource:null,directionSelectedAt:now});
    }
    if(!prior||Object.keys(state).some(key=>!['id','changedAt'].includes(key)&&state[key]!==prior[key]))state.changedAt=now;
    return state;
  }
}
