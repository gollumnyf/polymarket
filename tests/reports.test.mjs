import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Store} from '../server/store.mjs';
import {paperReport} from '../server/reports.mjs';
import {createApp} from '../server/index.mjs';
import {DAY_MS,dateStart,recentDates,reportDates} from '../src/report-dates.mjs';

const at=value=>Date.parse(value+'+08:00');
function fixture(t){const store=new Store(':memory:');t.after(()=>store.close());let sequence=0;
  return {store,order:(fields={})=>{const index=sequence++,mode=fields.mode??'paper';return store.reserveOrder({id:'report-'+index,mode,session:store.account(mode).session,round:1800000000+index*300,status:'open',createdAt:at('2026-11-01T12:00:00'),cost:10,fee:0.2,shares:20,...fields});}};
}

test('default report covers exactly 30 Shanghai dates, and validates calendar ranges',()=>{
  const now=Date.parse('2026-11-10T16:01:00Z');assert.deepEqual(recentDates(30,now),{startDate:'2026-10-13',endDate:'2026-11-11'});
  assert.equal(reportDates(undefined,undefined,now).count,30);
  assert.equal(reportDates('2024-02-29','2024-02-29').end-reportDates('2024-02-29','2024-02-29').start,DAY_MS);
  for(const dates of [['2026-02-29','2026-03-01'],['2026-11-02','2026-11-01'],['bad','2026-11-01'],[['2026-11-01'],'2026-11-02'],['2025-01-01','2026-11-01']])assert.throws(()=>reportDates(...dates));
});

test('daily reports separate entry cash flows, settlement PnL and fees without double deduction',t=>{
  const {store,order}=fixture(t);
  order({status:'won',createdAt:at('2026-10-31T23:59:59'),settledAt:at('2026-11-01T00:00:00'),cost:10,fee:0.4,payout:18,pnl:8,session:'previous-account-session'});
  order({status:'lost',createdAt:at('2026-11-01T23:59:59'),settledAt:at('2026-11-02T00:00:00'),cost:20,fee:0.5,payout:0,pnl:-20});
  order({status:'open',cost:5,fee:0.2});
  order({status:'rejected',cost:50,fee:5});
  order({status:'void',createdAt:at('2026-11-02T13:00:00'),settledAt:at('2026-11-02T13:06:00'),cost:8,fee:0.2,payout:4,pnl:-4});
  order({mode:'live',status:'won',settledAt:at('2026-11-01T13:00:00'),payout:100,pnl:90});
  order({createdAt:at('2026-11-03T00:00:00')});
  const report=paperReport(store,{startDate:'2026-11-01',endDate:'2026-11-02'}),summary=report.summary;
  assert.equal(report.days.length,2);assert.equal(report.days[0].netPnl,8);assert.equal(report.days[0].spent,25);assert.equal(report.days[1].netPnl,-24);
  assert.equal(summary.netPnl,-16);assert.equal(summary.settledFees,1.1);assert.equal(summary.grossPnl,-14.9);
  assert.equal(summary.spent,33);assert.equal(summary.feesPaid,0.9);assert.equal(summary.income,22);assert.equal(summary.netCashFlow,-11);
  assert.equal(summary.orderCount,4);assert.equal(summary.filledCount,3);assert.equal(summary.pendingCount,1);assert.equal(summary.rejectedCount,1);
  assert.equal(summary.settledCount,3);assert.equal(summary.winRate,50);assert.equal(summary.voidCount,1);
  for(const key of ['netPnl','settledFees','orderCount','income','spent'])assert.ok(Math.abs(report.days.reduce((sum,day)=>sum+day[key],0)-summary[key])<1e-8);
});

test('empty days are included and forecasts never become realized income',t=>{
  const {store,order}=fixture(t);order();
  store.savePrediction({orderId:'report-0',open:100,close:101,outcome:'UP',won:true,source:'polymarket_last_second',observedAt:at('2026-11-01T12:06:00')});
  const result=paperReport(store,{startDate:'2026-11-01',endDate:'2026-11-03'});
  assert.equal(result.days.length,3);assert.equal(result.summary.netPnl,0);assert.equal(result.summary.income,0);assert.equal(result.summary.spent,10);
  assert.equal(result.days[2].orderCount,0);assert.equal(result.summary.winRate,null);
});

test('live reports isolate real orders per strategy while paper reports reject malformed ranges',async t=>{
  const stores=Array.from({length:4},()=>new Store(':memory:'));const engines=stores.map(store=>Object.assign(new EventEmitter(),{store,venue:{}}));
  stores.forEach((store,i)=>store.reserveOrder({id:'r'+i,mode:'paper',session:store.account('paper').session,round:1800000000,status:'won',createdAt:dateStart('2026-11-01'),settledAt:dateStart('2026-11-01')+1000,cost:10,fee:i,payout:20+i,pnl:10+i}));
  for(const i of [0,1])stores[i].reserveOrder({id:'live'+i,mode:'live',session:stores[i].account('live').session,round:1800000000,status:'won',createdAt:dateStart('2026-11-01'),settledAt:dateStart('2026-11-01')+1000,cost:50,fee:1,payout:70+i,pnl:20+i});
  const app=createApp(engines[0],{rangeEngine:engines[2],previousEngine:engines[0],previousLiveEngine:engines[1],lossFollowEngine:engines[3],allowedModes:['live']});const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));stores.forEach(store=>store.close());});
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/range/api/paper/report?startDate=2026-11-01&endDate=2026-11-01');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const result=await response.json();assert.equal(result.summary.netPnl,12);assert.equal(result.days.length,1);assert.equal(result.timezone,'Asia/Shanghai');
  for(const query of ['startDate=invalid','startDate=2026-11-02&endDate=2026-11-01','startDate=2026-11-01&startDate=2026-11-02'])assert.equal((await fetch(base+'/range/api/paper/report?'+query)).status,400);
  assert.equal((await fetch(base+'/api/paper/report')).status,400);
  assert.equal((await fetch(base+'/momentum/api/paper/report')).status,404);
  for(const [path,pnl] of [['/api/live/report',20],['/previous-live/api/live/report',21]]){
    const r=await fetch(base+path+'?startDate=2026-11-01&endDate=2026-11-01');assert.equal(r.status,200);
    const report=await r.json();assert.equal(report.summary.orderCount,1);assert.equal(report.summary.netPnl,pnl);
  }
  assert.equal((await fetch(base+'/previous-live/api/paper/report')).status,400);
  for(const [path,pnl] of [['/previous/api/paper/report',10],['/loss-follow/api/paper/report',13]]){
    const r=await fetch(base+path+'?startDate=2026-11-01&endDate=2026-11-01');assert.equal(r.status,200);
    const report=await r.json();assert.equal(report.summary.orderCount,1);assert.equal(report.summary.netPnl,pnl);
    assert.equal(report.timezone,'Asia/Shanghai');assert.equal(report.days.length,1);
  }
  assert.equal((await fetch(base+'/loss-follow/api/live/report')).status,400);
  assert.equal((await fetch(base+'/momentum/api/state')).status,404);
  assert.equal((await fetch(base+'/momentum/api/paper/orders')).status,404);
});

test('a missing archived simulator database returns an empty report',()=>{
  const result=paperReport(null,{startDate:'2026-11-01',endDate:'2026-11-02'});
  assert.equal(result.days.length,2);assert.equal(result.summary.orderCount,0);assert.equal(result.summary.netPnl,0);
});
