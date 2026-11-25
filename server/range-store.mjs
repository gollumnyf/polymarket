import {Store} from './store.mjs';
import {DEFAULT_CONFIG} from './strategy.mjs';
import {RANGE_DEFAULTS,RANGE_BUCKET_MS,validateRangeConfig} from './range-strategy.mjs';

export const RANGE_TRADING_CONFIG=Object.freeze({...DEFAULT_CONFIG,entryDelay:0,entryWindow:120,maxPrice:0.5});
const stateFields={resumeRounds:'resume_rounds',executionMaxPrice:'execution_max_price',boundaryPauseRound:'boundary_pause_round',boundaryConfirmCount:'boundary_confirm_count',boundaryConfirmLastRound:'boundary_confirm_last_round',boundaryConfirmLastClose:'boundary_confirm_last_close',boundaryConfirmLastSource:'boundary_confirm_last_source',boundaryConfirmLower:'boundary_confirm_lower',boundaryConfirmUpper:'boundary_confirm_upper',boundaryPauseSide:'boundary_pause_side',boundaryPausedAt:'boundary_paused_at',boundaryResumeSide:'boundary_resume_side',boundaryResumedAt:'boundary_resumed_at',boundaryResumePrice:'boundary_resume_price',boundaryResumeThreshold:'boundary_resume_threshold',edgePercent:'edge_percent',levelLagMinutes:'level_lag_minutes',breakoutReferenceLower:'breakout_reference_lower',breakoutReferenceUpper:'breakout_reference_upper',breakoutPendingDirection:'breakout_pending_direction',breakoutStartRound:'breakout_start_round',breakoutLastRound:'breakout_last_round',breakoutCount:'breakout_count',breakoutLastClose:'breakout_last_close',breakoutLastSource:'breakout_last_source',breakoutConfirmedAt:'breakout_confirmed_at',rangeBaseDirection:'range_base_direction',rangeBaseDirectionRule:'range_base_direction_rule',configId:'config_id',oracleWindow:'oracle_window',phase:'phase',lower:'lower_price',upper:'upper_price',direction:'direction',upCount:'up_count',downCount:'down_count',expectedCount:'expected_count',supportTouches:'support_touches',resistanceTouches:'resistance_touches',widthPercent:'width_percent',roundTrips:'round_trips',windowStart:'window_start',windowEnd:'window_end',formedAt:'formed_at',breakoutSince:'breakout_since',changedAt:'changed_at',levelTimeframeMinutes:'level_timeframe_minutes',levelLookbackHours:'level_lookback_hours',levelWindowStart:'level_window_start',levelWindowEnd:'level_window_end',supportSource:'support_source',resistanceSource:'resistance_source',actualLower:'actual_lower',actualUpper:'actual_upper',lockedDirectionRule:'locked_direction_rule',lockedPreviousRound:'locked_previous_round',lockedPreviousDirection:'locked_previous_direction',lockedPreviousSource:'locked_previous_source',directionSelectedAt:'direction_selected_at',tradeFromRound:'trade_from_round',formedFrom:'formed_from'};
const sourcePriority={pending:0,polymarket_last_available:0.5,polymarket_last_second:1,polymarket_crypto_price:2,polymarket_event_metadata:2,official:3,official_void:3};
const decisionFields={directionRule:'direction_rule',decisionUpCount:'decision_up_count',decisionDownCount:'decision_down_count',tiePreviousRound:'tie_previous_round',tiePreviousDirection:'tie_previous_direction',tiePreviousSource:'tie_previous_source'};

export class RangeStore extends Store {
  constructor(path){
    super(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chart_settings(id INTEGER PRIMARY KEY CHECK(id=1),
        level_lookback_minutes INTEGER NOT NULL CHECK(level_lookback_minutes BETWEEN 15 AND 1440 AND level_lookback_minutes%5=0));
      INSERT OR IGNORE INTO chart_settings(id,level_lookback_minutes) VALUES (1,60);
      CREATE TABLE IF NOT EXISTS range_configs(id INTEGER PRIMARY KEY,lookback_hours INTEGER NOT NULL,max_width_percent REAL NOT NULL,min_round_trips INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS range_regimes(id INTEGER PRIMARY KEY,config_id INTEGER NOT NULL REFERENCES range_configs(id),oracle_window INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('range','breakout_up','breakout_down')),lower_price REAL NOT NULL,upper_price REAL NOT NULL,direction TEXT CHECK(direction IN ('UP','DOWN')),
        up_count INTEGER NOT NULL,down_count INTEGER NOT NULL,expected_count INTEGER NOT NULL,window_start INTEGER NOT NULL,window_end INTEGER NOT NULL,formed_at INTEGER NOT NULL,breakout_since INTEGER,changed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS range_control(id INTEGER PRIMARY KEY CHECK(id=1),config_id INTEGER NOT NULL REFERENCES range_configs(id),regime_id INTEGER REFERENCES range_regimes(id));
      CREATE TABLE IF NOT EXISTS range_price_bars(oracle_window INTEGER NOT NULL,bucket INTEGER NOT NULL,open REAL NOT NULL,high REAL NOT NULL,low REAL NOT NULL,close REAL NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,max_gap_ms INTEGER NOT NULL,samples INTEGER NOT NULL,PRIMARY KEY(oracle_window,bucket));
      CREATE TABLE IF NOT EXISTS range_votes(round INTEGER PRIMARY KEY,outcome TEXT CHECK(outcome IN ('UP','DOWN')),source TEXT NOT NULL,open_price REAL,close_price REAL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS range_market_prices(oracle_window INTEGER NOT NULL,round INTEGER NOT NULL,open_price REAL NOT NULL,close_price REAL NOT NULL,fetched_at INTEGER NOT NULL,PRIMARY KEY(oracle_window,round));
      CREATE TABLE IF NOT EXISTS range_order_signals(order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,regime_id INTEGER NOT NULL REFERENCES range_regimes(id),observed_at INTEGER NOT NULL,observed_price REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS range_tick_window ON ticks(source,oracle_window,time);
      CREATE TABLE IF NOT EXISTS range_protection_state(policy_id TEXT PRIMARY KEY,active INTEGER NOT NULL,direction TEXT,oracle_window INTEGER,trigger_round INTEGER,release_round INTEGER,release_id INTEGER NOT NULL,event_id INTEGER NOT NULL,recovery_count INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS range_protection_events(id INTEGER PRIMARY KEY,policy_id TEXT NOT NULL,event_type TEXT NOT NULL,direction TEXT,round INTEGER NOT NULL,time INTEGER NOT NULL,first_round INTEGER,last_round INTEGER,first_outcome TEXT,last_outcome TEXT,first_source TEXT,last_source TEXT);
      CREATE TABLE IF NOT EXISTS range_protection_accounts(mode TEXT PRIMARY KEY,session TEXT NOT NULL,last_event_id INTEGER NOT NULL,release_id INTEGER NOT NULL,reset_round INTEGER);
    `);
    const migrateStreak=!this.db.prepare('PRAGMA table_info(range_configs)').all().some(column=>column.name==='streak_reverse_enabled');
    const migrateEntryRules=!this.db.prepare('PRAGMA table_info(range_configs)').all().some(column=>column.name==='resume_rounds');
    const migrateBoundaryReturn=!this.db.prepare('PRAGMA table_info(range_regimes)').all().some(column=>column.name==='boundary_pause_side');
    for(const [table,columns] of Object.entries({range_configs:{streak_reverse_enabled:'INTEGER NOT NULL DEFAULT 0',streak_reverse_rounds:'INTEGER NOT NULL DEFAULT 3',resume_rounds:'INTEGER NOT NULL DEFAULT 0',execution_max_price:'REAL NOT NULL DEFAULT 0.5',edge_percent:'REAL NOT NULL DEFAULT 20',breakout_percent:'REAL NOT NULL DEFAULT 0.1',breakout_rounds:'INTEGER NOT NULL DEFAULT 2',level_lookback_hours:'INTEGER NOT NULL DEFAULT 4',min_level_touches:'INTEGER NOT NULL DEFAULT 2',level_tolerance_percent:'REAL NOT NULL DEFAULT 0.05'},range_regimes:{resume_rounds:'INTEGER NOT NULL DEFAULT 0',execution_max_price:'REAL NOT NULL DEFAULT 0.5',boundary_pause_round:'INTEGER',boundary_confirm_count:'INTEGER',boundary_confirm_last_round:'INTEGER',boundary_confirm_last_close:'REAL',boundary_confirm_last_source:'TEXT',boundary_confirm_lower:'REAL',boundary_confirm_upper:'REAL',boundary_pause_side:'TEXT',boundary_paused_at:'INTEGER',boundary_resume_side:'TEXT',boundary_resumed_at:'INTEGER',boundary_resume_price:'REAL',boundary_resume_threshold:'REAL',edge_percent:'REAL NOT NULL DEFAULT 20',breakout_reference_lower:'REAL',breakout_reference_upper:'REAL',breakout_pending_direction:'TEXT',breakout_start_round:'INTEGER',breakout_last_round:'INTEGER',breakout_count:'INTEGER',breakout_last_close:'REAL',breakout_last_source:'TEXT',breakout_confirmed_at:'INTEGER',range_base_direction:'TEXT',range_base_direction_rule:'TEXT',trade_from_round:'INTEGER',formed_from:'TEXT',actual_lower:'REAL',actual_upper:'REAL',locked_direction_rule:'TEXT',locked_previous_round:'INTEGER',locked_previous_direction:'TEXT',locked_previous_source:'TEXT',direction_selected_at:'INTEGER',support_source:"TEXT NOT NULL DEFAULT 'touches'",resistance_source:"TEXT NOT NULL DEFAULT 'touches'",level_timeframe_minutes:'INTEGER NOT NULL DEFAULT 0',level_lookback_hours:'INTEGER NOT NULL DEFAULT 0',level_window_start:'INTEGER',level_window_end:'INTEGER',support_touches:'INTEGER NOT NULL DEFAULT 0',resistance_touches:'INTEGER NOT NULL DEFAULT 0',width_percent:'REAL',round_trips:'INTEGER NOT NULL DEFAULT 0'}})){
      const names=new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name));
      for(const [name,type] of Object.entries(columns))if(!names.has(name))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    if(!this.db.prepare('PRAGMA table_info(range_configs)').all().some(column=>column.name==='rp01_enabled'))this.db.exec('ALTER TABLE range_configs ADD COLUMN rp01_enabled INTEGER NOT NULL DEFAULT 0');
    const migrateLevelLag=!this.db.prepare('PRAGMA table_info(range_configs)').all().some(column=>column.name==='level_lag_minutes');
    if(migrateLevelLag)this.db.exec('ALTER TABLE range_configs ADD COLUMN level_lag_minutes INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(range_regimes)').all().some(column=>column.name==='level_lag_minutes'))this.db.exec('ALTER TABLE range_regimes ADD COLUMN level_lag_minutes INTEGER NOT NULL DEFAULT 0');
    const signalColumns=new Set(this.db.prepare('PRAGMA table_info(range_order_signals)').all().map(column=>column.name));
    for(const [name,type] of Object.entries({rp01_enabled:'INTEGER',rp01_release_id:'INTEGER'}))if(!signalColumns.has(name))this.db.exec(`ALTER TABLE range_order_signals ADD COLUMN ${name} ${type}`);
    for(const [key,column] of Object.entries(decisionFields))if(!signalColumns.has(column))this.db.exec(`ALTER TABLE range_order_signals ADD COLUMN ${column} ${key.endsWith('Count')||key.endsWith('Round')?'INTEGER':'TEXT'}`);
    if(!this.db.prepare('SELECT 1 FROM range_control').get())this.transaction(()=>{
      const result=this.db.prepare('INSERT INTO range_configs(streak_reverse_enabled,streak_reverse_rounds,lookback_hours,level_lookback_hours,level_lag_minutes,resume_rounds,execution_max_price,max_width_percent,min_round_trips,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(Number(RANGE_DEFAULTS.streakReverseEnabled),RANGE_DEFAULTS.streakReverseRounds,RANGE_DEFAULTS.lookbackHours,RANGE_DEFAULTS.levelLookbackHours,RANGE_DEFAULTS.levelLagMinutes,RANGE_DEFAULTS.resumeRounds,RANGE_DEFAULTS.executionMaxPrice,1,0,Date.now());
      this.db.prepare('INSERT INTO range_control VALUES (1,?,NULL)').run(result.lastInsertRowid);
    });
    // Retain old order evidence, but never reuse five-second levels for new entries.
    this.db.exec("UPDATE range_control SET regime_id=NULL WHERE regime_id IN (SELECT id FROM range_regimes WHERE level_timeframe_minutes!=5 OR actual_lower IS NULL OR actual_upper IS NULL OR support_source!='rolling_extremes')");
    // Recover only evidence that determines the original vote direction. Edge orders
    // may have overridden direction, so derive their base from saved vote counts.
    this.db.exec(`UPDATE range_regimes SET range_base_direction=CASE
      WHEN locked_direction_rule IN ('range_majority','tie_reverse_previous') THEN direction
      WHEN up_count>down_count THEN 'UP' WHEN down_count>up_count THEN 'DOWN'
      WHEN locked_previous_direction='UP' THEN 'DOWN' WHEN locked_previous_direction='DOWN' THEN 'UP' END,
      range_base_direction_rule=CASE WHEN up_count=down_count THEN 'tie_reverse_previous' ELSE 'range_majority' END
      WHERE phase='range' AND range_base_direction IS NULL AND
        (locked_direction_rule IN ('range_majority','tie_reverse_previous') OR
         (locked_direction_rule='range_edge_reversion' AND up_count+down_count=expected_count));`);
    if(migrateLevelLag||migrateEntryRules||migrateStreak){const {id,...config}=this.rangeConfig();this.saveRangeConfig({...config,...(migrateStreak?{streakReverseEnabled:RANGE_DEFAULTS.streakReverseEnabled,streakReverseRounds:RANGE_DEFAULTS.streakReverseRounds}:{}),...(migrateLevelLag?{levelLagMinutes:RANGE_DEFAULTS.levelLagMinutes}:{}),...(migrateEntryRules?{resumeRounds:RANGE_DEFAULTS.resumeRounds,executionMaxPrice:RANGE_DEFAULTS.executionMaxPrice}:{})});}
    if(migrateBoundaryReturn){
      const state=this.rangeState();
      const side=state?.phase==='breakout_up'?'upper':state?.phase==='breakout_down'?'lower':
        state?.lockedDirectionRule==='range_edge_reversion'?(state.direction==='UP'?'lower':state.direction==='DOWN'?'upper':null):null;
      // Copy the active state only; archived orders retain their original evidence.
      if(side)this.saveRangeState({...state,boundaryPauseSide:side,boundaryPausedAt:Date.now()});
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS range_streak_events(id INTEGER PRIMARY KEY,config_id INTEGER NOT NULL REFERENCES range_configs(id),oracle_window INTEGER NOT NULL,rounds_required INTEGER NOT NULL,first_round INTEGER NOT NULL,last_round INTEGER NOT NULL,market_direction TEXT,direction TEXT,observed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS range_streak_lookup ON range_streak_events(config_id,oracle_window,last_round,id);
      CREATE TABLE IF NOT EXISTS range_streak_samples(event_id INTEGER NOT NULL REFERENCES range_streak_events(id) ON DELETE CASCADE,round INTEGER NOT NULL,outcome TEXT,source TEXT NOT NULL,open_price REAL,close_price REAL,PRIMARY KEY(event_id,round));
      CREATE TABLE IF NOT EXISTS range_streak_order_signals(order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,config_id INTEGER NOT NULL REFERENCES range_configs(id),oracle_window INTEGER NOT NULL,rounds_required INTEGER NOT NULL,first_round INTEGER NOT NULL,last_round INTEGER NOT NULL,market_direction TEXT NOT NULL,direction TEXT NOT NULL,observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS range_streak_order_samples(order_id TEXT NOT NULL REFERENCES range_streak_order_signals(order_id) ON DELETE CASCADE,round INTEGER NOT NULL,outcome TEXT,source TEXT NOT NULL,open_price REAL,close_price REAL,PRIMARY KEY(order_id,round));
    `);
    if(!this.db.prepare('PRAGMA table_info(chart_settings)').all().some(c=>c.name==='middle_percent')){
      this.transaction(()=>{
        this.db.exec('ALTER TABLE chart_settings ADD COLUMN middle_percent REAL NOT NULL DEFAULT 60 CHECK(middle_percent>0 AND middle_percent<=100)');
        const {edgePercent}=this.rangeConfig();
        if(Number.isFinite(edgePercent)&&edgePercent>=0&&edgePercent<50)
          this.db.prepare('UPDATE chart_settings SET middle_percent=? WHERE id=1').run(Number((100-2*edgePercent).toFixed(10)));
      });
    }
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
  chartSettings(){
    return this.db.prepare('SELECT level_lookback_minutes AS levelLookbackMinutes,middle_percent AS middlePercent FROM chart_settings WHERE id=1').get();
  }
  saveChartSettings(input){
    const current=this.chartSettings();
    const minutes=Object.hasOwn(input??{},'levelLookbackMinutes')?input.levelLookbackMinutes:current.levelLookbackMinutes;
    const middle=Object.hasOwn(input??{},'middlePercent')?input.middlePercent:current.middlePercent;
    if(!Number.isInteger(minutes)||minutes<15||minutes>1440||minutes%5!==0)
      throw new Error('支撑 / 压力回看时间须为 15 至 1440 分钟，以 5 分钟为单位');
    if(!Number.isFinite(middle)||middle<=0||middle>100)
      throw new Error('中间蓝色区域占比必须大于 0%，且不超过 100%');
    this.db.prepare('UPDATE chart_settings SET level_lookback_minutes=?,middle_percent=? WHERE id=1').run(minutes,middle);
    return this.chartSettings();
  }
  rangeConfig(){const row=this.db.prepare('SELECT c.id,c.streak_reverse_enabled AS streakReverseEnabled,c.streak_reverse_rounds AS streakReverseRounds,c.lookback_hours AS lookbackHours,c.level_lookback_hours AS levelLookbackHours,c.breakout_percent AS breakoutPercent,c.breakout_rounds AS breakoutRounds,c.level_lag_minutes AS levelLagMinutes,c.edge_percent AS edgePercent,c.resume_rounds AS resumeRounds,c.execution_max_price AS executionMaxPrice FROM range_configs c JOIN range_control s ON s.config_id=c.id WHERE s.id=1').get();return {...row,streakReverseEnabled:!!row.streakReverseEnabled};}
  saveRangeConfig(input){
    const config=validateRangeConfig(input),previous=this.rangeConfig();
    if(Object.keys(config).every(key=>config[key]===previous[key]))return previous;
    const keepRegime=Object.keys(config).every(key=>['edgePercent','resumeRounds','executionMaxPrice','streakReverseEnabled','streakReverseRounds'].includes(key)||config[key]===previous[key])?this.rangeState():null;
    const result=this.db.prepare('INSERT INTO range_configs(lookback_hours,level_lookback_hours,max_width_percent,min_round_trips,min_level_touches,level_tolerance_percent,breakout_percent,breakout_rounds,rp01_enabled,level_lag_minutes,edge_percent,resume_rounds,execution_max_price,streak_reverse_enabled,streak_reverse_rounds,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(config.lookbackHours,config.levelLookbackHours,1,0,0,0,config.breakoutPercent,config.breakoutRounds,0,config.levelLagMinutes,config.edgePercent,config.resumeRounds,config.executionMaxPrice,Number(config.streakReverseEnabled),config.streakReverseRounds,Date.now());
    this.db.prepare('UPDATE range_control SET config_id=?,regime_id=NULL WHERE id=1').run(result.lastInsertRowid);
    if(keepRegime)this.saveRangeState({...keepRegime,configId:Number(result.lastInsertRowid),edgePercent:config.edgePercent,resumeRounds:config.resumeRounds,executionMaxPrice:config.executionMaxPrice,...(keepRegime.boundaryPauseSide&&(config.resumeRounds!==previous.resumeRounds||config.edgePercent!==previous.edgePercent)?{boundaryPauseRound:keepRegime.boundaryPauseRound??Math.floor(keepRegime.changedAt/300000)*300,boundaryConfirmCount:0,boundaryConfirmLastRound:null,boundaryConfirmLastClose:null,boundaryConfirmLastSource:null}: {})});
    return this.rangeConfig();
  }
  protectionAccount(mode){return this.db.prepare('SELECT session,last_event_id AS lastEventId,release_id AS releaseId,reset_round AS resetRound FROM range_protection_accounts WHERE mode=?').get(mode)||null;}
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
  // Endpoint prices are authoritative body endpoints, not synthetic RTDS ticks.
  // Keep them independent from raw-bar rebuilding during seedFrom/restart.
  marketRound(round,open,close,oracleWindow,fetchedAt=Date.now()){
    if(!this.rangeReady||!Number.isFinite(oracleWindow)||!Number.isInteger(round)||round%300!==0||![open,close].every(value=>Number.isFinite(value)&&value>0))return;
    this.db.prepare(`INSERT INTO range_market_prices VALUES (?,?,?,?,?) ON CONFLICT(oracle_window,round) DO UPDATE SET
      open_price=excluded.open_price,close_price=excluded.close_price,fetched_at=excluded.fetched_at`).run(oracleWindow,round,open,close,fetchedAt);
  }
  marketPrices(window,start,end){return this.db.prepare('SELECT round,open_price AS open,close_price AS close,fetched_at AS fetchedAt FROM range_market_prices WHERE oracle_window=? AND round>=? AND round<? ORDER BY round').all(window,start,end);}
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
  streakEvents(configId,window,before){
    return this.db.prepare('SELECT * FROM range_streak_events WHERE id IN (SELECT MAX(id) FROM range_streak_events WHERE config_id=? AND oracle_window=? AND last_round<? GROUP BY last_round) ORDER BY last_round DESC,id DESC').all(configId,window,before).map(row=>this.readStreak(row));
  }
  readStreak(row,order=false){
    if(!row)return null;
    const samples=this.db.prepare('SELECT round,outcome,source,open_price AS open,close_price AS close FROM '+(order?'range_streak_order_samples WHERE order_id=?':'range_streak_samples WHERE event_id=?')+' ORDER BY round').all(order?row.order_id:row.id).map(value=>({...value}));
    return {id:row.id,configId:row.config_id,oracleWindow:row.oracle_window,roundsRequired:row.rounds_required,firstRound:row.first_round,lastRound:row.last_round,marketDirection:row.market_direction,direction:row.direction,observedAt:row.observed_at,samples};
  }
  saveStreakEvent(event){
    const previous=this.readStreak(this.db.prepare('SELECT * FROM range_streak_events WHERE config_id=? AND oracle_window=? AND last_round=? ORDER BY id DESC LIMIT 1').get(event.configId,event.oracleWindow,event.lastRound));
    const samples=event.samples.map(s=>({round:s.round,outcome:s.outcome??null,source:s.source||'pending',open:s.open??null,close:s.close??null}));
    if(previous&&previous.direction===event.direction&&previous.roundsRequired===event.roundsRequired&&JSON.stringify(previous.samples)===JSON.stringify(samples))return previous;
    return this.transaction(()=>{
      const result=this.db.prepare('INSERT INTO range_streak_events(config_id,oracle_window,rounds_required,first_round,last_round,market_direction,direction,observed_at) VALUES (?,?,?,?,?,?,?,?)').run(event.configId,event.oracleWindow,event.roundsRequired,event.firstRound,event.lastRound,event.marketDirection,event.direction,event.observedAt);
      for(const sample of samples)this.db.prepare('INSERT INTO range_streak_samples VALUES (?,?,?,?,?,?)').run(result.lastInsertRowid,sample.round,sample.outcome,sample.source,sample.open,sample.close);
      return {...event,id:Number(result.lastInsertRowid),samples};
    });
  }
  reserveOrder(order,book){return this.transaction(()=>{
    if(!super.reserveOrder(order,book))return false;
    if(order.adaptiveSignal){
      // Typed immutable evidence; also created lazily for old databases before first RA-01 order.
      this.db.exec('CREATE TABLE IF NOT EXISTS range_adaptive_order_signals(order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,model_hash TEXT NOT NULL,decision_at INTEGER NOT NULL,rule TEXT NOT NULL,regime TEXT NOT NULL,zone TEXT NOT NULL,lower_price REAL,upper_price REAL,position REAL,efficiency REAL,noise REAL,move REAL,trend TEXT,early TEXT,streak INTEGER,last_direction TEXT)');
      const s=order.adaptiveSignal;this.db.prepare('INSERT INTO range_adaptive_order_signals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(order.id,s.modelHash,s.decisionAt,s.rule,s.regime,s.zone,s.lower,s.upper,s.position,s.efficiency,s.noise,s.move,s.trend,s.early,s.streak,s.last);
    }
    if(order.signalRule==='range_regime')this.db.prepare(`INSERT INTO range_order_signals(order_id,regime_id,observed_at,observed_price,${Object.values(decisionFields).join(',')}) VALUES (?,?,?,?,${Object.keys(decisionFields).map(()=>'?').join(',')})`)
      .run(order.id,order.rangeSignal.id,order.rangeSignal.priceAt,order.rangeSignal.price,...Object.keys(decisionFields).map(key=>order.rangeSignal[key]??null));
    if(order.streakSignal){
      const s=order.streakSignal;
      this.db.prepare('INSERT INTO range_streak_order_signals VALUES (?,?,?,?,?,?,?,?,?)').run(order.id,s.configId,s.oracleWindow,s.roundsRequired,s.firstRound,s.lastRound,s.marketDirection,s.direction,s.observedAt);
      for(const sample of s.samples)this.db.prepare('INSERT INTO range_streak_order_samples VALUES (?,?,?,?,?,?)').run(order.id,sample.round,sample.outcome??null,sample.source,sample.open??null,sample.close??null);
    }
    return true;
  });}
  readOrder(row){
    const order=super.readOrder(row);
    if(order&&this.rangeReady){const signal=this.db.prepare(`SELECT r.*,${Object.values(decisionFields).map(column=>'s.'+column).join(',')},s.observed_at AS priceAt,s.observed_price AS price,s.rp01_enabled,s.rp01_release_id FROM range_order_signals s JOIN range_regimes r ON r.id=s.regime_id WHERE s.order_id=?`).get(order.id);
      if(signal)order.rangeSignal={id:signal.id,priceAt:signal.priceAt,price:signal.price,rp01Enabled:signal.rp01_enabled==null?null:!!signal.rp01_enabled,rp01ReleaseId:signal.rp01_release_id,...Object.fromEntries(Object.entries({...stateFields,...decisionFields}).map(([key,column])=>[key,signal[column]]))};}
    if(order&&this.rangeReady){const signal=this.readStreak(this.db.prepare('SELECT * FROM range_streak_order_signals WHERE order_id=?').get(order.id),true);if(signal)order.streakSignal=signal;}
    return order;
  }
  recentAdaptiveOutcomes(session){
    return this.db.prepare(`SELECT o.status,p.won AS predicted_won FROM orders o
      LEFT JOIN order_predictions p ON p.order_id=o.id
      WHERE o.mode='paper' AND o.session=? AND o.signal_rule='range_adaptive_ra01' AND o.status IN ('won','lost','open')
      ORDER BY o.round DESC LIMIT 2`).all(session);
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
