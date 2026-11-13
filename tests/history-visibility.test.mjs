import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {createApp} from '../server/index.mjs';
import {paperReport} from '../server/reports.mjs';

function order(store,id,round=1800000000,mode='paper'){
  const row={id,mode,round,session:store.account(mode).session,status:'open',direction:'UP',end:round+300,createdAt:round*1000,cost:2,fee:0.1,shares:4,budget:2,doubling:0};
  assert.equal(store.reserveOrder(row),true);return store.order(id);
}

test('hiding existing orders preserves settlement, reservations, reports and newly arriving orders',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const old=order(store,'old');order(store,'live',1800000000,'live');
  const account=store.account('paper'),revision=store.historyVersion('paper').orders;
  assert.equal(store.setHistoryHidden('paper','orders',true),1);
  assert.notEqual(store.historyVersion('paper').orders,revision);
  assert.equal(store.historyPage('paper','orders').total,0);
  assert.equal(store.historyPage('paper','orders').hiddenCount,1);
  assert.equal(store.historyPage('live','orders').total,1);
  assert.equal(store.pending('paper').length,1);
  assert.equal(store.reserveOrder({...old,id:'duplicate'}),false);
  // A settlement prepared before the hide request must not undo the flag.
  store.saveOrder({...old,status:'won',settledAt:(old.end+10)*1000,payout:4,pnl:2});
  assert.equal(store.order('old').isHide,true);
  order(store,'new',1800000300);
  assert.deepEqual(store.historyPage('paper','orders').items.map(o=>o.id),['new']);
  assert.equal(store.orders('paper',-1).length,2);
  const report=paperReport(store,{now:1800000400000});
  assert.equal(report.summary.orderCount,2);assert.equal(report.summary.netPnl,2);
  assert.deepEqual(store.account('paper'),account);
  assert.equal(store.setHistoryHidden('paper','orders',false),1);
  assert.equal(store.historyPage('paper','orders').total,2);
});

test('logs hide independently by mode including shared system messages and retain full exports',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  store.log('paper','info','paper old');store.log('live','info','live old');store.log('system','info','system old');
  assert.equal(store.setHistoryHidden('paper','logs',true),2);
  assert.equal(store.historyPage('paper','logs').total,0);
  assert.equal(store.historyPage('live','logs').total,2);
  store.log('system','info','system new');store.log('paper','info','paper new');
  assert.deepEqual(store.historyPage('paper','logs').items.map(o=>o.message),['paper new','system new']);
  assert.equal(store.logs('paper',-1).filter(o=>o.is_hide).length,2);
  assert.equal(store.logs('live',-1).filter(o=>o.is_hide).length,0);
  assert.equal(store.setHistoryHidden('paper','logs',false),2);
  assert.equal(store.historyPage('paper','logs').total,4);
});

test('v8 migration keeps records visible by default and hidden flags survive reopening',t=>{
  const dir=mkdtempSync(join(tmpdir(),'pulse-hide-')),path=join(dir,'store.sqlite');
  let store=new Store(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  order(store,'old');store.log('paper','info','old log');
  store.db.exec('DROP INDEX orders_visible; DROP INDEX logs_visible; ALTER TABLE orders DROP COLUMN is_hide; ALTER TABLE logs DROP COLUMN is_hide; DROP TABLE system_log_visibility; DELETE FROM schema_migrations WHERE version>=9;');
  store.close();store=new Store(path);
  assert.equal(store.historyPage('paper','orders').total,1);
  assert.equal(store.historyPage('paper','logs').total,1);
  store.setHistoryHidden('paper','orders',true);store.setHistoryHidden('paper','logs',true);
  store.close();store=new Store(path);
  assert.equal(store.historyPage('paper','orders').hiddenCount,1);
  assert.equal(store.historyPage('paper','logs').hiddenCount,1);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('visibility API validates access and body, hides all pages and exports hidden rows',async t=>{
  const store=new Store(':memory:');const engine=new Engine(store,{readiness:()=>({enabled:false})});
  for(let i=0;i<23;i++)order(store,'order-'+i,1800000000+i*300);
  const server=createApp(engine).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const base='http://127.0.0.1:'+server.address().port,state=await(await fetch(base+'/api/state')).json();
  const post=(body,token=state.controlToken)=>fetch(base+'/api/paper/orders/visibility',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Control-Token':token},body:JSON.stringify(body)});
  assert.equal((await post({hidden:true},'')).status,403);
  assert.equal((await post({hidden:'true'})).status,400);
  assert.equal((await(await post({hidden:true})).json()).changed,23);
  order(store,'new',1800006900);
  const page=await(await fetch(base+'/api/paper/orders')).json();
  assert.equal(page.total,1);assert.equal(page.hiddenCount,23);assert.equal(page.items[0].id,'new');
  const csv=await(await fetch(base+'/api/paper/export')).text();assert(csv.includes('order-0'));assert(csv.includes('isHide'));
  assert.equal((await(await post({hidden:false})).json()).changed,23);
  assert.equal((await(await fetch(base+'/api/paper/orders')).json()).total,24);
});
