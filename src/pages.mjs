// Stable page IDs match existing routes. Rename titles without changing IDs.
export const PAGES=Object.freeze([
  {id:'previous',title:'上场方向模拟'},
  {id:'previous-live',title:'上场方向实盘'},
  {id:'loss-follow',title:'三连亏跟随模拟'},
  {id:'loss-follow-live',title:'三连亏跟随实盘'},
  {id:'reports',title:'模拟盘报表'},
  {id:'reports-live',title:'实盘报表'},
].map(page=>Object.freeze({...page,path:`/${page.id}`})));
export const PAGE_BY_ID=Object.freeze(Object.fromEntries(PAGES.map(page=>[page.id,page])));
