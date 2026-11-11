import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG } from './strategy.mjs';
import { EARLY_SIGNAL_TOLERANCE } from './round-signals.mjs';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const CONFIG = { baseAmount:'base_amount', initialBalance:'initial_balance', maxAmount:'max_amount',
  maxDoublings:'max_doublings', stopLoss:'stop_loss', entryDelay:'entry_delay',
  entryWindow:'entry_window', slippage:'slippage', maxPrice:'max_price', sameDirectionOnly:'same_direction_only',followPreviousAtOpen:'follow_previous_at_open',reverseSignal:'reverse_signal' };
const SESSION = { balance:'balance', startingBalance:'starting_balance', pnl:'pnl', cyclePnl:'cycle_pnl',
  losses:'losses', wins:'wins', settled:'settled', cycle:'cycle', createdAt:'created_at' };
const ORDER = { id:'id', mode:'mode', round:'round', session:'session', configId:'config_id', status:'status',
  end:'end', slug:'slug', conditionId:'condition_id', assetId:'asset_id', outcomeIndex:'outcome_index',
  direction:'direction', budget:'budget', doubling:'doubling', createdAt:'created_at', settledAt:'settled_at',
  referencePrice:'reference_price', signalPrice:'signal_price', signalRule:'signal_rule', priceSource:'price_source',
  oracleWindow:'oracle_window', shares:'shares', notional:'notional', fee:'fee', cost:'cost',
  price:'price', priceLimit:'price_limit', payout:'payout', pnl:'pnl', venueOrderId:'venue_order_id', note:'note' };
const SIGNAL = { round:'round', targetSeconds:'target_seconds', observedAt:'observed_at', direction:'direction',
  price:'price', referencePrice:'reference_price', source:'source', rule:'rule', oracleWindow:'oracle_window' };
const HISTORY = { round:'round', end:'end', slug:'slug', status:'status', result:'result', open:'open',
  close:'close', change:'change', changePercent:'change_percent', updatedAt:'updated_at' };
const PREDICTION = {orderId:'order_id',open:'open_price',close:'close_price',outcome:'outcome',
  won:'won',source:'source',observedAt:'observed_at',priceAt:'price_at',verifiedAt:'verified_at',matches:'matches'};
const ROUND_PREDICTION = {round:'round',conditionId:'condition_id',open:'open_price',close:'close_price',
  outcome:'outcome',source:'source',oracleWindow:'oracle_window',observedAt:'observed_at',priceAt:'price_at'};
const OPENING={round:'round',conditionId:'condition_id',open:'open_price',oracleWindow:'oracle_window',observedAt:'observed_at'};
const DIAGNOSTIC={id:'id',mode:'mode',round:'round',code:'code',message:'message',at:'at',configId:'config_id',direction:'direction',budget:'budget',
  elapsed:'elapsed_seconds',entryDelay:'entry_delay',entryWindow:'entry_window',referencePrice:'reference_price',signalPrice:'signal_price',spotRound:'spot_round',spotAt:'spot_at',
  marketRound:'market_round',marketAt:'market_at',marketActive:'market_active',bookAt:'book_at',oracleWindow:'oracle_window',availableBalance:'available_balance',
  maxPrice:'max_price',slippage:'slippage',tickSize:'tick_size',bestAsk:'best_ask',slippageLimit:'slippage_limit',rawPriceLimit:'raw_price_limit',priceLimit:'price_limit',limitSource:'limit_source',
  eligibleShares:'eligible_shares',availableBudget:'available_budget',remainingBudget:'remaining_budget',nextAsk:'next_ask',minimumShares:'minimum_shares',estimatedShares:'estimated_shares',
  requiredBudget:'required_budget',feeRate:'fee_rate',feeExponent:'fee_exponent',relatedRound:'related_round',dataAgeMs:'data_age_ms',maxAgeMs:'max_age_ms'};
const encode = (object, fields) => Object.fromEntries(Object.entries(fields).map(([key, column]) => [column, object[key] ?? null]));
const decode = (row, fields) => row && Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, row[column]]));

export class Store {
  constructor(path = 'data/trading.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.depth = 0;
    this.historyEpoch = randomUUID();
    this.historyVersions = { paper:{orders:0,logs:0}, live:{orders:0,logs:0} };
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      this.migrate(path);
      this.db.exec('CREATE INDEX IF NOT EXISTS orders_report_created ON orders(mode,created_at); CREATE INDEX IF NOT EXISTS orders_report_settled ON orders(mode,settled_at);');
      for (const mode of ['paper', 'live']) {
        const account = this.account(mode) || this.freshAccount(mode);
        this.saveAccount({ ...account, running: false, reason: '策略未启动' });
      }
      // A crashed live submission may already have reached the venue. Never resubmit.
      for (const order of this.pending()) {
        if (order.status === 'placing') this.saveOrder({ ...order,
          status: order.mode === 'paper' ? 'rejected' : 'uncertain',
          note: order.mode === 'paper' ? '模拟买入事务未完成，本场跳过' : '服务重启，需核对是否已成交；禁止重复提交' });
      }
    } catch (error) { this.db.close(); throw error; }
  }
  migrate(path) {
    const legacy = this.db.prepare('PRAGMA table_info(accounts)').all().some(c => c.name === 'body');
    const versionTable = this.db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get();
    const version = versionTable ? this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version : 0;
    if (version > 8) throw new Error('数据库版本高于当前程序，禁止降级打开');
    if (version === 8) return;
    if (version === 7) {
      if(path!==':memory:'){
        this.backupPath=`${path}.pre-v8-${Date.now()}.sqlite`;
        this.db.prepare('VACUUM INTO ?').run(this.backupPath);
      }
      this.transaction(()=>{
        this.db.exec(schema);
        this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (8,?)').run(Date.now());
      });return;
    }
    if (version === 6) {
      if(path!==':memory:'){
        this.backupPath=`${path}.pre-v7-${Date.now()}.sqlite`;
        this.db.prepare('VACUUM INTO ?').run(this.backupPath);
      }
      this.transaction(()=>{
        this.ensureConfigColumns();this.db.exec(schema);
        this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (8,?)').run(Date.now());
      });
      return;
    }
    if (version === 5) {
      if (path !== ':memory:') {
        this.backupPath = `${path}.pre-v6-${Date.now()}.sqlite`;
        this.db.prepare('VACUUM INTO ?').run(this.backupPath);
      }
      this.transaction(()=>{
        this.ensureConfigColumns();this.ensurePredictionColumns();this.db.exec(schema);
        this.backfillOracleWindows();this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (8,?)').run(Date.now());
      });
      return;
    }
    if (version === 4) {
      if (path !== ':memory:') {
        this.backupPath = `${path}.pre-v5-${Date.now()}.sqlite`;
        this.db.prepare('VACUUM INTO ?').run(this.backupPath);
      }
      this.transaction(() => {
        this.ensureConfigColumns();this.ensurePredictionColumns();this.db.exec(schema);this.backfillRoundReservations();
        this.backfillOracleWindows();this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (8,?)').run(Date.now());
      });
      return;
    }
    if (version === 3) {
      if (path !== ':memory:') {
        this.backupPath = `${path}.pre-v4-${Date.now()}.sqlite`;
        this.db.prepare('VACUUM INTO ?').run(this.backupPath);
      }
      this.transaction(() => {
        this.ensureConfigColumns();this.ensurePredictionColumns();this.db.exec(schema);this.backfillRoundReservations();
        this.backfillOracleWindows();this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (8,?)').run(Date.now());
      });
      return;
    }
    if (version === 2) {
      if (path !== ':memory:') {
        this.backupPath = `${path}.pre-v3-${Date.now()}.sqlite`;
        this.db.prepare('VACUUM INTO ?').run(this.backupPath);
      }
      this.transaction(() => {
        this.ensureConfigColumns();this.ensurePredictionColumns();this.db.exec(schema);this.backfillRoundReservations();
        this.backfillOracleWindows();this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (8,?)').run(Date.now());
      });
      return;
    }
    if (version === 1) {
      if (path !== ':memory:') {
        this.backupPath = `${path}.pre-v2-${Date.now()}.sqlite`;
        this.db.prepare('VACUUM INTO ?').run(this.backupPath);
      }
      this.transaction(() => {
        this.db.exec('ALTER TABLE round_signals RENAME TO round_signals_v1');
        this.ensureConfigColumns();this.ensurePredictionColumns();this.db.exec(schema);
        this.db.exec(`INSERT INTO round_signals(round,target_seconds,observed_at,direction,price,reference_price,source,rule,oracle_window)
          SELECT round,COALESCE(target_seconds,5),observed_at,direction,price,reference_price,source,rule,oracle_window FROM round_signals_v1;
          DROP TABLE round_signals_v1;`);
        this.backfillRoundReservations();
        this.backfillOracleWindows();this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (8,?)').run(Date.now());
      });
      return;
    }
    // VACUUM INTO includes committed WAL data and produces a standalone recovery copy.
    if (legacy && path !== ':memory:') {
      this.backupPath = `${path}.pre-v1-${Date.now()}.sqlite`;
      this.db.prepare('VACUUM INTO ?').run(this.backupPath);
    }
    this.transaction(() => {
      const legacyTables = [];
      if (legacy) for (const name of ['accounts', 'orders', 'round_signals', 'ticks']) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) {
          this.db.exec(`ALTER TABLE ${name} RENAME TO legacy_${name}`); legacyTables.push(name);
        }
      }
      this.db.exec(schema);
      if (legacy) {
        for (const row of this.db.prepare('SELECT body FROM legacy_accounts').all()) {
          const account = JSON.parse(row.body);
          this.checkLegacyKeys(account, ['mode','session','config','running','reason',...Object.keys(SESSION)], 'accounts');
          this.checkLegacyKeys(account.config, Object.keys(CONFIG), 'config');
          this.saveAccount({ ...account, config:{...DEFAULT_CONFIG,...account.config}, startingBalance: account.startingBalance ??
            (account.mode === 'paper' ? account.config.initialBalance : null) });
        }
        if (legacyTables.includes('orders')) for (const row of this.db.prepare('SELECT body FROM legacy_orders').all()) {
          const order = JSON.parse(row.body);
          this.checkLegacyKeys(order, [...Object.keys(ORDER),'feeSchedule','feeEstimated','tradeIds'], 'orders');
          // Old orders did not capture a config version. Do not invent one from today's settings.
          if (!this.reserveOrder({ ...order, configId: null })) throw new Error('迁移已回滚：历史订单场次或 ID 冲突');
        }
        if (legacyTables.includes('round_signals')) for (const row of this.db.prepare('SELECT body FROM legacy_round_signals').all()) {
          const signal = JSON.parse(row.body);
          this.checkLegacyKeys(signal, Object.keys(SIGNAL), 'round_signals'); this.saveInitialSignal(signal);
        }
        if (legacyTables.includes('ticks')) {
          const hasSource = this.db.prepare('PRAGMA table_info(legacy_ticks)').all().some(c => c.name === 'source');
          this.db.exec(`INSERT INTO ticks(source,time,price) SELECT ${hasSource ? 'source' : "'binance'"},time,price FROM legacy_ticks`);
        }
        for (const name of legacyTables.reverse()) this.db.exec(`DROP TABLE legacy_${name}`);
        this.db.exec(schema); // Recreate indexes whose names belonged to legacy tables.
      }
      this.backfillRoundReservations();
      this.backfillOracleWindows();this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (8,?)').run(Date.now());
    });
  }
  ensureConfigColumns() {
    const columns=this.db.prepare('PRAGMA table_info(strategy_configs)').all();
    if (columns.length && !columns.some(c=>c.name==='same_direction_only'))
      this.db.exec('ALTER TABLE strategy_configs ADD COLUMN same_direction_only INTEGER NOT NULL DEFAULT 0 CHECK(same_direction_only IN (0,1))');
    if (columns.length && !columns.some(c=>c.name==='follow_previous_at_open'))
      this.db.exec('ALTER TABLE strategy_configs ADD COLUMN follow_previous_at_open INTEGER NOT NULL DEFAULT 0 CHECK(follow_previous_at_open IN (0,1))');
    if (columns.length && !columns.some(c=>c.name==='reverse_signal'))
      this.db.exec('ALTER TABLE strategy_configs ADD COLUMN reverse_signal INTEGER NOT NULL DEFAULT 0 CHECK(reverse_signal IN (0,1))');
  }
  ensurePredictionColumns() {
    for(const [table,column]of [['ticks','oracle_window'],['order_predictions','price_at'],['round_predictions','price_at']]){
      const columns=this.db.prepare(`PRAGMA table_info(${table})`).all();
      if(columns.length&&!columns.some(c=>c.name===column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
    }
  }
  backfillOracleWindows(){
    this.db.exec(`WITH windows AS (SELECT round,MIN(oracle_window) AS seconds FROM round_signals
      WHERE oracle_window IS NOT NULL GROUP BY round HAVING MIN(oracle_window)=MAX(oracle_window))
      UPDATE ticks SET oracle_window=(SELECT seconds FROM windows WHERE round=(ticks.time/300000)*300)
      WHERE source='polymarket' AND oracle_window IS NULL AND EXISTS(SELECT 1 FROM windows WHERE round=(ticks.time/300000)*300)`);
  }
  backfillRoundReservations() {
    this.db.exec('INSERT OR IGNORE INTO order_rounds(mode,round,order_id,reserved_at) SELECT mode,round,id,created_at FROM orders');
  }
  checkLegacyKeys(object, keys, table) {
    const unknown = Object.keys(object).filter(key => !keys.includes(key));
    if (unknown.length) throw new Error(`迁移已回滚：${table} 包含尚未映射的字段 ${unknown.join(', ')}`);
  }
  write(table, row, conflict, update = true) {
    const columns = Object.keys(row);
    const tail = update ? `DO UPDATE SET ${columns.filter(c => !conflict.includes(c)).map(c => `${c}=excluded.${c}`).join(',')}` : 'DO NOTHING';
    return this.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
      ON CONFLICT(${conflict.join(',')}) ${tail}`).run(...Object.values(row));
  }
  freshAccount(mode, config = DEFAULT_CONFIG) {
    return { mode, session: randomUUID(), config: { ...config }, running: false,
      reason: '策略未启动', balance: mode === 'paper' ? config.initialBalance : 0,
      startingBalance: mode === 'paper' ? config.initialBalance : null,
      pnl: 0, cyclePnl: 0, losses: 0, wins: 0, settled: 0, cycle: 1, createdAt: Date.now() };
  }
  account(mode) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE mode=?').get(mode);
    if (!row) return null;
    const session = this.db.prepare('SELECT * FROM account_sessions WHERE id=?').get(row.session);
    const config = this.db.prepare('SELECT * FROM strategy_configs WHERE id=?').get(row.config_id);
    return { mode, session:row.session, configId:row.config_id, running:Boolean(row.running), reason:row.reason,
      config:{...decode(config, CONFIG),sameDirectionOnly:Boolean(config.same_direction_only),followPreviousAtOpen:Boolean(config.follow_previous_at_open),reverseSignal:Boolean(config.reverse_signal)}, ...decode(session, SESSION) };
  }
  saveAccount(account) {
    return this.transaction(() => {
      const previous = this.account(account.mode);
      let configId = previous?.configId;
      if (!previous || Object.keys(CONFIG).some(k => account.config[k] !== previous.config[k])) {
        const result = this.db.prepare(`INSERT INTO strategy_configs(mode,${Object.values(CONFIG).join(',')},created_at)
          VALUES (${Array(Object.keys(CONFIG).length+2).fill('?').join(',')})`).run(account.mode,
            ...Object.keys(CONFIG).map(k => typeof DEFAULT_CONFIG[k]==='boolean' ? Number(account.config[k] ?? false) : account.config[k]), Date.now());
        configId = Number(result.lastInsertRowid);
      }
      if (previous && previous.session !== account.session)
        this.db.prepare('UPDATE account_sessions SET closed_at=? WHERE id=?').run(Date.now(), previous.session);
      this.write('account_sessions', { id:account.session, mode:account.mode, ...encode(account, SESSION) }, ['id']);
      this.write('accounts', { mode:account.mode, session:account.session, config_id:configId,
        running:Number(account.running), reason:account.reason ?? null }, ['mode']);
      return { ...account, configId };
    });
  }
  readOrder(row) {
    if (!row) return null;
    return { ...decode(row, ORDER), prediction:this.prediction(row.id), feeSchedule:row.fee_rate == null && row.fee_exponent == null ? null
      : { rate:row.fee_rate, exponent:row.fee_exponent },
      feeEstimated:row.fee_estimated == null ? null : Boolean(row.fee_estimated),
      tradeIds:this.db.prepare('SELECT trade_id FROM order_trade_ids WHERE order_id=? ORDER BY position').all(row.id).map(t => t.trade_id) };
  }
  orderRow(order) {
    return { ...encode(order, ORDER), fee_rate:order.feeSchedule?.rate ?? null,
      fee_exponent:order.feeSchedule?.exponent ?? null,
      fee_estimated:order.feeEstimated == null ? null : Number(order.feeEstimated) };
  }
  order(id) { return this.readOrder(this.db.prepare('SELECT * FROM orders WHERE id=?').get(id)); }
  prediction(id) {
    const row=this.db.prepare('SELECT * FROM order_predictions WHERE order_id=?').get(id);
    if (!row) return null;
    return {...decode(row,PREDICTION),won:Boolean(row.won),matches:row.matches == null ? null : Boolean(row.matches)};
  }
  roundPrediction(round) {
    return decode(this.db.prepare('SELECT * FROM round_predictions WHERE round=?').get(round),ROUND_PREDICTION) || null;
  }
  saveRoundPrediction(prediction) {
    this.write('round_predictions',encode(prediction,ROUND_PREDICTION),['round'],false);
    return this.roundPrediction(prediction.round);
  }
  roundOpening(round) {return decode(this.db.prepare('SELECT * FROM round_openings WHERE round=?').get(round),OPENING)||null;}
  roundSignalReference(round) {
    const rows=this.db.prepare(`SELECT DISTINCT reference_price AS open,oracle_window AS oracleWindow FROM round_signals
      WHERE round=? AND rule='current_round_open' AND source='polymarket' AND reference_price>0 AND oracle_window IS NOT NULL`).all(round);
    return rows.length===1?rows[0]:null;
  }
  saveRoundOpening(opening){this.write('round_openings',encode(opening,OPENING),['round'],false);return this.roundOpening(opening.round);}
  savePrediction(prediction) {
    const row=encode({...prediction,won:Number(prediction.won),matches:null},PREDICTION);
    const result=this.write('order_predictions',row,['order_id'],false);
    if (result.changes) {
      const order=this.db.prepare('SELECT mode FROM orders WHERE id=?').get(prediction.orderId);
      this.historyVersions[order.mode].orders++;
    }
    return this.prediction(prediction.orderId);
  }
  verifyPrediction(id,matches,time) {
    this.db.prepare('UPDATE order_predictions SET matches=?,verified_at=? WHERE order_id=?').run(Number(matches),time,id);
  }
  orderForRound(mode, round) { return this.readOrder(this.db.prepare('SELECT * FROM orders WHERE mode=? AND round=?').get(mode, round)); }
  hasRound(mode,round) { return Boolean(this.db.prepare('SELECT 1 FROM order_rounds WHERE mode=? AND round=?').get(mode,round)); }
  saveTradeIds(order) {
    this.db.prepare('DELETE FROM order_trade_ids WHERE order_id=?').run(order.id);
    [...new Set(order.tradeIds || [])].forEach((id, position) => this.db.prepare(
      'INSERT INTO order_trade_ids(order_id,trade_id,position) VALUES (?,?,?)').run(order.id, id, position));
  }
  orderEvent(order, time = Date.now()) {
    this.db.prepare('INSERT INTO order_events(order_id,status,note,venue_order_id,time) VALUES (?,?,?,?,?)')
      .run(order.id, order.status, order.note ?? null, order.venueOrderId ?? null, time);
  }
  reserveOrder(input, book = null) {
    return this.transaction(() => {
      const order = { ...input, configId:Object.hasOwn(input, 'configId') ? input.configId : this.account(input.mode)?.configId };
      if (this.order(input.id) || this.hasRound(input.mode,input.round) ||
        this.db.prepare('SELECT 1 FROM order_rounds WHERE order_id=?').get(input.id)) return false;
      this.write('order_rounds',{mode:order.mode,round:order.round,order_id:order.id,reserved_at:order.createdAt ?? null},['mode','round'],false);
      this.write('orders', this.orderRow(order), ['id'], false);
      this.saveTradeIds(order); this.orderEvent(order, order.settledAt ?? order.createdAt ?? Date.now());
      if (book) {
        this.db.prepare('INSERT INTO order_books(order_id,fetched_at,tick_size,min_order_size) VALUES (?,?,?,?)')
          .run(order.id, book.fetchedAt ?? null, Number(book.tickSize), Number(book.minOrderSize));
        for (const [side, levels] of [['ask',book.asks], ['bid',book.bids]])
          (levels || []).forEach((level, position) => this.db.prepare(
            'INSERT INTO order_book_levels(order_id,side,position,price,size) VALUES (?,?,?,?,?)')
            .run(order.id, side, position, Number(level.price), Number(level.size)));
      }
      this.historyVersions[order.mode].orders++;
      return true;
    });
  }
  saveOrder(order) {
    return this.transaction(() => {
      const previous = this.order(order.id);
      if (!previous) throw new Error('订单不存在，无法更新');
      const next = { ...previous, ...order };
      const row = this.orderRow(next);
      const columns = Object.keys(row).filter(k => k !== 'id');
      this.db.prepare(`UPDATE orders SET ${columns.map(c => `${c}=?`).join(',')} WHERE id=?`)
        .run(...columns.map(c => row[c]), order.id);
      this.saveTradeIds(next);
      if (previous.status !== next.status || previous.note !== next.note || previous.venueOrderId !== next.venueOrderId)
        this.orderEvent(next, next.settledAt ?? Date.now());
      this.historyVersions[next.mode].orders++;
      return this.order(next.id);
    });
  }
  pending(mode) {
    return this.db.prepare(`SELECT * FROM orders WHERE status IN ('placing','uncertain','confirming','open')
      ${mode ? 'AND mode=?' : ''} ORDER BY round`).all(...(mode ? [mode] : [])).map(r => this.readOrder(r));
  }
  orders(mode, limit = 200) { return this.db.prepare('SELECT * FROM orders WHERE mode=? ORDER BY round DESC LIMIT ?').all(mode, limit).map(r => this.readOrder(r)); }
  orderCount(mode) { return this.db.prepare('SELECT COUNT(*) AS total FROM orders WHERE mode=?').get(mode).total; }
  historyVersion(mode) {
    return Object.fromEntries(Object.entries(this.historyVersions[mode]).map(([key,value]) => [key,`${this.historyEpoch}:${value}`]));
  }
  historyPage(mode, kind, { page = 1, pageSize = 20, status = 'all', anchor = null } = {}) {
    const order = kind === 'orders';
    const table = order ? 'orders' : 'logs';
    const identity = order ? 'rowid' : 'id';
    const args = order ? [mode] : [mode,this.systemLogCutoff(mode)];
    let where = order ? 'mode=?' : "(mode=? OR (mode='system' AND id>?))";
    const upper = anchor ?? this.db.prepare(`SELECT COALESCE(MAX(${identity}),0) AS anchor FROM ${table} WHERE ${where}`).get(...args).anchor;
    where += ` AND ${identity}<=?`; args.push(upper);
    if (order && status !== 'all') {
      if (status === 'open') where += " AND status IN ('placing','uncertain','confirming','open')";
      else { where += ' AND status=?'; args.push(status); }
    }
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`).get(...args).total;
    const pages = Math.max(1,Math.ceil(total/pageSize));
    page = Math.min(page,pages);
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order ? 'round DESC' : 'id DESC'} LIMIT ? OFFSET ?`)
      .all(...args,pageSize,(page-1)*pageSize);
    return { items:order ? rows.map(row => this.readOrder(row)) : rows,
      page,pageSize,total,pages,anchor:upper };
  }
  log(mode, level, message) {
    this.db.prepare('INSERT INTO logs(time,mode,level,message) VALUES (?,?,?,?)').run(Date.now(), mode, level, message);
    for (const target of mode === 'system' ? ['paper','live'] : [mode]) this.historyVersions[target].logs++;
  }
  systemLogCutoff(mode) {
    return this.db.prepare('SELECT system_through_id FROM log_clear_positions WHERE mode=?').get(mode)?.system_through_id ?? 0;
  }
  logs(mode,limit=70) {
    return this.db.prepare("SELECT * FROM logs WHERE mode=? OR (mode='system' AND id>?) ORDER BY id DESC LIMIT ?")
      .all(mode,this.systemLogCutoff(mode),limit);
  }
  clearPaperOrders() {
    return this.transaction(()=>{
      const target="SELECT id FROM orders WHERE mode='paper' AND status IN ('won','lost','void','rejected')";
      this.db.exec(`DELETE FROM order_book_levels WHERE order_id IN (${target});
        DELETE FROM order_books WHERE order_id IN (${target});
        DELETE FROM order_trade_ids WHERE order_id IN (${target});
        DELETE FROM order_predictions WHERE order_id IN (${target});
        DELETE FROM order_events WHERE order_id IN (${target});`);
      const result=this.db.prepare("DELETE FROM orders WHERE mode='paper' AND status IN ('won','lost','void','rejected')").run();
      this.historyVersions.paper.orders++;
      return Number(result.changes);
    });
  }
  clearPaperLogs() {
    return this.transaction(()=>{
      const cutoff=this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM logs').get().id;
      const count=this.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE mode='paper' OR (mode='system' AND id>?)")
        .get(this.systemLogCutoff('paper')).n;
      this.db.exec("DELETE FROM logs WHERE mode='paper'");
      this.write('log_clear_positions',{mode:'paper',system_through_id:cutoff,cleared_at:Date.now()},['mode']);
      this.historyVersions.paper.logs++;
      return count;
    });
  }
  transaction(fn) {
    const nested = this.depth > 0, name = `store_${this.depth}`;
    this.db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); this.db.exec(nested ? `RELEASE ${name}` : 'COMMIT'); return result; }
    catch (error) { this.db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  tick(time, price, source = 'polymarket',oracleWindow=null) {
    this.write('ticks', { source, time, price,oracle_window:oracleWindow }, ['source','time'], false);
    if(oracleWindow!=null)this.db.prepare('UPDATE ticks SET oracle_window=? WHERE source=? AND time=? AND oracle_window IS NULL').run(oracleWindow,source,time);
  }
  lastSecondTick(round,oracleWindow){return this.db.prepare("SELECT time,price FROM ticks WHERE source='polymarket' AND oracle_window=? AND time>=? AND time<? ORDER BY time DESC LIMIT 1").get(oracleWindow,(round+299)*1000,(round+300)*1000)||null;}
  ticks(since = Date.now() - 7200000) { return this.db.prepare("SELECT time,price FROM ticks WHERE source='polymarket' AND time>=? ORDER BY time").all(since); }
  firstOracleTick(round, targetSeconds = DEFAULT_CONFIG.entryDelay) {
    return this.db.prepare("SELECT time,price FROM ticks WHERE source='polymarket' AND time>=? AND time<=? ORDER BY time LIMIT 1")
      .get((round + targetSeconds) * 1000, (round + targetSeconds + EARLY_SIGNAL_TOLERANCE) * 1000) || null;
  }
  initialSignal(round, targetSeconds = DEFAULT_CONFIG.entryDelay) {
    return decode(this.db.prepare('SELECT * FROM round_signals WHERE round=? AND target_seconds=?').get(round,targetSeconds), SIGNAL) || null;
  }
  saveInitialSignal(input) {
    const signal = { ...input, targetSeconds:input.targetSeconds ?? DEFAULT_CONFIG.entryDelay };
    const previous = this.initialSignal(signal.round,signal.targetSeconds);
    if (!previous || (previous.rule !== 'current_round_open' && signal.rule === 'current_round_open'))
      this.write('round_signals', encode(signal, SIGNAL), ['round','target_seconds']);
    return this.initialSignal(signal.round,signal.targetSeconds);
  }
  historicalRound(round) { return decode(this.db.prepare('SELECT * FROM round_history WHERE round=?').get(round), HISTORY) || null; }
  saveHistoricalRound(item, updatedAt = Date.now()) {
    const previous = this.historicalRound(item.round);
    const final = value => ['resolved','void'].includes(value?.status);
    if (final(previous) && !final(item)) return previous;
    const next = { ...item, open:item.open ?? previous?.open ?? null, close:item.close ?? previous?.close ?? null,
      change:item.change ?? previous?.change ?? null, changePercent:item.changePercent ?? previous?.changePercent ?? null, updatedAt };
    this.write('round_history', encode(next, HISTORY), ['round']); return next;
  }
  saveEntryBlock(mode, block) { this.write('entry_blocks', { mode,round:block.round,message:block.message,at:block.at }, ['mode','round']); }
  saveEntryDiagnostic(block,book=null) {
    return this.transaction(()=>{
      const row=encode(block,DIAGNOSTIC);delete row.id;
      for(const key of Object.keys(row))if(typeof row[key]==='boolean')row[key]=Number(row[key]);else if(typeof row[key]==='number'&&!Number.isFinite(row[key]))row[key]=null;
      const columns=Object.keys(row);
      const result=this.db.prepare(`INSERT INTO entry_diagnostics(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(row));
      const id=Number(result.lastInsertRowid);
      for(const [key,side]of [['asks','ask'],['bids','bid']])for(const [position,level]of (book?.[key]||[]).entries()){
        const price=Number(level.price),size=Number(level.size);
        if(Number.isFinite(price)&&Number.isFinite(size))this.write('entry_diagnostic_levels',{diagnostic_id:id,side,position,price,size},['diagnostic_id','side','position'],false);
      }
      return decode(this.db.prepare('SELECT * FROM entry_diagnostics WHERE id=?').get(id),DIAGNOSTIC);
    });
  }
  entryBlock(mode,round,{withBook=false}={}) {
    const row=this.db.prepare('SELECT * FROM entry_diagnostics WHERE mode=? AND round=? ORDER BY id DESC LIMIT 1').get(mode,round);
    if(row){
      const block={...decode(row,DIAGNOSTIC),evidenceAvailable:true};
      if(withBook){
        const bookFor=id=>{const book={asks:[],bids:[]};for(const level of this.db.prepare('SELECT side,price,size FROM entry_diagnostic_levels WHERE diagnostic_id=? ORDER BY side,position').all(id))book[level.side==='ask'?'asks':'bids'].push({price:level.price,size:level.size});return book;};
        block.book=bookFor(row.id);
        if(row.code==='ENTRY_WINDOW_CLOSED'){
          const previous=this.db.prepare("SELECT * FROM entry_diagnostics WHERE mode=? AND round=? AND id<? AND code!='ENTRY_WINDOW_CLOSED' ORDER BY id DESC LIMIT 1").get(mode,round,row.id);
          if(previous)block.previous={...decode(previous,DIAGNOSTIC),book:bookFor(previous.id)};
        }
      }
      return block;
    }
    const legacy=this.db.prepare('SELECT round,message,at FROM entry_blocks WHERE mode=? AND round=?').get(mode,round);
    return legacy?{...legacy,code:'LEGACY_DETAILS_UNAVAILABLE',message:legacy.message.includes('或')?'旧版未保存本次拦截的完整依据，无法还原确切原因。':legacy.message,evidenceAvailable:false}:null;
  }
  entryBlocks() {
    const result = {};
    for (const row of this.db.prepare('SELECT * FROM entry_blocks ORDER BY at').all()) {
      const { mode, ...block } = row; result[mode] = this.entryBlock(mode,block.round)||block;
    }
    return result;
  }
  close() { this.db.close(); }
}
