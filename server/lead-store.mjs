import {Store} from './store.mjs';
import {LEAD_DEFAULTS,leadConfig} from './lead-pair.mjs';

const fields={windowSeconds:'window_seconds',movePercent:'move_percent',leadPercent:'lead_percent',firstMaxPrice:'first_max_price',pairProfit:'pair_profit',delayMs:'delay_ms',minRemaining:'min_remaining'};

export class LeadStore extends Store{
  constructor(path){
    super(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS lead_settings(id INTEGER PRIMARY KEY CHECK(id=1),window_seconds REAL NOT NULL,move_percent REAL NOT NULL,lead_percent REAL NOT NULL,first_max_price REAL NOT NULL,pair_profit REAL NOT NULL,delay_ms REAL NOT NULL,min_remaining REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS lead_samples(id INTEGER PRIMARY KEY,source TEXT NOT NULL,time INTEGER NOT NULL,received_at INTEGER NOT NULL,price REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS lead_samples_time ON lead_samples(received_at);
      CREATE TABLE IF NOT EXISTS lead_legs(order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,leg INTEGER NOT NULL CHECK(leg IN (1,2)),direction TEXT NOT NULL,shares REAL NOT NULL,cost REAL NOT NULL,fee REAL NOT NULL,price REAL NOT NULL,created_at INTEGER NOT NULL,signal_at INTEGER NOT NULL,book_at INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(order_id,leg));
      CREATE TABLE IF NOT EXISTS lead_leg_depth(order_id TEXT NOT NULL,leg INTEGER NOT NULL,position INTEGER NOT NULL,price REAL NOT NULL,size REAL NOT NULL,PRIMARY KEY(order_id,leg,position),FOREIGN KEY(order_id,leg) REFERENCES lead_legs(order_id,leg) ON DELETE CASCADE);`);
    if(!this.db.prepare('SELECT 1 FROM lead_settings').get()){
      this.setLeadConfig(LEAD_DEFAULTS);
      const a=this.account('paper');this.saveAccount({...a,config:{...a.config,baseAmount:6,entryDelay:0,entryWindow:270,maxPrice:0.55}});
    }
    this.leadReady=true;
  }
  leadConfig(){const row=this.db.prepare('SELECT * FROM lead_settings WHERE id=1').get();return Object.fromEntries(Object.entries(fields).map(([key,column])=>[key,row[column]]));}
  setLeadConfig(input){const c=leadConfig(input);this.write('lead_settings',{id:1,...Object.fromEntries(Object.entries(fields).map(([key,column])=>[column,c[key]]))},['id']);return c;}
  sample(x){this.db.prepare('INSERT INTO lead_samples(source,time,received_at,price) VALUES (?,?,?,?)').run(x.source,x.time,x.receivedAt,x.price);}
  stats(){return this.db.prepare(`SELECT COUNT(*) AS total,SUM(legs=2) AS paired,SUM(CASE WHEN legs=2 THEN COALESCE(pnl,0) ELSE 0 END) AS pairedPnl,SUM(CASE WHEN legs=1 THEN COALESCE(pnl,0) ELSE 0 END) AS singlePnl,SUM(COALESCE(fee,0)) AS fees,SUM(status='open' AND legs=1) AS exposed FROM (SELECT o.*,(SELECT COUNT(*) FROM lead_legs l WHERE l.order_id=o.id) AS legs FROM orders o WHERE mode='paper' AND session=?)`).get(this.account('paper').session);}
  legs(id){return this.db.prepare('SELECT * FROM lead_legs WHERE order_id=? ORDER BY leg').all(id);}
  readOrder(row){const order=super.readOrder(row);if(order&&this.leadReady)order.pairLegs=this.legs(order.id);return order;}
  saveLeg(order,leg,quote,book,signalAt,reason,direction,now){
    this.db.prepare('INSERT INTO lead_legs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(order.id,leg,direction,quote.shares,quote.cost,quote.fee,quote.price,now,signalAt,book.fetchedAt,reason);
    for(const [i,x]of book.asks.entries())this.db.prepare('INSERT INTO lead_leg_depth VALUES (?,?,?,?,?)').run(order.id,leg,i,Number(x.price),Number(x.size));
  }
}
