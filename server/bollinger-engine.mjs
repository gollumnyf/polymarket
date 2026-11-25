import {Store} from './store.mjs';
import {PreviousDirectionEngine} from './previous-direction-engine.mjs';
import {BOLLINGER_DEFAULTS,validateBollinger} from '../src/bollinger.mjs';
import {BollingerHistoryRepair} from './bollinger-history.mjs';
export {bollingerHistory} from './bollinger-history.mjs';

export class BollingerStore extends Store{
  constructor(path,{sourceConfig}={}){
    super(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS bollinger_settings(
      id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      period INTEGER NOT NULL CHECK(period BETWEEN 2 AND 200),
      deviations REAL NOT NULL CHECK(deviations BETWEEN 0.1 AND 10),
      interval_seconds INTEGER NOT NULL CHECK(interval_seconds IN (15,30,60,300)),updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bollinger_history_prices(
        oracle_window INTEGER NOT NULL,price_at INTEGER NOT NULL,price REAL NOT NULL CHECK(price>0),
        source TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(oracle_window,price_at))`);
    if(!this.db.prepare('SELECT id FROM bollinger_settings WHERE id=1').get()){
      this.transaction(()=>{
        this.saveBollingerSettings(BOLLINGER_DEFAULTS);
        if(sourceConfig){
          const account=this.account('paper');
          this.saveAccount({...account,config:{...sourceConfig},balance:sourceConfig.initialBalance,startingBalance:sourceConfig.initialBalance});
        }
      });
    }
  }
  bollingerSettings(){
    const row=this.db.prepare('SELECT enabled,period,deviations,interval_seconds AS intervalSeconds FROM bollinger_settings WHERE id=1').get();
    return row?{...row,enabled:!!row.enabled}:{...BOLLINGER_DEFAULTS};
  }
  saveBollingerSettings(input){
    const config=validateBollinger(input,this.bollingerSettings());
    this.db.prepare(`INSERT INTO bollinger_settings VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      enabled=excluded.enabled,period=excluded.period,deviations=excluded.deviations,
      interval_seconds=excluded.interval_seconds,updated_at=excluded.updated_at`)
      .run(Number(config.enabled),config.period,config.deviations,config.intervalSeconds,Date.now());
    return config;
  }
  bollingerHistoryPrices(window,start,end){
    return this.db.prepare('SELECT price_at AS time,price,oracle_window AS oracleWindow,source FROM bollinger_history_prices WHERE oracle_window=? AND price_at>=? AND price_at<=? ORDER BY price_at')
      .all(window,start,end);
  }
  saveBollingerHistoryPrice({oracleWindow,time,price,observedAt}){
    this.db.prepare(`INSERT INTO bollinger_history_prices VALUES (?,?,?,'polymarket_crypto_price',?)
      ON CONFLICT(oracle_window,price_at) DO UPDATE SET price=excluded.price,observed_at=excluded.observed_at`)
      .run(oracleWindow,time,price,observedAt);
  }
}

export class BollingerEngine extends PreviousDirectionEngine{
  constructor(store,venue,options={}){
    super(store,venue,{...options,mode:'paper'});
    this.bollingerRepair=new BollingerHistoryRepair({store,venue,marketStore:this.marketStore,now:this.now,
      canRunBackground:()=>this.canRunBackground(),isClosing:()=>this.closing});
  }
  async tick(){
    this.bollingerRepair.poll();
    return super.tick();
  }
  configureBollinger(input){
    const config=this.store.saveBollingerSettings(input);this.broadcast();return config;
  }
  snapshot(){return {...super.snapshot(),bollinger:this.store.bollingerSettings()};}
}

