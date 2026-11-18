import {DatabaseSync} from 'node:sqlite';
import {adaptiveFeatures,adaptiveDirection} from './range-adaptive.mjs';
import {ADAPTIVE_MODEL} from './range-adaptive-model.mjs';
import {simulateFill,money} from './strategy.mjs';

// RA-01 observes alongside the existing engine; it cannot place live or paper account orders.
export class RangeAdaptiveObserver{
  constructor(path,engine,{now=Date.now}={}){
    this.engine=engine;this.now=now;this.busy=false;this.closing=false;this.error='';this.nextSettle=0;this.startedRound=Math.floor(now()/300000)*300;
    this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS adaptive_settings(id INTEGER PRIMARY KEY CHECK(id=1),running INTEGER NOT NULL,budget REAL NOT NULL,max_price REAL NOT NULL);
      INSERT OR IGNORE INTO adaptive_settings VALUES(1,1,6,0.50);
      CREATE TABLE IF NOT EXISTS adaptive_routes(model_hash TEXT NOT NULL,regime TEXT NOT NULL,zone TEXT NOT NULL,rule TEXT NOT NULL,PRIMARY KEY(model_hash,regime,zone));
      CREATE TABLE IF NOT EXISTS adaptive_observations(round INTEGER PRIMARY KEY,model_hash TEXT NOT NULL,observed_at INTEGER NOT NULL,decision_at INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,direction TEXT,rule TEXT,regime TEXT,zone TEXT,lower_price REAL,upper_price REAL,position REAL,efficiency REAL,noise REAL,move REAL,opening REAL,signal_price REAL,budget REAL NOT NULL,max_price REAL NOT NULL,book_at INTEGER,executed_at INTEGER,price REAL,shares REAL,cost REAL,fee REAL,outcome TEXT,correct INTEGER,pnl REAL,settled_at INTEGER);
      CREATE TABLE IF NOT EXISTS adaptive_depth(round INTEGER NOT NULL REFERENCES adaptive_observations(round),position INTEGER NOT NULL,price REAL NOT NULL,size REAL NOT NULL,PRIMARY KEY(round,position));`);
    const save=this.db.prepare('INSERT OR IGNORE INTO adaptive_routes VALUES(?,?,?,?)');for(const [key,rule]of Object.entries(ADAPTIVE_MODEL.routes)){const [regime,zone]=key.split(':');save.run(ADAPTIVE_MODEL.datasetHash,regime,zone,rule);}
    this.db.exec("UPDATE adaptive_observations SET status='skipped',reason='服务重启，取消未完成的观察报价，不回填模拟成交' WHERE status='quoting'");
  }
  config(){return this.db.prepare('SELECT * FROM adaptive_settings WHERE id=1').get();}
  configure(c){
    if(Object.keys(c).some(k=>!['running','budget','max_price'].includes(k)))throw Error('未知组合观察参数');
    const n={...this.config(),...c};if(![true,false,0,1].includes(n.running)||!Number.isFinite(n.budget)||n.budget<1||n.budget>100||!Number.isFinite(n.max_price)||n.max_price<0.01||n.max_price>0.55)throw Error('观察参数无效：金额 1–100，最高买价 0.01–0.55');
    this.db.prepare('UPDATE adaptive_settings SET running=?,budget=?,max_price=? WHERE id=1').run(Number(n.running),n.budget,n.max_price);
  }
  snapshot(page=1){
    page=Math.min(100000,Math.max(1,Number.isSafeInteger(Number(page))?Number(page):1));
    const stats=this.db.prepare("SELECT COUNT(*) rounds,SUM(direction IS NOT NULL) signals,SUM(correct IS NOT NULL) settled_signals,COALESCE(SUM(correct),0) correct,SUM(status IN ('filled','won','lost')) fills,SUM(status IN ('won','lost')) settled_fills,SUM(status='won') wins,COALESCE(SUM(pnl),0) pnl,COALESCE(SUM(fee),0) fee FROM adaptive_observations").get();
    return {model:ADAPTIVE_MODEL,config:this.config(),stats,error:this.error,time:this.now(),page,pages:Math.max(1,Math.ceil(stats.rounds/20)),items:this.db.prepare('SELECT * FROM adaptive_observations ORDER BY round DESC LIMIT 20 OFFSET ?').all((page-1)*20)};
  }
  sample(round,at){
    const d=this.engine.store.db,opening=d.prepare('SELECT * FROM round_openings WHERE round=? AND oracle_window=60 AND observed_at<=?').get(round,at);if(!opening)return {error:'决策时点之前未保存本场官方起始价'};
    const bars=d.prepare('SELECT * FROM range_price_bars WHERE oracle_window=60 AND bucket>=? AND bucket<? ORDER BY bucket').all((round-48*300)*1000,at);
    const groups=new Map;for(const b of bars){const r=Math.floor(b.bucket/300000)*300;if(!groups.has(r))groups.set(r,[]);groups.get(r).push(b);}
    const history=[];for(let r=round-48*300;r<round;r+=300){const a=groups.get(r);if(!a?.length||a[0].first_at>r*1000+10000||a.at(-1).last_at<(r+300)*1000-10000)return {error:`缺少 #${r} 的完整同源端点，跳过本场，不用补齐后的数据补单`};history.push({round:r,open:a[0].open,close:a.at(-1).close});}
    const bar=groups.get(round)?.findLast(x=>x.last_at<=at&&x.last_at>=at-6000);if(!bar)return {error:'第 60 秒之前没有 6 秒内的新鲜同源采样'};
    const f=adaptiveFeatures(history,opening.open_price,bar.close);return f?{f,opening:opening.open_price,price:bar.close}:{error:'历史区间宽度或波动输入无效'};
  }
  async tick(){
    if(this.busy||this.closing)return;this.busy=true;
    try{
      const round=Math.floor(this.now()/300000)*300,at=(round+ADAPTIVE_MODEL.seconds)*1000;
      if(this.config().running&&round>=this.startedRound&&this.now()>=at&&!this.db.prepare('SELECT 1 FROM adaptive_observations WHERE round=?').get(round))await this.observe(round,at);
      if(this.now()>=this.nextSettle){this.nextSettle=this.now()+15000;await this.settle();}
    }catch(e){this.error=e.message;}finally{this.busy=false;}
  }
  async observe(round,at){
    const c=this.config(),seen=this.now();this.db.prepare('INSERT INTO adaptive_observations(round,model_hash,observed_at,decision_at,status,reason,budget,max_price) VALUES(?,?,?,?,?,?,?,?)').run(round,ADAPTIVE_MODEL.datasetHash,seen,at,'quoting','检查固定决策点行情',c.budget,c.max_price);
    const skip=message=>this.db.prepare("UPDATE adaptive_observations SET status='skipped',reason=? WHERE round=?").run(message,round);
    const guard=()=>this.closing||!this.config().running?'观察暂停，取消模拟成交':this.now()>at+5000?'超过第 60–65 秒观察执行窗口，本场不追单':null;
    if(guard())return skip(guard());
    const sample=this.sample(round,at);if(sample.error)return skip(sample.error);const f=sample.f,rule=ADAPTIVE_MODEL.routes[f.regime+':'+f.zone],direction=f.move<ADAPTIVE_MODEL.minMove?null:adaptiveDirection(f,rule);
    this.db.prepare('UPDATE adaptive_observations SET direction=?,rule=?,regime=?,zone=?,lower_price=?,upper_price=?,position=?,efficiency=?,noise=?,move=?,opening=?,signal_price=? WHERE round=?').run(direction,rule??null,f.regime,f.zone,f.lower,f.upper,f.position,f.efficiency,f.noise,f.move,sample.opening,sample.price,round);
    if(!direction){
      if(!rule)return skip(`市场状态 ${f.regime}/${f.zone} 没有足够训练证据，自动空仓`);
      if(rule==='streak')return skip(`当前场次紧前连续同向只有 ${f.streak} 场（${f.last}），需要至少 3 场，本场不反买`);
      if(!f.early)return skip(`第 60 秒报价 ${sample.price} 等于本场起始价 ${sample.opening}，无涨跌方向，本场不买入`);
      if(rule==='aligned')return skip(`第 60 秒本场方向 ${f.early} 与近 1 小时趋势 ${f.trend} 不一致，本场不买入`);
      return skip(`标准化变动 ${f.move} 未达到模型门槛 ${ADAPTIVE_MODEL.minMove}，本场不买入`);
    }
    try{
      const market=this.engine.market;if(market?.round!==round||!market.active)return skip('官方本场盘口市场未就绪');
      if(!market.feeSchedule)return skip('缺少官方手续费规则，不假设零手续费');
      const book=(await this.engine.venue.books(market))[direction];if(!book||this.now()-book.fetchedAt>3000||book.fetchedAt>this.now()+1000)return skip('所选方向盘口超过 3 秒或时间异常');
      this.db.prepare('UPDATE adaptive_observations SET book_at=? WHERE round=?').run(book.fetchedAt,round);
      const save=this.db.prepare('INSERT OR REPLACE INTO adaptive_depth VALUES(?,?,?,?)');for(const [i,l]of book.asks.entries())if(Number.isFinite(Number(l.price))&&Number.isFinite(Number(l.size)))save.run(round,i,Number(l.price),Number(l.size));
      const quote=simulateFill(book,c.budget,{maxPrice:c.max_price,slippage:0},market.feeSchedule,{strictTicks:true,ignoreSlippage:true});if(guard())return skip(guard());
      this.db.prepare("UPDATE adaptive_observations SET status='filled',reason=?,executed_at=?,price=?,shares=?,cost=?,fee=? WHERE round=?").run(`RA-01：${f.regime}/${f.zone} → ${rule} → ${direction}；独立固定金额模拟，不改变区间账户订单`,this.now(),quote.price,quote.shares,quote.cost,quote.fee,round);this.error='';
    }catch(e){skip('未模拟成交：'+e.message);}
  }
  async settle(){
    for(const o of this.db.prepare('SELECT * FROM adaptive_observations WHERE outcome IS NULL AND (round+300)*1000<=? ORDER BY round LIMIT 20').all(this.now())){
      if(this.closing)return;
      let h=this.engine.store.historicalRound(o.round);
      if(h?.status!=='resolved'||!['UP','DOWN'].includes(h.result)){
        try{
          const market=await this.engine.venue.market(o.round),up=market.outcomes.find(x=>x.direction==='UP');
          if(!up)continue;
          const result=await this.engine.venue.resolution({conditionId:market.conditionId,outcomeIndex:up.index});
          if(!result||![0,1].includes(result.payout))continue;
          h={status:'resolved',result:result.payout===1?'UP':'DOWN'};
        }catch(e){this.error='组合观察结算重试：'+e.message;continue;}
      }
      if(this.closing)return;
      const correct=o.direction?Number(h.result===o.direction):null,pnl=o.status==='filled'?money((correct?o.shares:0)-o.cost):null;
      this.db.prepare('UPDATE adaptive_observations SET outcome=?,correct=?,pnl=?,status=?,settled_at=? WHERE round=?').run(h.result,correct,pnl,pnl===null?o.status:pnl>=0?'won':'lost',this.now(),o.round);
    }
  }
  close(){this.db.close();}
}
