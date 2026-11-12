import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { DEFAULT_CONFIG } from '../server/strategy.mjs';
import { RoundHistory } from '../server/history.mjs';
import { orderTime, settlementPlaceholder } from '../src/order-time.mjs';

function fixture(t, extraOrder = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-schema-'));
  const cleanup = () => rmSync(dir, { recursive:true, force:true });
  const path = join(dir, 'trading.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE accounts(mode TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE orders(id TEXT PRIMARY KEY,mode TEXT,round INTEGER,session TEXT,status TEXT,body TEXT,UNIQUE(mode,round));
    CREATE INDEX orders_pending ON orders(status);
    CREATE TABLE ticks(time INTEGER PRIMARY KEY,price REAL,source TEXT);
    CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER,mode TEXT,level TEXT,message TEXT);
    CREATE TABLE round_signals(round INTEGER PRIMARY KEY,body TEXT);`);
  const account = { mode:'paper', session:'old-session', config:{...DEFAULT_CONFIG,baseAmount:8},
    running:true, reason:null, balance:976, startingBalance:1000,
    pnl:-24, cyclePnl:-24, losses:2, wins:0, settled:2, cycle:1, createdAt:1000 };
  const order = { id:'old-order',mode:'paper',round:1800000000,session:account.session,status:'lost',
    end:1800000300, direction:'DOWN',budget:16, cost:16, shares:30, fee:1, notional:15, price:.5,
    feeSchedule:{rate:.07,exponent:1},feeEstimated:true, tradeIds:['a','b'],
    createdAt:1800000005000,settledAt:1800000312000,payout:0,pnl:-16,...extraOrder };
  const signal = { round:order.round,observedAt:order.createdAt,direction:'DOWN',price:99,
    referencePrice:100,rule:'current_round_open',source:'polymarket',targetSeconds:5,oracleWindow:60 };
  db.prepare('INSERT INTO accounts VALUES (?,?)').run(account.mode,JSON.stringify(account));
  db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)').run(order.id,order.mode,order.round,order.session,order.status,JSON.stringify(order));
  db.prepare('INSERT INTO round_signals VALUES (?,?)').run(signal.round,JSON.stringify(signal));
  db.exec("INSERT INTO ticks VALUES (1000,74000,'polymarket'); INSERT INTO logs VALUES (1,1000,'paper','info','legacy log');");
  db.close(); return {path,account,order,signal,cleanup};
}

test('JSON migration preserves trading fields, timestamps, signal, IDs and logs in typed columns with a recoverable backup', t => {
  const {path,account,order,signal,cleanup} = fixture(t);
  let store = new Store(path);
  t.after(() => { store.close(); cleanup(); });
  const backup = store.backupPath;
  assert.ok(existsSync(backup));
  const saved = store.account('paper');
  assert.equal(saved.running,false); assert.equal(saved.losses,account.losses);
  assert.equal(saved.balance,account.balance); assert.deepEqual(saved.config,account.config);
  assert.equal(saved.startingBalance,1000);
  for (const [key,value] of Object.entries(order)) assert.deepEqual(store.order(order.id)[key],value,key);
  assert.equal(store.order(order.id).configId,null);
  assert.deepEqual(store.initialSignal(signal.round),signal);
  assert.equal(store.logs('paper')[0].message,'legacy log');
  assert.equal(store.db.prepare('SELECT price FROM ticks WHERE time=1000').get().price,74000);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const {name} of tables) {
    assert.ok(!name.startsWith('legacy_'));
    assert.ok(!store.db.prepare(`PRAGMA table_info(${name})`).all().some(c => c.name === 'body'));
  }
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  store.close(); store = new Store(path);
  assert.equal(store.backupPath,undefined);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM strategy_configs WHERE mode=\'paper\'').get().n,1);
  assert.equal(store.reserveOrder({...order,id:'duplicate'}),false);
  const original = new DatabaseSync(backup,{readOnly:true});
  assert.equal(JSON.parse(original.prepare('SELECT body FROM accounts').get().body).balance,account.balance);
  original.close();
});

test('an unmapped legacy field rolls back all migration DDL and preserves the original database', t => {
  const {path,cleanup} = fixture(t,{unexpectedField:'must not be discarded'});
  assert.throws(() => new Store(path),/迁移已回滚.*unexpectedField/);
  const db = new DatabaseSync(path); t.after(() => { db.close(); cleanup(); });
  assert.ok(db.prepare('PRAGMA table_info(accounts)').all().some(c => c.name === 'body'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'legacy_%'").get().n,0);
  assert.equal(JSON.parse(db.prepare('SELECT body FROM orders').get().body).unexpectedField,'must not be discarded');
});

test('v1 signal rows migrate to per-entry-time keys with backup, restart persistence and unchanged trading history', t => {
  const {path,cleanup}=fixture(t);
  let store=new Store(path); store.close();
  const db=new DatabaseSync(path);
  db.exec(`ALTER TABLE round_signals RENAME TO signals_v2;
    CREATE TABLE round_signals(round INTEGER PRIMARY KEY,target_seconds INTEGER,observed_at INTEGER,
      direction TEXT,price REAL,reference_price REAL,source TEXT,rule TEXT,oracle_window INTEGER);
    INSERT INTO round_signals SELECT * FROM signals_v2;
    DROP TABLE signals_v2;
    UPDATE round_signals SET target_seconds=NULL;
    DELETE FROM schema_migrations;
    INSERT INTO schema_migrations VALUES (1,1000);`);
  db.close();
  store=new Store(path); t.after(()=>{store.close();cleanup();});
  assert.ok(store.backupPath.includes('.pre-v2-')); assert.ok(existsSync(store.backupPath));
  assert.equal(store.initialSignal(1800000000,5).direction,'DOWN');
  assert.equal(store.order('old-order').pnl,-16); assert.equal(store.account('paper').losses,2);
  store.saveInitialSignal({round:1800000000,targetSeconds:10,observedAt:1800000010000,
    direction:'UP',price:101,referencePrice:100,rule:'current_round_open',source:'polymarket'});
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM round_signals').get().n,2);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  store.close(); store=new Store(path);
  assert.equal(store.backupPath,undefined);
  assert.equal(store.initialSignal(1800000000,5).direction,'DOWN');
  assert.equal(store.initialSignal(1800000000,10).direction,'UP');
  assert.equal(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,8);
});

test('v2 upgrades preserve orders and predictions survive restart without settling the balance',t=>{
  const {path,cleanup}=fixture(t);
  let store=new Store(path);store.close();
  const old=new DatabaseSync(path);
  old.exec('DROP TABLE order_predictions; DELETE FROM schema_migrations; INSERT INTO schema_migrations VALUES (2,1000);');old.close();
  store=new Store(path);t.after(()=>{store.close();cleanup();});
  assert.ok(store.backupPath.includes('.pre-v3-'));assert.ok(existsSync(store.backupPath));
  const before=store.account('paper').balance;
  store.savePrediction({orderId:'old-order',open:100,close:101,outcome:'UP',won:false,
    source:'polymarket_event_metadata',observedAt:1800000310000});
  store.savePrediction({orderId:'old-order',open:100,close:99,outcome:'DOWN',won:true,
    source:'polymarket_event_metadata',observedAt:1800000320000});
  assert.equal(store.order('old-order').prediction.won,false);
  store.close();store=new Store(path);
  assert.equal(store.order('old-order').prediction.open,100);assert.equal(store.order('old-order').prediction.close,101);
  assert.equal(store.account('paper').balance,before);assert.equal(store.order('old-order').pnl,-16);
  store.verifyPrediction('old-order',true,1800000330000);
  assert.equal(store.order('old-order').prediction.matches,true);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('v3 upgrades default same-direction filtering off without changing config IDs, then preserve separate mode settings and round forecasts',t=>{
  const {path,cleanup}=fixture(t);
  let store=new Store(path);const originalId=store.account('paper').configId;store.close();
  const old=new DatabaseSync(path);
  old.exec(`DROP TABLE round_predictions; ALTER TABLE strategy_configs DROP COLUMN same_direction_only;
    DELETE FROM schema_migrations; INSERT INTO schema_migrations VALUES (3,1000);`);old.close();
  store=new Store(path);t.after(()=>{store.close();cleanup();});
  assert.ok(store.backupPath.includes('.pre-v4-'));assert.ok(existsSync(store.backupPath));
  assert.equal(store.account('paper').config.sameDirectionOnly,false);
  assert.equal(store.account('paper').configId,originalId);
  store.saveAccount({...store.account('paper'),config:{...store.account('paper').config,sameDirectionOnly:true}});
  store.saveRoundPrediction({round:1800000000,conditionId:'market',open:100,close:101,outcome:'UP',
    source:'polymarket_event_metadata',oracleWindow:60,observedAt:1800000310000});
  store.close();store=new Store(path);
  assert.equal(store.account('paper').config.sameDirectionOnly,true);
  assert.equal(store.account('live').config.sameDirectionOnly,false);
  assert.equal(store.roundPrediction(1800000000).outcome,'UP');
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('v4 upgrade preserves reservations after clearing terminal records and restarting without changing account state',t=>{
  const {path,cleanup}=fixture(t);
  let store=new Store(path);store.close();
  const old=new DatabaseSync(path);
  old.exec('DROP TABLE order_rounds; DROP TABLE log_clear_positions; DELETE FROM schema_migrations; INSERT INTO schema_migrations VALUES (4,1000);');old.close();
  store=new Store(path);t.after(()=>{store.close();cleanup();});
  assert.ok(store.backupPath.includes('.pre-v5-'));assert.ok(existsSync(store.backupPath));
  const account=store.account('paper');
  assert.equal(store.hasRound('paper',1800000000),true);
  assert.equal(store.clearPaperOrders(),1);assert.equal(store.orderCount('paper'),0);
  assert.deepEqual(store.account('paper'),account);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM order_trade_ids').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM order_events').get().n,0);
  store.log('system','warning','shared log');store.log('live','info','live log');store.log('paper','info','paper log');
  store.clearPaperLogs();assert.equal(store.logs('paper').length,0);assert.equal(store.logs('live').length,2);
  store.close();store=new Store(path);
  assert.equal(store.hasRound('paper',1800000000),true);
  assert.equal(store.reserveOrder({id:'retry',mode:'paper',round:1800000000,session:account.session,status:'placing'}),false);
  assert.equal(store.logs('paper').length,0);
  store.log('system','warning','new shared log');assert.equal(store.logs('paper').length,1);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('v5 migration keeps account data, defaults follow-at-open off and persists window-tagged last-second evidence',t=>{
  const {path,cleanup}=fixture(t);
  let store=new Store(path);store.close();
  const old=new DatabaseSync(path);
  old.exec(`DROP TABLE round_openings;
    ALTER TABLE strategy_configs DROP COLUMN follow_previous_at_open;
    ALTER TABLE ticks DROP COLUMN oracle_window;
    ALTER TABLE order_predictions DROP COLUMN price_at;
    ALTER TABLE round_predictions DROP COLUMN price_at;
    DELETE FROM schema_migrations; INSERT INTO schema_migrations VALUES (5,1000);
    INSERT INTO ticks(source,time,price) VALUES ('polymarket',1800000299000,99);`);old.close();
  store=new Store(path);t.after(()=>{store.close();cleanup();});
  assert.ok(store.backupPath.includes('.pre-v6-'));assert.ok(existsSync(store.backupPath));
  assert.equal(store.account('paper').config.followPreviousAtOpen,false);
  assert.equal(store.account('paper').balance,976);assert.equal(store.account('paper').pnl,-24);
  assert.equal(store.lastSecondTick(1800000000,60).price,99);
  assert.equal(store.lastSecondTick(1800000000,30),null);
  store.saveAccount({...store.account('paper'),config:{...store.account('paper').config,followPreviousAtOpen:true}});
  store.saveRoundOpening({round:1800000000,conditionId:'c',open:100,oracleWindow:60,observedAt:1800000005000});
  store.saveRoundPrediction({round:1800000000,conditionId:'c',open:100,close:99,outcome:'DOWN',
    oracleWindow:60,source:'polymarket_last_second',priceAt:1800000299000,observedAt:1800000300000});
  store.close();store=new Store(path);
  assert.equal(store.account('paper').config.followPreviousAtOpen,true);
  assert.equal(store.roundOpening(1800000000).open,100);assert.equal(store.roundPrediction(1800000000).priceAt,1800000299000);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('v6 migration preserves account, orders, config IDs and settings while reverse mode defaults off and persists independently',t=>{
  const {path,cleanup}=fixture(t);let store=new Store(path);
  const before=store.account('paper'),order=store.order('old-order');store.close();
  const old=new DatabaseSync(path);old.exec('ALTER TABLE strategy_configs DROP COLUMN reverse_signal; DELETE FROM schema_migrations; INSERT INTO schema_migrations VALUES (6,1000);');old.close();
  store=new Store(path);t.after(()=>{store.close();cleanup();});
  assert.ok(store.backupPath.includes('.pre-v7-'));assert.ok(existsSync(store.backupPath));
  assert.deepEqual(store.account('paper'),before);assert.deepEqual(store.order('old-order'),order);
  assert.equal(store.account('paper').config.reverseSignal,false);assert.equal(store.account('live').config.reverseSignal,false);
  store.saveAccount({...store.account('paper'),config:{...store.account('paper').config,reverseSignal:true}});
  store.close();store=new Store(path);assert.equal(store.account('paper').config.reverseSignal,true);
  assert.equal(store.account('live').config.reverseSignal,false);assert.equal(store.account('paper').balance,before.balance);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('v7 migration preserves business rows and archives typed rejection evidence and book levels across restart',t=>{
  const {path,cleanup}=fixture(t);let store=new Store(path);
  store.saveEntryBlock('paper',{round:1800000000,message:'价格上限或滑点范围内深度不足',at:1800000010000});
  const account=store.account('paper'),order=store.order('old-order');store.close();
  const old=new DatabaseSync(path);old.exec('DROP TABLE entry_diagnostic_levels; DROP TABLE entry_diagnostics; DELETE FROM schema_migrations; INSERT INTO schema_migrations VALUES (7,1000)');old.close();
  store=new Store(path);t.after(()=>{store.close();cleanup();});
  assert.ok(store.backupPath.includes('.pre-v8-'));assert.ok(existsSync(store.backupPath));
  assert.deepEqual(store.account('paper'),account);assert.deepEqual(store.order('old-order'),order);
  assert.equal(store.entryBlock('paper',1800000000).evidenceAvailable,false);assert.match(store.entryBlock('paper',1800000000).message,/无法还原确切原因/);
  const block=store.saveEntryDiagnostic({mode:'paper',round:1800000000,code:'MAX_PRICE_BELOW_BEST_ASK',message:'卖一 0.60 > 上限 0.55',at:1800000011000,
    configId:account.configId,direction:'UP',budget:20,bestAsk:.6,maxPrice:.55,priceLimit:.55,remainingBudget:20,elapsed:11},
    {asks:[{price:'.6',size:'10'},{price:'.61',size:'20'}],bids:[{price:'.58',size:'30'}]});
  store.saveEntryBlock('paper',block);store.close();store=new Store(path);
  const saved=store.entryBlock('paper',1800000000,{withBook:true});
  assert.equal(saved.code,'MAX_PRICE_BELOW_BEST_ASK');assert.equal(saved.bestAsk,.6);assert.equal(saved.remainingBudget,20);assert.equal(saved.direction,'UP');
  assert.deepEqual(saved.book,{asks:[{price:.6,size:10},{price:.61,size:20}],bids:[{price:.58,size:30}]});
  assert.equal(store.entryBlocks().paper.code,saved.code);assert.equal(store.entryBlock('live',1800000000),null);
  assert.equal(store.account('paper').balance,account.balance);assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('configuration revisions and prior sessions survive edits and resets; atomic failure rolls all child writes back', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const account = store.account('paper'), originalConfig = account.configId;
  store.saveAccount({...account,pnl:-10,balance:990,losses:1,config:{...account.config,baseAmount:8}});
  const edited = store.account('paper');
  assert.notEqual(edited.configId,originalConfig);
  store.reserveOrder({id:'order',mode:'paper',round:1800000000,session:edited.session,status:'open',createdAt:1000},
    {fetchedAt:900,tickSize:'.01',minOrderSize:'5',asks:[{price:'.5',size:'20'}],bids:[{price:'.49',size:'8'}]});
  assert.equal(store.order('order').configId,edited.configId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM order_book_levels').get().n,2);
  assert.throws(() => store.transaction(() => {
    store.saveOrder({...store.order('order'),status:'won',pnl:5,tradeIds:['trade']});
    store.saveAccount({...edited,balance:1005,config:{...edited.config,baseAmount:12}});
    throw Error('simulate interruption');
  }),/interruption/);
  assert.equal(store.order('order').status,'open'); assert.deepEqual(store.order('order').tradeIds,[]);
  assert.equal(store.account('paper').balance,990);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM strategy_configs WHERE mode=\'paper\'').get().n,2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM order_events').get().n,1);
  store.saveAccount(store.freshAccount('paper',edited.config));
  const archived = store.db.prepare('SELECT * FROM account_sessions WHERE id=?').get(account.session);
  assert.equal(archived.pnl,-10); assert.equal(archived.losses,1); assert.ok(archived.closed_at);
  assert.equal(store.order('order').session,account.session);
});

test('oracle samples and logs remain archived beyond display limits and sources can share the same timestamp', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.tick(1000,10,'polymarket'); store.tick(1000,20,'binance'); store.tick(Date.now(),30);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ticks').get().n,3);
  assert.equal(store.ticks().length,1); assert.equal(store.ticks(0).length,2);
  store.transaction(() => { for (let i=0;i<2010;i++) store.log('paper','info',String(i)); });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM logs').get().n,2010);
  assert.equal(store.logs('paper').length,70);
});

test('saved history and entry blocks survive restart and remain available when the remote API fails', async t => {
  const {path,cleanup} = fixture(t);
  let store = new Store(path);
  t.after(() => { store.close(); cleanup(); });
  const now = 1800000010000;
  for(let i=1;i<=20;i++) {
    const round=1800000000-i*300;
    store.saveHistoricalRound({round,end:round+300,slug:`btc-updown-5m-${round}`,status:'resolved',
      result:'UP',open:100,close:101,change:1,changePercent:1},now);
  }
  store.saveEntryBlock('paper',{round:1800000000,message:'low depth',at:now});
  store.close(); store=new Store(path);
  const venue = {fetch:async () => {throw Error('offline');}};
  const history = new RoundHistory(venue,{store,now:() => now});
  assert.equal((await history.read()).items.filter(i => i.result==='UP').length,20);
  assert.equal(store.entryBlocks().paper.message,'low depth');
  const next = new RoundHistory(venue,{store,now:() => now+300000});
  const read = await next.read();
  assert.equal(read.items.filter(i => i.result==='UP').length,20); assert.match(read.error,/offline/);
  const round=1800000000-300;
  store.saveHistoricalRound({round,end:round+300,slug:`btc-updown-5m-${round}`,status:'unavailable',result:null,open:null,close:null});
  assert.equal(store.historicalRound(round).result,'UP');
});

test('order times include seconds and unresolved, rejected and legacy terminal orders have truthful placeholders', () => {
  const value = orderTime(1800000005000);
  assert.equal(value.time.split(':').length,3); assert.ok(value.date); assert.ok(value.iso.endsWith('Z'));
  assert.equal(orderTime(null),null); assert.equal(orderTime(NaN),null);
  assert.equal(settlementPlaceholder({status:'open'}),'待结算');
  assert.equal(settlementPlaceholder({status:'rejected'}),'未成交');
  assert.equal(settlementPlaceholder({status:'won'}),'未记录');
});
