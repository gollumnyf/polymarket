import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {simulateFill,money} from './strategy.mjs';

export const COPY_WALLET='0x13f0bcec1e2e60ec9acc3bee4d2da2fe9694a50f';
// Public reads only. This class never authenticates a wallet or submits an order.
export class CopyObserver{
  constructor(path,venue,{now=Date.now,fetchImpl=fetch}={}){
    this.venue=venue;this.now=now;this.fetch=fetchImpl;this.busy=false;this.closing=false;this.error='';this.since=Math.floor(now()/1000);this.nextPoll=0;this.nextSettlement=0;
    this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS copy_config(id INTEGER PRIMARY KEY CHECK(id=1),running INTEGER NOT NULL,budget REAL NOT NULL,max_price REAL NOT NULL,max_price_gap REAL NOT NULL,max_delay_seconds REAL NOT NULL);
      INSERT OR IGNORE INTO copy_config VALUES(1,1,6,0.99,0.005,15);
      CREATE TABLE IF NOT EXISTS copy_fills(id TEXT PRIMARY KEY,condition_id TEXT NOT NULL,token_id TEXT NOT NULL,round INTEGER NOT NULL,side TEXT NOT NULL,direction TEXT NOT NULL,outcome_index INTEGER NOT NULL,price REAL NOT NULL,size REAL NOT NULL,trade_at INTEGER NOT NULL,seen_at INTEGER NOT NULL,transaction_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS copy_observations(condition_id TEXT PRIMARY KEY,token_id TEXT NOT NULL,round INTEGER NOT NULL,slug TEXT NOT NULL,direction TEXT NOT NULL,outcome_index INTEGER NOT NULL,trade_at INTEGER NOT NULL,seen_at INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,leader_price REAL NOT NULL,budget REAL NOT NULL,price_cap REAL NOT NULL,delay_limit REAL NOT NULL,book_at INTEGER,executed_at INTEGER,price REAL,shares REAL,cost REAL,fee REAL,payout REAL,pnl REAL,settled_at INTEGER,leader_payout_rate REAL);
      CREATE INDEX IF NOT EXISTS copy_observations_seen ON copy_observations(seen_at);
      CREATE INDEX IF NOT EXISTS copy_fills_condition ON copy_fills(condition_id);
      CREATE TABLE IF NOT EXISTS copy_depth(condition_id TEXT NOT NULL REFERENCES copy_observations(condition_id),position INTEGER NOT NULL,price REAL NOT NULL,size REAL NOT NULL,PRIMARY KEY(condition_id,position));`);
    this.db.prepare("UPDATE copy_observations SET status='missed',reason='服务重启，未完成的模拟入场不补买' WHERE status='observing'").run();
  }
  config(){return this.db.prepare('SELECT * FROM copy_config WHERE id=1').get();}
  configure(input){
    const c={...this.config(),...input};
    if(Object.keys(input).some(k=>!['running','budget','max_price','max_price_gap','max_delay_seconds'].includes(k)))throw Error('未知观察参数');
    if(![true,false,0,1].includes(c.running))throw Error('观察开关无效');
    for(const [k,min,max] of [['budget',1,100],['max_price',0.01,0.999],['max_price_gap',0,0.05],['max_delay_seconds',1,60]])if(typeof c[k]!=='number'||!Number.isFinite(c[k])||c[k]<min||c[k]>max)throw Error('参数超出范围：'+k);
    if(c.running&&!this.config().running)this.since=Math.floor(this.now()/1000);
    this.db.prepare('UPDATE copy_config SET running=?,budget=?,max_price=?,max_price_gap=?,max_delay_seconds=? WHERE id=1').run(Number(c.running),c.budget,c.max_price,c.max_price_gap,c.max_delay_seconds);
  }
  snapshot(page=1){
    page=Number.isSafeInteger(Number(page))?Math.min(1000000,Math.max(1,Number(page))):1;
    const total=this.db.prepare('SELECT COUNT(*) n FROM copy_observations').get().n;
    const rows=this.db.prepare(`SELECT o.*,(SELECT SUM(size) FROM copy_fills f WHERE f.condition_id=o.condition_id AND f.token_id=o.token_id AND f.side='BUY') leader_shares,(SELECT SUM(size*price) FROM copy_fills f WHERE f.condition_id=o.condition_id AND f.token_id=o.token_id AND f.side='BUY') leader_cost,(SELECT COUNT(*) FROM copy_fills f WHERE f.condition_id=o.condition_id AND (f.side='SELL' OR f.token_id<>o.token_id)) other_fills,(SELECT COUNT(*) FROM copy_fills f WHERE f.condition_id=o.condition_id) fill_count FROM copy_observations o ORDER BY seen_at DESC LIMIT 20 OFFSET ?`).all((page-1)*20);
    const stats=this.db.prepare("SELECT COUNT(*) total,SUM(status IN ('filled','won','lost','void')) followed,SUM(status='missed') missed,SUM(status='filled') pending,COALESCE(SUM(pnl),0) pnl,COALESCE(SUM(fee),0) fees,AVG((seen_at-trade_at)/1000.0) delay FROM copy_observations").get();
    return {time:this.now(),wallet:COPY_WALLET,config:this.config(),error:this.error,lastPoll:this.lastPoll??null,stats,items:rows,page,pages:Math.max(1,Math.ceil(total/20)),total};
  }
  async tick(){
    if(this.busy||this.closing)return;this.busy=true;
    try{
      if(this.config().running&&this.now()>=this.nextPoll){this.nextPoll=this.now()+2000;await this.poll();}
      if(this.now()>=this.nextSettlement){this.nextSettlement=this.now()+15000;await this.settle();}
    }catch(e){this.error=e.message;}finally{this.busy=false;}
  }
  async poll(){
    let cursor=null,rows=[];
    for(let page=0;page<10;page++){
      const q=new URLSearchParams({user:COPY_WALLET,taker_only:'false',limit:'100',start:String(this.since)});if(cursor)q.set('cursor',cursor);
      const response=await this.fetch('https://data-api.polymarket.com/v2/trades?'+q,{signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('目标成交接口 HTTP '+response.status);
      const data=await response.json();if(!Array.isArray(data.data))throw Error('目标成交接口数据格式无效');
      const seen=this.now();rows.push(...data.data.map(x=>({...x,seen})));
      cursor=data.pagination?.next_cursor;if(!cursor)break;
    }
    if(cursor)throw Error('本轮成交超过 1000 条，未处理不完整批次；等待下一轮重试');
    rows.sort((a,b)=>a.timestamp-b.timestamp);
    for(const x of rows){if(this.closing||!this.config().running)break;await this.observe(x,x.seen);}
    this.lastPoll=this.now();this.error='';
    // Keep an overlap to capture delayed indexing. DB keys prevent duplicate fills.
    if(rows.length)this.since=Math.max(this.since,Math.max(...rows.map(x=>x.timestamp))-300);
  }
  async observe(x,seen=this.now()){
    const match=/^btc-updown-5m-(\d+)$/.exec(x.slug||'');
    if(!match||x.proxy_wallet?.toLowerCase()!==COPY_WALLET||!['BUY','SELL'].includes(x.side)||!['Up','Down'].includes(x.outcome)||![0,1].includes(x.outcome_index)||!Number.isFinite(x.price)||x.price<=0||x.price>=1||!Number.isFinite(x.size)||x.size<=0||!Number.isFinite(x.timestamp)||!x.condition_id||!x.token_id||!x.transaction_hash)return;
    if(x.timestamp<this.since)return;
    const round=Number(match[1]),direction=x.outcome.toUpperCase(),id=createHash('sha256').update(JSON.stringify([x.transaction_hash,x.token_id,x.side,x.timestamp,x.price,x.size])).digest('hex');
    const inserted=this.db.prepare('INSERT OR IGNORE INTO copy_fills VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,x.condition_id,x.token_id,round,x.side,direction,x.outcome_index,x.price,x.size,x.timestamp*1000,seen,x.transaction_hash);
    if(!inserted.changes)return;
    if(this.db.prepare('SELECT 1 FROM copy_observations WHERE condition_id=?').get(x.condition_id))return;
    const c=this.config(),cap=Math.min(c.max_price,x.price+c.max_price_gap);
    this.db.prepare('INSERT INTO copy_observations(condition_id,token_id,round,slug,direction,outcome_index,trade_at,seen_at,status,reason,leader_price,budget,price_cap,delay_limit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(x.condition_id,x.token_id,round,x.slug,direction,x.outcome_index,x.timestamp*1000,seen,'observing','正在获取发现后的官方盘口',x.price,c.budget,cap,c.max_delay_seconds);
    const miss=reason=>this.db.prepare("UPDATE copy_observations SET status='missed',reason=? WHERE condition_id=?").run(reason,x.condition_id);
    if(x.side!=='BUY')return miss('首次观察到的是卖出，本观察盘仅跟随首次买入');
    const guard=()=>{
      if(this.closing||!this.config().running)return '观察已暂停，取消本次模拟';
      if(this.now()>=(round+300)*1000)return '发现或检查盘口时场次已经结束，不追单';
      if(this.now()<round*1000)return '场次尚未开盘，不提前跟随';
      if(x.timestamp*1000>seen)return '目标成交时间晚于本地发现时间，时间口径异常';
      if(this.now()-x.timestamp*1000>c.max_delay_seconds*1000)return `目标成交距今 ${((this.now()-x.timestamp*1000)/1000).toFixed(3)} 秒，超过 ${c.max_delay_seconds} 秒上限`;
      return null;
    };
    const initial=guard();if(initial)return miss(initial);
    try{
      const market=await this.venue.market(round);
      if(market.conditionId!==x.condition_id||!market.active||market.outcomes.find(o=>o.direction===direction)?.assetId!==x.token_id)return miss('官方市场状态或结果代币与目标成交不匹配');
      if(!market.feeSchedule)return miss('缺少官方手续费规则，不进行无手续费假设');
      const book=(await this.venue.books(market))[direction];
      if(!book||this.now()-book.fetchedAt>3000||book.fetchedAt>this.now()+1000)return miss('发现后的盘口时间无效或超过 3 秒');
      this.db.prepare('UPDATE copy_observations SET book_at=? WHERE condition_id=?').run(book.fetchedAt,x.condition_id);
      const save=this.db.prepare('INSERT OR REPLACE INTO copy_depth VALUES(?,?,?,?)');for(const [i,l] of book.asks.entries())if(Number.isFinite(Number(l.price))&&Number.isFinite(Number(l.size)))save.run(x.condition_id,i,Number(l.price),Number(l.size));
      const quote=simulateFill(book,c.budget,{maxPrice:cap,slippage:0},market.feeSchedule,{strictTicks:true,ignoreSlippage:true});
      const final=guard();if(final)return miss(final);
      this.db.prepare("UPDATE copy_observations SET status='filled',reason=?,executed_at=?,price=?,shares=?,cost=?,fee=? WHERE condition_id=?").run('按发现后重新获取的盘口逐档模拟；固定金额，每场只跟首次观察方向',this.now(),quote.price,quote.shares,quote.cost,quote.fee,x.condition_id);
    }catch(e){miss('模拟未成交：'+e.message);}
  }
  async settle(){
    const rows=this.db.prepare('SELECT * FROM copy_observations WHERE leader_payout_rate IS NULL AND (round+300)*1000<=? ORDER BY round LIMIT 20').all(this.now());
    for(const o of rows){if(this.closing)return;try{
      const r=await this.venue.resolution({conditionId:o.condition_id,outcomeIndex:o.outcome_index});if(!r||!Number.isFinite(r.payout))continue;
      const pnl=o.status==='filled'?money(o.shares*r.payout-o.cost):null;
      this.db.prepare('UPDATE copy_observations SET leader_payout_rate=?,payout=?,pnl=?,settled_at=?,status=? WHERE condition_id=?').run(r.payout,pnl===null?null:money(o.shares*r.payout),pnl,this.now(),pnl===null?o.status:pnl>=0?'won':'lost',o.condition_id);
    }catch(e){this.error='结算重试：'+e.message;}}
  }
  close(){this.db.close();}
}
