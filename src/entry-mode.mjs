export const ENTRY_MODES = Object.freeze([
  {value:'independent',label:'不跟随上一场方向',description:'到达设定的开盘延迟后，按本场起始价与当前价判断方向，上涨买 UP，下跌买 DOWN，持平则等待。'},
  {value:'same_direction',label:'与上一场同向买入',description:'到达设定的开盘延迟后，仅在本场入场方向与上一场预计方向一致时买入；不一致则在入场窗口内继续等待。'},
  {value:'follow_previous',label:'跟随上一场方向',description:'到达设定的开盘延迟后，直接买入上一场预计 UP/DOWN，不判断本场方向是否一致。'},
  {value:'reverse',label:'反向买入',description:'到达设定的开盘延迟后，将本场入场信号取反：UP 买 DOWN，DOWN 买 UP；持平则等待，不跟随上一场方向。'},
]);

export function entryMode(config) {
  return config?.reverseSignal?'reverse':config?.followPreviousAtOpen?'follow_previous':config?.sameDirectionOnly?'same_direction':'independent';
}

export function entryModeLabel(config) {
  return ENTRY_MODES.find(mode=>mode.value===entryMode(config)).label;
}

export function withEntryMode(config,mode) {
  if(!ENTRY_MODES.some(item=>item.value===mode))throw new Error('无效的入场方向规则');
  return {...config,followPreviousAtOpen:mode==='follow_previous',sameDirectionOnly:mode==='same_direction',reverseSignal:mode==='reverse'};
}

export const oppositeDirection=direction=>direction==='UP'?'DOWN':direction==='DOWN'?'UP':null;
