// Stable page IDs match existing routes. Rename titles without changing IDs.
export const PAGES=Object.freeze([
  {id:'previous',title:'上场方向模拟'},
  {id:'previous-live',title:'上场方向实盘'},
  {id:'loss-follow',title:'三连亏跟随模拟'},
  {id:'loss-follow-live',title:'三连亏跟随实盘'},
  {id:'streak-reverse',title:'三场同向反买模拟',streakRounds:3},
  {id:'streak-reverse-two',title:'两场同向反买模拟',streakRounds:2},
  {id:'market-history',title:'历史场次',group:'data'},
  {id:'reports',title:'模拟盘报表',group:'data'},
  {id:'reports-live',title:'实盘报表',group:'data'},
].map(page=>Object.freeze({...page,path:`/${page.id}`})));
export const PAGE_BY_ID=Object.freeze(Object.fromEntries(PAGES.map(page=>[page.id,page])));
