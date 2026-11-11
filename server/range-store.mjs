import {Store} from './store.mjs';
import {DEFAULT_CONFIG} from './strategy.mjs';
import {RANGE_DEFAULTS,RANGE_BUCKET_MS,validateRangeConfig} from './range-strategy.mjs';

export const RANGE_TRADING_CONFIG=Object.freeze({...DEFAULT_CONFIG,entryDelay:0,entryWindow:120,maxPrice:0.5});
const stateFields={configId:'config_id',oracleWindow:'oracle_window',phase:'phase',lower:'lower_price',upper:'upper_price',direction:'direction',upCount:'up_count',downCount:'down_count',expectedCount:'expected_count',supportTouches:'support_touches',resistanceTouches:'resistance_touches',widthPercent:'width_percent',roundTrips:'round_trips',windowStart:'window_start',windowEnd:'window_end',formedAt:'formed_at',breakoutSince:'breakout_since',changedAt:'changed_at',levelTimeframeMinutes:'level_timeframe_minutes',levelLookbackHours:'level_lookback_hours',levelWindowStart:'level_window_start',levelWindowEnd:'level_window_end',supportSource:'support_source',resistanceSource:'resistance_source',actualLower:'actual_lower',actualUpper:'actual_upper',lockedDirectionRule:'locked_direction_rule',lockedPreviousRound:'locked_previous_round',lockedPreviousDirection:'locked_previous_direction',lockedPreviousSource:'locked_previous_source',directionSelectedAt:'direction_selected_at',tradeFromRound:'trade_from_round',formedFrom:'formed_from'};
const sourcePriority={pending:0,polymarket_last_second:1,polymarket_crypto_price:2,polymarket_event_metadata:2,official:3,official_void:3};
const decisionFields={directionRule:'direction_rule',decisionUpCount:'decision_up_count',decisionDownCount:'decision_down_count',tiePreviousRound:'tie_previous_round',tiePreviousDirection:'tie_previous_direction',tiePreviousSource:'tie_previous_source'};

export class RangeStore extends Store {
  constructor(path){
    super(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS range_configs(id INTEGER PRIMARY KEY,lookback_hours INTEGER NOT NULL,max_width_percent REAL NOT NULL,min_round_trips INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS range_regimes(id INTEGER PRIMARY KEY,config_id INTEGER NOT NULL REFERENCES range_configs(id),oracle_window INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('range','breakout_up','breakout_down')),lower_price REAL NOT NULL,upper_price REAL NOT NULL,direction TEXT CHECK(direction IN ('UP','DOWN')),
        up_count INTEGER NOT NULL,down_count INTEGER NOT NULL,expected_count INTEGER NOT NULL,window_start INTEGER NOT NULL,window_end INTEGER NOT NULL,formed_at INTEGER NOT NULL,breakout_since INTEGER,changed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS range_control(id INTEGER PRIMARY KEY CHECK(id=1),config_id INTEGER NOT NULL REFERENCES range_configs(id),regime_id INTEGER REFERENCES range_regimes(id));
      CREATE TABLE IF NOT EXISTS range_price_bars(oracle_window INTEGER NOT NULL,bucket INTEGER NOT NULL,open REAL NOT NULL,high REAL NOT NULL,low REAL NOT NULL,close REAL NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,max_gap_ms INTEGER NOT NULL,samples INTEGER NOT NULL,PRIMARY KEY(oracle_window,bucket));
      CREATE TABLE IF NOT EXISTS range_votes(round INTEGER PRIMARY KEY,outcome TEXT CHECK(outcome IN ('UP','DOWN')),source TEXT NOT NULL,open_price REAL,close_price REAL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS range_order_signals(order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,regime_id INTEGER NOT NULL REFERENCES range_regimes(id),observed_at INTEGER NOT NULL,observed_price REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS range_tick_window ON ticks(source,oracle_window,time);
    `);
    for(const [table,columns] of Object.entries({range_configs:{min_level_touches:'INTEGER NOT NULL DEFAULT 2',level_tolerance_percent:'REAL NOT NULL DEFAULT 0.05'},range_regimes:{trade_from_round:'INTEGER',formed_from:'TEXT',actual_lower:'REAL',actual_upper:'REAL',locked_direction_rule:'TEXT',locked_previous_round:'INTEGER',locked_previous_direction:'TEXT',locked_previous_source:'TEXT',direction_selected_at:'INTEGER',support_source:"TEXT NOT NULL DEFAULT 'touches'",resistance_source:"TEXT NOT NULL DEFAULT 'touches'",level_timeframe_minutes:'INTEGER NOT NULL DEFAULT 0',level_lookback_hours:'INTEGER NOT NULL DEFAULT 0',level_window_start:'INTEGER',level_window_end:'INTEGER',support_touches:'INTEGER NOT NULL DEFAULT 0',resistance_touches:'INTEGER NOT NULL DEFAULT 0',width_percent:'REAL',round_trips:'INTEGER NOT NULL DEFAULT 0'}})){
      const names=new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name));
      for(const [name,type] of Object.entries(columns))if(!names.has(name))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    const signalColumns=new Set(this.db.prepare('PRAGMA table_info(range_order_signals)').all().map(column=>column.name));
    for(const [key,column] of Object.entries(decisionFields))if(!signalColumns.has(column))this.db.exec(`ALTER TABLE range_order_signals ADD COLUMN ${column} ${key.endsWith('Count')||key.endsWith('Round')?'INTEGER':'TEXT'}`);
    if(!this.db.prepare('SELECT 1 FROM range_control').get())this.transaction(()=>{
      const result=this.db.prepare('INSERT INTO range_configs(lookback_hours,max_width_percent,min_round_trips,created_at) VALUES (?,?,?,?)').run(RANGE_DEFAULTS.lookbackHours,1,0,Date.now());
      this.db.prepare('INSERT INTO range_control VALUES (1,?,NULL)').run(result.lastInsertRowid);
    });
    // Retain old order evidence, but never reuse five-second levels for new entries.
    this.db.exec("UPDATE range_control SET regime_id=NULL WHERE regime_id IN (SELECT id FROM range_regimes WHERE level_timeframe_minutes!=15 OR level_lookback_hours!=4 OR actual_lower IS NULL OR actual_upper IS NULL OR support_source!='rolling_extremes')");
    this.rangeReady=true;
    this.insertTick=this.db.prepare('INSERT OR IGNORE INTO ticks(source,time,price,oracle_window) VALUES (?,?,?,?)');
    this.upsertBar=this.db.prepare(`INSERT INTO range_price_bars VALUES (?,?,?,?,?,?,?,?,0,1) ON CONFLICT(oracle_window,bucket) DO UPDATE SET
      open=CASE WHEN excluded.first_at<first_at THEN excluded.open ELSE open END,
      close=CASE WHEN excluded.last_at>last_at THEN excluded.close ELSE close END,
      high=MAX(high,excluded.high),low=MIN(low,excluded.low),
      max_gap_ms=MAX(max_gap_ms,CASE WHEN excluded.last_at>last_at THEN excluded.last_at-last_at ELSE 0 END),
      first_at=MIN(first_at,excluded.first_at),last_at=MAX(last_at,excluded.last_at),samples=samples+1`);
  }
  freshAccount(mode,config=RANGE_TRADING_CONFIG){return super.freshAccount(mode,config);}
  rangeConfig(){return {...this.db.prepare('SELECT c.id,c.lookback_hours AS lookbackHours FROM range_configs c JOIN range_control s ON s.config_id=c.id WHERE s.id=1').get()};}
  saveRangeConfig(input){
    const config=validateRangeConfig(input),previous=this.rangeConfig();
    if(Object.keys(config).every(key=>config[key]===previous[key]))return previous;
    const result=this.db.prepare('INSERT INTO range_configs(lookback_hours,max_width_percent,min_round_trips,min_level_touches,level_tolerance_percent,created_at) VALUES (?,?,?,?,?,?)').run(config.lookbackHours,1,0,0,0,Date.now());
    this.db.prepare('UPDATE range_control SET config_id=?,regime_id=NULL WHERE id=1').run(result.lastInsertRowid);
    return this.rangeConfig();
  }
  rangeState(){
    const row=this.db.prepare('SELECT r.* FROM range_regimes r JOIN range_control c ON c.regime_id=r.id WHERE c.id=1').get();
    return row?{id:row.id,...Object.fromEntries(Object.entries(stateFields).map(([key,column])=>[key,row[column]]))}:null;
  }
  saveRangeState(state){
    const previous=this.rangeState();
    if(previous&&Object.keys(stateFields).every(key=>previous[key]===state[key]))return previous;
    return this.transaction(()=>{
      const fields=Object.values(stateFields);
      const result=this.db.prepare(`INSERT INTO range_regimes(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).run(...Object.keys(stateFields).map(key=>state[key]??null));
      this.db.prepare('UPDATE range_control SET regime_id=? WHERE id=1').run(result.lastInsertRowid);
      return this.rangeState();
    });
  }
  tick(time,price,source='polymarket',oracleWindow=null){
    if(!this.rangeReady||source!=='polymarket'||!Number.isFinite(oracleWindow))return super.tick(time,price,source,oracleWindow);
    this.transaction(()=>{
      const result=this.insertTick.run(source,time,price,oracleWindow);
      if(result.changes)this.upsertBar.run(oracleWindow,Math.floor(time/RANGE_BUCKET_MS)*RANGE_BUCKET_MS,price,price,price,price,time,time);
    });
  }
  rangeBars(window,start,end){return this.db.prepare('SELECT bucket,open,high,low,close,first_at AS firstAt,last_at AS lastAt,max_gap_ms AS maxGapMs,samples FROM range_price_bars WHERE oracle_window=? AND bucket>=? AND bucket<? ORDER BY bucket').all(window,start,end);}
  vote(round){return this.db.prepare('SELECT round,outcome,source,open_price AS open,close_price AS close,updated_at AS updatedAt FROM range_votes WHERE round=?').get(round)||null;}
  saveVote(vote){
    const previous=this.vote(vote.round);
    if(previous&&sourcePriority[previous.source]>sourcePriority[vote.source])return previous;
    if(previous&&previous.source===vote.source&&previous.outcome===(vote.outcome??null)&&previous.open===(vote.open??null)&&previous.close===(vote.close??null)&&previous.updatedAt>=vote.updatedAt)return previous;
    this.db.prepare('INSERT INTO range_votes VALUES (?,?,?,?,?,?) ON CONFLICT(round) DO UPDATE SET outcome=excluded.outcome,source=excluded.source,open_price=excluded.open_price,close_price=excluded.close_price,updated_at=excluded.updated_at')
      .run(vote.round,vote.outcome??null,vote.source,vote.open??null,vote.close??null,vote.updatedAt);
    return this.vote(vote.round);
  }
  reserveOrder(order,book){return this.transaction(()=>{
    if(!super.reserveOrder(order,book))return false;
    if(order.signalRule==='range_regime')this.db.prepare(`INSERT INTO range_order_signals(order_id,regime_id,observed_at,observed_price,${Object.values(decisionFields).join(',')}) VALUES (?,?,?,?,${Object.keys(decisionFields).map(()=>'?').join(',')})`)
      .run(order.id,order.rangeSignal.id,order.rangeSignal.priceAt,order.rangeSignal.price,...Object.keys(decisionFields).map(key=>order.rangeSignal[key]??null));
    return true;
  });}
  readOrder(row){
    const order=super.readOrder(row);
    if(order&&this.rangeReady){const signal=this.db.prepare(`SELECT r.*,${Object.values(decisionFields).map(column=>'s.'+column).join(',')},s.observed_at AS priceAt,s.observed_price AS price FROM range_order_signals s JOIN range_regimes r ON r.id=s.regime_id WHERE s.order_id=?`).get(order.id);
      if(signal)order.rangeSignal={id:signal.id,priceAt:signal.priceAt,price:signal.price,...Object.fromEntries(Object.entries({...stateFields,...decisionFields}).map(([key,column])=>[key,signal[column]]))};}
    return order;
  }
  seedFrom(stores,now=Date.now()){
    const since=Math.floor((now-24*3600000)/RANGE_BUCKET_MS)*RANGE_BUCKET_MS;
    this.transaction(()=>{
      for(const source of stores){
        const insert=this.db.prepare('INSERT OR IGNORE INTO ticks(source,time,price,oracle_window) VALUES (?,?,?,?)');
        for(const tick of source.db.prepare("SELECT * FROM ticks WHERE source='polymarket' AND oracle_window IS NOT NULL AND time>=? AND time<=? ORDER BY time").all(since,now))insert.run(tick.source,tick.time,tick.price,tick.oracle_window);
        for(const table of ['round_history','round_predictions','round_openings'])for(const row of source.db.prepare(`SELECT * FROM ${table} WHERE round>=? AND round<?`).all(Math.floor(since/1000),Math.floor(now/1000))){
          const previous=table==='round_history'?this.db.prepare('SELECT status FROM round_history WHERE round=?').get(row.round):null;
          const upgrade=previous&&!['resolved','void'].includes(previous.status)&&['resolved','void'].includes(row.status);
          this.write(table,row,['round'],!!upgrade);
        }
      }
      // Rebuild aggregates from deduplicated raw official quotes, including gaps.
      this.db.prepare('DELETE FROM range_price_bars WHERE bucket>=?').run(since);
      this.db.prepare(`INSERT INTO range_price_bars
        WITH ordered AS (SELECT oracle_window,time,price,(time/5000)*5000 AS bucket,
          FIRST_VALUE(price) OVER(PARTITION BY oracle_window,time/5000 ORDER BY time) AS first_price,
          FIRST_VALUE(price) OVER(PARTITION BY oracle_window,time/5000 ORDER BY time DESC) AS last_price,
          time-LAG(time) OVER(PARTITION BY oracle_window,time/5000 ORDER BY time) AS gap
          FROM ticks WHERE source='polymarket' AND oracle_window IS NOT NULL AND time>=? AND time<=?)
        SELECT oracle_window,bucket,MAX(first_price),MAX(price),MIN(price),MAX(last_price),MIN(time),MAX(time),COALESCE(MAX(gap),0),COUNT(*)
          FROM ordered GROUP BY oracle_window,bucket;`).run(since,now);
    });
  }
}
