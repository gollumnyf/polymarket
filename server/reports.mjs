import {DAY_MS,dateKey,reportDates,REPORT_TIMEZONE} from '../src/report-dates.mjs';

const fields=['orderCount','filledCount','pendingCount','rejectedCount','spent','feesPaid','settledCount','wins','losses','voidCount','income','settledCost','settledFees','netPnl','missingFeeCount','missingPnlCount'];
const empty=()=>Object.fromEntries(fields.map(key=>[key,0]));
const monetary=new Set(['spent','feesPaid','income','settledCost','settledFees','netPnl']);
const rounded=value=>Math.round((value+Number.EPSILON)*1e6)/1e6;
const dateSql=column=>`strftime('%Y-%m-%d',${column}/1000.0,'unixepoch','+8 hours')`;

// Aggregate in SQLite. No order history, account-reset deposits or predictions
// are loaded into the response. Each money flow uses its own event timestamp.
export function paperReport(store,{startDate,endDate,now=Date.now()}={}){
  const period=reportDates(startDate,endDate,now);
  const filled="status IN ('open','won','lost','void') AND cost IS NOT NULL";
  const entries=store.db.prepare(`SELECT ${dateSql('created_at')} AS day,
    COUNT(*) AS orderCount,
    SUM(CASE WHEN ${filled} THEN 1 ELSE 0 END) AS filledCount,
    SUM(CASE WHEN status IN ('placing','confirming','uncertain','open') THEN 1 ELSE 0 END) AS pendingCount,
    SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejectedCount,
    SUM(CASE WHEN ${filled} THEN cost ELSE 0 END) AS spent,
    SUM(CASE WHEN ${filled} THEN COALESCE(fee,0) ELSE 0 END) AS feesPaid,
    SUM(CASE WHEN ${filled} AND fee IS NULL THEN 1 ELSE 0 END) AS missingFeeCount
    FROM orders WHERE mode='paper' AND created_at>=? AND created_at<? GROUP BY day`).all(period.start,period.end);
  const settlements=store.db.prepare(`SELECT ${dateSql('settled_at')} AS day,
    COUNT(*) AS settledCount,
    SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) AS losses,
    SUM(CASE WHEN status='void' THEN 1 ELSE 0 END) AS voidCount,
    SUM(COALESCE(payout,0)) AS income,SUM(COALESCE(cost,0)) AS settledCost,
    SUM(COALESCE(fee,0)) AS settledFees,
    SUM(COALESCE(pnl,payout-cost,0)) AS netPnl,
    SUM(CASE WHEN pnl IS NULL AND (payout IS NULL OR cost IS NULL) THEN 1 ELSE 0 END) AS missingPnlCount
    FROM orders WHERE mode='paper' AND status IN ('won','lost','void') AND settled_at>=? AND settled_at<? GROUP BY day`).all(period.start,period.end);
  const days=Array.from({length:period.count},(_,i)=>({date:dateKey(period.start+i*DAY_MS),...empty()}));
  const byDate=new Map(days.map(day=>[day.date,day]));
  for(const row of [...entries,...settlements]){
    const day=byDate.get(row.day);for(const key of fields)if(row[key]!=null)day[key]+=row[key];
  }
  const summary=empty();
  for(const day of days){
    for(const key of fields){if(monetary.has(key))day[key]=rounded(day[key]);summary[key]+=day[key];}
    day.netCashFlow=rounded(day.income-day.spent);day.grossPnl=rounded(day.netPnl+day.settledFees);
  }
  for(const key of monetary)summary[key]=rounded(summary[key]);
  summary.netCashFlow=rounded(summary.income-summary.spent);
  summary.grossPnl=rounded(summary.netPnl+summary.settledFees);
  summary.winRate=summary.wins+summary.losses?summary.wins/(summary.wins+summary.losses)*100:null;
  return {startDate:period.startDate,endDate:period.endDate,timezone:REPORT_TIMEZONE,generatedAt:now,summary,days};
}
