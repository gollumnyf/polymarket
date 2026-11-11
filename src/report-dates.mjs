export const DAY_MS=86400000;
export const REPORT_TIMEZONE='Asia/Shanghai';
export const dateKey=time=>new Date(time+8*3600000).toISOString().slice(0,10);
export function dateStart(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('日期格式应为 YYYY-MM-DD');
  const time=Date.parse(value+'T00:00:00+08:00');
  if(!Number.isFinite(time)||dateKey(time)!==value)throw Error('日期无效');
  return time;
}
export function recentDates(days=30,now=Date.now()){
  const endDate=dateKey(now);return {startDate:dateKey(dateStart(endDate)-(days-1)*DAY_MS),endDate};
}
export function reportDates(startDate,endDate,now=Date.now()){
  const defaults=recentDates(30,now);
  startDate=startDate??defaults.startDate;endDate=endDate??defaults.endDate;
  const start=dateStart(startDate),end=dateStart(endDate)+DAY_MS,count=(end-start)/DAY_MS;
  if(count<1)throw Error('开始日期不能晚于结束日期');
  if(count>366)throw Error('单次最多查询 366 天，请缩小日期范围');
  return {startDate,endDate,start,end,count};
}
