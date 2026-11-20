import {roundStart} from './strategy.mjs';
import {safeError} from './polymarket.mjs';

const RETRY_MS=30000;
const CONFIRMED='STATE_CONFIRMED';
const FAILED=new Set(['STATE_FAILED','STATE_INVALID']);

export class LiveRedemption {
  constructor(engine){
    this.engine=engine;this.store=engine.store;this.venue=engine.venue;
    this.db=this.store.db;this.task=null;this.nextCheck=0;this.lastBalance=0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS live_redemptions(
      order_id TEXT PRIMARY KEY REFERENCES orders(id), wallet TEXT NOT NULL, market_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('waiting','submitting','submitted','confirmed','failed','uncertain')),
      next_check INTEGER NOT NULL DEFAULT 0, transaction_id TEXT, transaction_hash TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0, message TEXT
    );
    CREATE INDEX IF NOT EXISTS live_redemptions_wallet ON live_redemptions(wallet,status,next_check);
    UPDATE live_redemptions SET status='uncertain',message='提交中断，需核对平台，避免重复提交' WHERE status='submitting';`);
  }
  bind(order,version){
    const wallet=this.venue.readiness().wallet?.toLowerCase();
    if(wallet&&['v1','v2'].includes(version))
      this.db.prepare("INSERT INTO live_redemptions(order_id,wallet,market_version,status) VALUES (?,?,?,'waiting')").run(order.id,wallet,version);
  }
  hasTime(){
    const now=this.engine.now(),elapsed=now-roundStart(now)*1000;
    const deadline=this.store.account('live').config.entryWindow*1000;
    return this.engine.canRunBackground?.()!==false&&!this.engine.closing&&!this.engine.busy&&elapsed>deadline&&elapsed<270000;
  }
  snapshot(){
    const ready=this.venue.readiness(),wallet=ready.wallet?.toLowerCase();
    const rows=wallet?this.db.prepare(`SELECT r.status,count(*) AS n FROM live_redemptions r JOIN orders o ON o.id=r.order_id
      WHERE r.wallet=? AND o.settled_at IS NOT NULL AND o.payout>0 GROUP BY r.status`).all(wallet):[];
    return {configured:ready.redemptionConfigured,counts:Object.fromEntries(rows.map(row=>[row.status,row.n]))};
  }
  tick(){
    const now=this.engine.now();
    if(this.task||now<this.nextCheck||!this.hasTime())return;
    const ready=this.venue.readiness();if(!ready.authenticated||!ready.wallet)return;
    this.nextCheck=now+5000;
    this.task=this.run(ready,now).catch(error=>this.engine.log('live','warning','后台钱包刷新失败：'+safeError(error)))
      .finally(()=>{this.task=null;this.engine.broadcast();});
  }
  update(job,status,message,{id=job.transaction_id,hash=job.transaction_hash,delay=RETRY_MS}={}){
    const now=this.engine.now();
    this.db.prepare('UPDATE live_redemptions SET status=?,message=?,transaction_id=?,transaction_hash=?,next_check=?,updated_at=? WHERE order_id=?')
      .run(status,message,id??null,hash??null,now+delay,now,job.order_id);
  }
  async run(ready,now){
    const wallet=ready.wallet.toLowerCase();
    const latest=this.db.prepare(`SELECT max(o.settled_at) AS settled FROM orders o JOIN live_redemptions r ON o.id=r.order_id
      WHERE r.wallet=? AND o.mode='live'`).get(wallet).settled;
    if(ready.redemptionConfigured){
      const job=this.db.prepare(`SELECT r.*,o.condition_id,o.asset_id FROM live_redemptions r JOIN orders o ON r.order_id=o.id
        WHERE r.wallet=? AND o.mode='live' AND o.status IN ('won','void') AND o.payout>0
          AND r.status IN ('waiting','submitted') AND r.next_check<=?
        ORDER BY (r.status='submitted') DESC,o.settled_at LIMIT 1`).get(wallet,now);
      if(job){
        let submitted=false;
        try{
          if(job.status==='submitted'){
            const tx=await this.venue.redemptionReceipt(job.transaction_id);
            if(tx.state===CONFIRMED){
              this.update(job,'confirmed','已确认兑换',{hash:tx.transactionHash});
              this.engine.log('live','success','实盘份额兑换已确认：'+job.condition_id);
              this.lastBalance=0;
            }else if(FAILED.has(tx.state))this.update(job,'failed','兑换交易明确失败，请在 Polymarket 核对');
            else this.update(job,'submitted','等待链上确认',{hash:tx.transactionHash??job.transaction_hash,delay:5000});
          }else if(await this.venue.hasRedeemablePosition(job)&&this.hasTime()){
            const tx=await this.venue.redeemPosition(job,()=>{
              if(submitted||!this.hasTime())throw Error('已进入下单时段，兑换推迟');
              this.update(job,'submitting','已预留链上提交');submitted=true;
            });
            if(!tx.transactionId)throw Error('Relayer 未返回兑换交易编号');
            this.update(job,'submitted','等待链上确认',{id:tx.transactionId,hash:tx.transactionHash,delay:5000});
          }else this.update(job,'waiting','等待平台显示可兑换份额或空闲时段');
        }catch(error){
          const message=this.venue.cleanWalletError(error);
          this.update(job,submitted?'uncertain':job.status,message);
          this.engine.log('live','warning','后台兑换：'+message);
        }
      }
    }
    if(this.hasTime()&&(now-this.lastBalance>=15000||(latest??0)>this.lastBalance)){
      this.lastBalance=this.engine.now();
      await this.venue.balance();
    }
  }
}
