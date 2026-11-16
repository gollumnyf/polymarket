import {randomUUID} from 'node:crypto';
import {Engine} from './engine.mjs';
import {roundStart,simulateFill,money} from './strategy.mjs';
import {leadSignal,leadConfig,sharesQuote} from './lead-pair.mjs';

export class LeadEngine extends Engine{
  constructor(store,venue,options={}){super(store,venue,{...options,modes:['paper']});this.samples=[];this.plan=null;}
  sample(x){
    if(this.closing)return;
    this.store.sample(x);this.samples.push(x);this.samples=this.samples.filter(v=>v.receivedAt>=this.now()-75000);
  }
  signal(){return leadSignal(this.samples,this.now(),this.store.leadConfig());}
  entryDirection(){return this.signal().direction;}
  projectAccount(a){return {...a,losses:0,projectedCount:0};}
  pollPredictions(){} // Fixed stake; predictions must never change the next budget.
  snapshot(){const s=super.snapshot();s.accounts.paper.nextAmount=s.accounts.paper.config.baseAmount;return {...s,strategy:'lead_pair',leadStats:this.store.stats(),entrySignal:this.signal(),leadConfig:this.store.leadConfig(),leadFeed:{error:this.feed?.error||null,latest:this.samples.filter(x=>x.source==='binance').at(-1)||null},executionPlan:this.plan};}
  async start(mode){if(mode!=='paper')throw Error('仅支持独立模拟盘');await super.start(mode);this.log('paper','info','行情领先实验启动：固定金额，每场最多首腿＋一次等份额配对；不使用马丁');}
  stop(mode){this.plan=null;super.stop(mode);}
  configure(mode,input){
    if(mode!=='paper')throw Error('仅支持独立模拟盘');
    const {leadConfig:settings,...trading}=input,c=settings?leadConfig(settings):this.store.leadConfig();
    this.store.transaction(()=>{super.configure(mode,{...trading,entryDelay:0,entryWindow:270,maxPrice:c.firstMaxPrice});this.store.setLeadConfig(c);});this.plan=null;this.broadcast();
  }
  async tick(){
    if(this.spot?.sourceId==='polymarket'&&this.spot.at!==this.lastOfficial){if(this.lastWindow!==this.spot.windowSeconds){this.samples=[];this.lastWindow=this.spot.windowSeconds;this.plan=null;}this.lastOfficial=this.spot.at;this.sample({source:'official',time:this.spot.at,receivedAt:this.now(),price:this.spot.price});}
    return super.tick();
  }
  async attempt(mode){
    if(mode!=='paper'||this.closing)return;
    const now=this.now(),round=roundStart(now),a=this.store.account('paper'),c=this.store.leadConfig();
    if(!a.running){this.plan=null;return;}
    const block=message=>{this.status.paper=message;this.plan=null;this.blockEntry('paper',round,message,{code:'LEAD_WAIT'});};
    if(!this.spot||this.spot.round!==round||this.spot.sourceId!=='polymarket'||now-this.spot.at>3000||this.spot.at>now+1000||!(this.spot.currentOpen>0))return block('等待本场新鲜官方价格与官方起始价');
    if(this.market?.round!==round||!this.market.active||this.spot.conditionId!==this.market.conditionId)return block('盘口市场与当前官方场次未匹配');
    const old=this.store.orderForRound('paper',round);
    if(old&&old.status!=='open')return;
    if(old&&this.store.legs(old.id).length>=2){this.status.paper='已等份额配对，等待官方结算';return;}
    const signal=this.signal(),direction=old?(old.direction==='UP'?'DOWN':'UP'):signal.direction;
    if(!old&&((round+300)*1000-now<c.minRemaining*1000))return block('已超过首腿截止时间，距离收盘不足 '+c.minRemaining+' 秒');
    if(!old&&!direction)return block(signal.message);
    const book=this.books[direction];
    if(!book||now-book.fetchedAt>3000||book.fetchedAt>now+1000)return block('所选方向盘口超过 3 秒或时间无效，等待新盘口');
    if(!old&&(a.config.baseAmount>a.config.maxAmount||a.balance<a.config.baseAmount*2))return block('首腿金额超限或余额不足以预留另一腿预算');
    let quote;
    try{
      quote=old?sharesQuote(book,old.shares,0.999999,this.market.feeSchedule):simulateFill(book,a.config.baseAmount,{...a.config,maxPrice:c.firstMaxPrice},this.market.feeSchedule,{strictTicks:true,ignoreSlippage:true});
    }catch(e){return block(e.message);}
    if(quote.cost>a.balance)return block('余额不足以完成本次整腿买入');
    if(old&&(old.shares-old.cost-quote.cost)/old.shares<c.pairProfit)return block(`配对净利润 ${(old.shares-old.cost-quote.cost)/old.shares} / 份，低于门槛 ${c.pairProfit}；继续持有首腿`);
    const key=round+':'+direction+':'+(old?'pair':'entry');
    if(this.plan?.key!==key){this.plan={key,round,direction,signalAt:now,readyAt:now+c.delayMs};this.status.paper='信号成立，等待执行延迟后用新盘口重算';return;}
    if(now<this.plan.readyAt||book.fetchedAt<this.plan.readyAt)return;
    // No await from the final checks through the atomic reservation/debit.
    const plan=this.plan;this.plan=null;
    const reason=old?`同场等份额对冲 ${direction}；总成本 ${money(old.cost+quote.cost)}，兑付份额 ${old.shares}，扣费净利润 ${money(old.shares-old.cost-quote.cost)}`:`实验动量筛选：${signal.message}；非胜率模型；首腿限价 ${c.firstMaxPrice}`;
    this.store.transaction(()=>{
      if(old){
        this.store.saveLeg(old,2,quote,book,plan.signalAt,reason,direction,now);
        this.store.saveOrder({...old,cost:money(old.cost+quote.cost),fee:money(old.fee+quote.fee),budget:money(old.budget+quote.cost),note:'双腿已配对；成交均价列显示首腿均价，详情展示每腿'});
      }else{
        const outcome=this.market.outcomes.find(x=>x.direction===direction);
        const order={id:randomUUID(),mode:'paper',session:a.session,round,end:round+300,status:'open',direction,doubling:0,budget:a.config.baseAmount,createdAt:now,slug:this.market.slug,conditionId:this.market.conditionId,assetId:outcome.assetId,outcomeIndex:outcome.index,referencePrice:this.spot.currentOpen,signalPrice:this.spot.price,signalRule:'lead_pair',entryReason:reason+`；信号 ${plan.signalAt}，模拟实际等待 ${now-plan.signalAt}ms`,feeSchedule:this.market.feeSchedule,oracleWindow:this.spot.windowSeconds,...quote};
        if(!this.store.reserveOrder(order,book))throw Error('本场已有入场占用，不重复买入');
        this.store.saveLeg(order,1,quote,book,plan.signalAt,reason,direction,now);
      }
      this.store.saveAccount({...a,balance:money(a.balance-quote.cost)});
    });
    this.status.paper=old?'配对成功，等待结算':'首腿成交，等待有利配对';this.log('paper','success',reason);
  }
  async settleInOrder(){
    for(const item of this.store.pending('paper')){
      if(this.closing)return;if(this.now()<item.end*1000)continue;
      try{
        const result=await this.venue.resolution(item);if(this.closing)return;if(!result)continue;
        const order=this.store.order(item.id);if(order.status!=='open')continue;
        const paired=this.store.legs(order.id).length===2,payout=money(order.shares*(paired?1:result.payout)),pnl=money(payout-order.cost);
        this.store.transaction(()=>{this.store.saveOrder({...order,payout,pnl,status:pnl>=0?'won':'lost',settledAt:this.now(),note:paired?'等份额配对已按官方结算兑付':'未配对，按官方方向结算'});const a=this.store.account('paper');this.store.saveAccount({...a,balance:money(a.balance+payout),pnl:money(a.pnl+pnl),cyclePnl:money(a.cyclePnl+pnl),losses:0,settled:a.settled+1,wins:a.wins+(pnl>=0?1:0)});});
        this.log('paper',pnl>=0?'success':'warning',`${paired?'配对':'单边'}结算 ${pnl.toFixed(4)}；下一笔仍为固定金额`);
      }catch(e){this.runtimeIssue('paper','结算暂不可用，继续重试：'+e.message);}
    }
  }
}
