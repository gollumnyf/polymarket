import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {Store} from '../server/store.mjs';
import {LossFollowEngine} from '../server/loss-follow-engine.mjs';
import {money,nextAmount} from '../server/strategy.mjs';
import {LOSS_FOLLOW_VERSION} from '../server/strategy-versions.mjs';

// Offline opportunity replay: source fills provide the entry time, direction and book.
// Never opens a venue connection or writes to an existing account database.
export function replayLossFollow(data,{config=data.followerConfig,scope='all',timing='recorded',follow=true,legacy=false}={}){
  const orders=data.orders.filter(o=>scope==='all'||o.strategyVersion===scope);
  const byRound=new Map(orders.map(o=>[o.round,o]));
  let now=0;
  const finalAt=o=>timing==='final'?(o.round+300)*1000:o.settledAt;
  const forecast=o=>{
    const saved=o.prediction;
    if(saved&&saved.observedAt<=now)return saved;
    // Tick timestamps are oracle timestamps, not independent network receipt times.
    // This fallback is explicitly an availability approximation, not a latency test.
    const p=o.fallback;
    if(p&&o.openingAt<=now&&now>=(o.round+300)*1000)return p;
    return null;
  };
  const view=o=>({...o,status:now>=finalAt(o)?o.status:'open',prediction:forecast(o)});
  const sourceStore={
    account:()=>({session:data.sourceSession,config:data.sourceConfig}),
    recentFilledOrders:(_mode,_session,limit,{beforeRound=Infinity}={})=>orders.filter(o=>o.round<beforeRound).slice(-limit).reverse().map(view),
    orderForRound:(_mode,round)=>byRound.has(round)?view(byRound.get(round)):null,
    historicalRound:round=>{
      const o=byRound.get(round);
      if(o)return now>=finalAt(o)?{status:o.status==='void'?'void':'resolved',result:o.finalDirection}:null;
      const market=data.marketHistory?.get(round);
      return market&&now>=(timing==='final'?(round+300)*1000:market.updated_at)?market:null;
    },
    roundPrediction:round=>{
      const o=byRound.get(round);
      if(o)return forecast(o);
      const saved=data.marketPredictions?.get(round);
      return saved&&saved.observedAt<=now?saved:null;
    },
  };
  const source={store:sourceStore,venue:{},lastSecondPrediction:round=>sourceStore.roundPrediction(round),
    signal:start=>({direction:byRound.get(start)?.direction??null,code:null,message:'历史来源成交机会'})};
  const store=new Store(':memory:');
  const engine=new LossFollowEngine(store,{readiness:()=>({enabled:false})},{source,now:()=>now});
  if(legacy||!follow)engine.nextAmount=nextAmount;
  if(legacy)engine.strategyVersion=store.registerStrategyVersion(LOSS_FOLLOW_VERSION);
  store.saveAccount({...store.account('paper'),running:true,balance:config.initialBalance,
    startingBalance:config.initialBalance,config});
  const trades=[],skipped={},pending=[];
  let triggers=0,previousTrigger=null;
  const skip=reason=>{skipped[reason]=(skipped[reason]??0)+1;};
  const settle=()=>{
    while(pending.length&&now>=finalAt(pending[0].original)){
      const item=pending.shift(),o=store.order(item.id),payout=money(item.fill.shares*item.original.payoutPerShare);
      const pnl=money(payout-item.fill.cost),won=item.original.status==='won';
      store.saveOrder({...o,status:item.original.status,payout,pnl,settledAt:now});
      const old=store.account('paper');
      const account=item.original.status==='void'?{...old,pnl:money(old.pnl+pnl)}:engine.accountAfterSettlement(old,pnl,won,o);
      store.saveAccount({...account,balance:money(old.balance+payout)});
    }
    for(const item of pending){
      const p=forecast(item.original);
      if(p)store.savePrediction({orderId:item.id,open:p.open,close:p.close,outcome:p.outcome,
        won:p.outcome===item.original.direction,source:p.source,observedAt:now,priceAt:p.priceAt});
    }
  };
  try{
    for(const original of orders){
      now=original.createdAt;
      settle();
      engine.arm(original.round);
      const trigger=store.db.prepare('SELECT MAX(source_round) r FROM loss_follow_triggers').get().r;
      if(trigger!=null&&trigger!==previousTrigger){triggers++;previousTrigger=trigger;}
      if(follow){
        const signal=engine.monitor(original.round);
        if(signal.cooldown){skip(signal.cooldown.code);continue;}
        if(!signal.ready){skip('waiting_signal');continue;}
      }
      const account=engine.resetStakeCycle(store.account('paper'));
      store.saveAccount(account);
      const open=store.pending('paper');
      if(open.some(o=>!o.prediction)){skip('prediction_pending');continue;}
      const projected=engine.projectAccount(account,open),budget=engine.nextAmount(projected);
      const risk=engine.riskReason(projected,account.balance);
      if(risk){skip('risk_or_balance');continue;}
      let fill;
      try{fill=engine.quote(original.book,budget,config,original.feeSchedule);}
      catch(error){skip(error.code??'book_error');continue;}
      const id='replay-'+original.round;
      const order={id,mode:'paper',session:account.session,round:original.round,end:original.round+300,
        conditionId:original.conditionId,oracleWindow:original.oracleWindow,direction:original.direction,
        status:'open',budget,createdAt:now,...fill};
      store.reserveOrder(order);
      store.saveAccount({...account,balance:money(account.balance-fill.cost)});
      pending.push({id,original,fill});
      trades.push({round:original.round,direction:original.direction,budget,...fill,status:original.status,
        pnl:money(fill.shares*original.payoutPerShare-fill.cost),trigger:follow?trigger:null});
    }
    let pnl=0,peak=0,drawdown=0,lossRun=0,maxLossRun=0,tripleLosses=0,fees=0,turnover=0;
    for(const t of trades){
      pnl=money(pnl+t.pnl);peak=Math.max(peak,pnl);drawdown=Math.max(drawdown,peak-pnl);
      lossRun=t.status==='lost'?lossRun+1:0;maxLossRun=Math.max(maxLossRun,lossRun);
      if(lossRun===3)tripleLosses++;
      fees+=t.fee;turnover+=t.cost;
    }
    const wins=trades.filter(t=>t.status==='won').length;
    return {scope,timing,follow,strategyVersion:follow?engine.strategyVersion:'PR-001',opportunities:orders.length,first:orders[0]?.round,last:orders.at(-1)?.round,
      config,triggers,trades:trades.length,wins,losses:trades.filter(t=>t.status==='lost').length,
      winRate:trades.length?wins/trades.length:null,pnl,returnOnInitial:pnl/config.initialBalance,
      turnover:money(turnover),yieldOnTurnover:turnover?pnl/turnover:null,fees:money(fees),
      drawdown:money(drawdown),maxLossRun,tripleLosses,skipped,ledger:trades};
  }finally{store.close();}
}

function load(){
  const db=new DatabaseSync('data/previous-direction.sqlite',{readOnly:true});
  const follower=new DatabaseSync('data/loss-follow.sqlite',{readOnly:true});
  const convert=c=>({baseAmount:c.base_amount,initialBalance:c.initial_balance,maxAmount:c.max_amount,
    maxDoublings:c.max_doublings,stopLoss:c.stop_loss,entryDelay:c.entry_delay,entryWindow:c.entry_window,
    slippage:c.slippage,minPrice:c.min_price,maxPrice:c.max_price,sameDirectionOnly:false,followPreviousAtOpen:true,reverseSignal:false});
  try{
    db.exec('BEGIN');follower.exec('BEGIN');
    const source=db.prepare("SELECT * FROM accounts WHERE mode='paper'").get();
    const account=follower.prepare("SELECT * FROM accounts WHERE mode='paper'").get();
    const sourceConfig=convert(db.prepare('SELECT * FROM strategy_configs WHERE id=?').get(source.config_id));
    const followerConfig=convert(follower.prepare('SELECT * FROM strategy_configs WHERE id=?').get(account.config_id));
    const rows=db.prepare("SELECT * FROM orders WHERE mode='paper' AND session=? AND shares>0 AND status IN ('won','lost','void') ORDER BY round").all(source.session);
    const book=db.prepare('SELECT * FROM order_books WHERE order_id=?');
    const levels=db.prepare('SELECT * FROM order_book_levels WHERE order_id=? ORDER BY position');
    const prediction=db.prepare('SELECT * FROM order_predictions WHERE order_id=?');
    const opening=db.prepare('SELECT * FROM round_openings WHERE round=?');
    const closing=db.prepare("SELECT time,price FROM ticks WHERE source='polymarket' AND oracle_window=? AND time<? AND price>0 ORDER BY time DESC LIMIT 1");
    const orders=rows.map(o=>{
      const b=book.get(o.id),p=prediction.get(o.id),start=opening.get(o.round);
      const window=o.oracle_window??start?.oracle_window;
      const tick=window==null?null:closing.get(window,(o.round+300)*1000);
      const prices=p?{round:o.round,conditionId:o.condition_id,oracleWindow:window,
        open:p.open_price,close:p.close_price,outcome:p.outcome,source:p.source,observedAt:p.observed_at,priceAt:p.price_at}:null;
      const fallback=start&&tick?{round:o.round,conditionId:o.condition_id,oracleWindow:window,
        open:start.open_price,close:tick.price,outcome:tick.price>=start.open_price?'UP':'DOWN',
        source:tick.time>=(o.round+299)*1000?'polymarket_last_second':'polymarket_last_available',priceAt:tick.time}:null;
      const finalDirection=o.status==='won'?o.direction:o.direction==='UP'?'DOWN':'UP';
      return {round:o.round,direction:o.direction,conditionId:o.condition_id,oracleWindow:o.oracle_window,
        strategyVersion:o.strategy_version,status:o.status,createdAt:o.created_at,settledAt:o.settled_at,
        originalPnl:o.pnl,payoutPerShare:o.payout/o.shares,finalDirection,prediction:prices,fallback,
        openingAt:start?.observed_at??Infinity,feeSchedule:{rate:o.fee_rate,exponent:o.fee_exponent},
        book:b?{fetchedAt:b.fetched_at,tickSize:b.tick_size,minOrderSize:b.min_order_size,
          asks:levels.all(o.id).filter(l=>l.side==='ask').map(l=>({price:l.price,size:l.size})),bids:[]}:null};
    });
    const first=rows[0]?.round??0,last=rows.at(-1)?.round??0;
    const marketHistory=new Map(db.prepare(`SELECT round,status,result,updated_at FROM round_history
      WHERE round BETWEEN ? AND ? AND status IN ('resolved','void')`).all(first,last).map(row=>[row.round,row]));
    const marketPredictions=new Map(db.prepare(`SELECT round,condition_id conditionId,open_price open,close_price close,
      outcome,source,oracle_window oracleWindow,observed_at observedAt,price_at priceAt FROM round_predictions
      WHERE round BETWEEN ? AND ?`).all(first,last).map(row=>[row.round,row]));
    return {sourceSession:source.session,sourceConfig,followerConfig,orders,marketHistory,marketPredictions};
  }finally{db.close();follower.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const data=load(),results=[];
  const replay=options=>replayLossFollow(data,{...options,legacy:process.argv.includes('--legacy-lf001')});
  for(const scope of ['all','PR-001'])for(const timing of ['recorded','final']){
    results.push(replay({scope,timing}));
    if(timing==='recorded'){
      results.push(replay({scope,timing,config:{...data.followerConfig,maxAmount:data.sourceConfig.maxAmount,maxDoublings:data.sourceConfig.maxDoublings,stopLoss:data.sourceConfig.stopLoss}}));
      results.push(replay({scope,timing,follow:false}));
      results.push(replay({scope,timing,follow:false,config:{...data.followerConfig,maxAmount:data.sourceConfig.maxAmount,maxDoublings:data.sourceConfig.maxDoublings,stopLoss:data.sourceConfig.stopLoss}}));
    }
  }
  const output='data/loss-follow-research/'+Date.now();mkdirSync(output,{recursive:true});
  const report={createdAt:new Date().toISOString(),sourceSession:data.sourceSession,
    original:{trades:data.orders.length,pnl:money(data.orders.reduce((s,o)=>s+o.originalPnl,0))},results};
  writeFileSync(output+'/report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,...report,results:results.map(({ledger,...r})=>r)},null,2));
}
