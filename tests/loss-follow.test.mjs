import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {PreviousDirectionEngine} from '../server/previous-direction-engine.mjs';
import {LossFollowEngine} from '../server/loss-follow-engine.mjs';
import {stakeAmount} from '../src/stake-amount.mjs';
import {createApp} from '../server/index.mjs';
import {apiPath} from '../src/api.mjs';
import {LOSS_FOLLOW_V2,LOSS_FOLLOW_V4} from '../server/strategy-versions.mjs';

const round=1800000000;
test('live follower uses paper loss evidence, its own limits, and a single live execution',async t=>{
  const f=fixture(t);
  const liveStore=new Store(':memory:');t.after(()=>liveStore.close());
  let authenticated=false,submitted=0;
  const venue={
    readiness:()=>({enabled:true,configured:true,authenticated}),
    balance:async()=>100,
    buy:async(order,quote,canSubmit)=>{
      assert.equal(canSubmit(),true);assert.equal(order.mode,'live');assert.equal(order.budget,5);
      assert.equal(order.strategyVersion,'LF-003');assert.equal(quote.priceLimit,.7);
      submitted++;return {ok:true,orderId:'venue-order'};
    },
  };
  const initialConfig={baseAmount:5,maxAmount:21,maxDoublings:3,stopLoss:120};
  const live=new LossFollowEngine(liveStore,venue,{source:f.source,mode:'live',initialConfig,now:()=>round*1000+1000});
  assert.equal(liveStore.account('live').config.maxAmount,21);
  liveStore.db.prepare('DELETE FROM strategy_versions WHERE id=?').run('LF-003');
  liveStore.registerStrategyVersion(LOSS_FOLLOW_V2);
  const reopened=new LossFollowEngine(liveStore,venue,{source:f.source,mode:'live',initialConfig:{...initialConfig,baseAmount:9}});
  assert.equal(reopened.store.account('live').config.baseAmount,5);
  await assert.rejects(live.start('live'),/连接/);
  authenticated=true;
  for(const offset of [-900,-600])f.order(f.sourceStore,round+offset,'lost');
  assert.equal(live.signal(round).code,'LOSS_FOLLOW_WAIT');
  f.order(f.sourceStore,round-300,'lost');
  f.market(round);
  live.market=f.follower.market;live.market.fetchedAt=round*1000;
  live.books=f.follower.books;live.books.DOWN.fetchedAt=round*1000;
  const server=createApp(f.source,{lossFollowLiveEngine:live,allowedModes:[]}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  const base=origin+'/loss-follow-live/api';
  const state=await fetch(base+'/state').then(r=>r.json());
  assert.equal(state.accounts.live.running,false);
  assert.equal(state.accounts.live.stakeIncrement,5);
  assert.equal(state.lossFollow.losses,3);
  assert.equal(apiPath('live/start','/loss-follow-live'),'/loss-follow-live/api/live/start');
  assert.equal((await fetch(origin+'/bollinger/api/state')).status,410);
  assert.equal((await fetch(origin+'/level-limited/api/paper/report')).status,410);
  assert.equal((await fetch(base+'/paper/report')).status,400);
  assert.equal((await fetch(base+'/live/report')).status,200);
  await live.start('live');await live.attempt('live');await live.attempt('live');
  assert.equal(submitted,1);
  assert.equal(liveStore.orderForRound('live',round).status,'confirming');
  assert.equal(liveStore.orderCount('paper'),0);
  assert.equal(f.sourceStore.orderCount('paper'),3);
  assert.equal(live.nextAmount({...liveStore.account('live'),losses:1}),15);
});

function fixture(t,version){
  let now=round*1000+290000,tick={time:now,price:95};
  const sourceStore=new Store(':memory:'),store=new Store(':memory:');
  t.after(()=>{store.close();sourceStore.close();});
  const venue={readiness:()=>({enabled:false}),priceFeed:{round,spec:{seconds:60},recent:()=>[tick]}};
  const source=new PreviousDirectionEngine(sourceStore,venue,{now:()=>now});
  source.signal=()=>({direction:'DOWN',code:null,message:'source signal'});
  const follower=new LossFollowEngine(store,venue,{source,now:()=>now});
  if(version)follower.strategyVersion=store.registerStrategyVersion(version);
  const order=(target,k,status,direction='UP')=>{
    const id=target===store?'own'+k:'source'+k;
    const value={id,round:k,end:k+300,mode:'paper',session:target.account('paper').session,direction,status,shares:10,conditionId:'c'+k,oracleWindow:60,cost:5};
    assert.equal(target.reserveOrder(value),true);
    return value;
  };
  const opening=k=>sourceStore.saveRoundOpening({round:k,conditionId:'c'+k,open:100,oracleWindow:60,observedAt:now});
  const final=(k,result='DOWN')=>sourceStore.saveHistoricalRound({round:k,end:k+300,slug:'s'+k,status:'resolved',result},now);
  const market=k=>{
    follower.market={round:k,active:true,fetchedAt:now,conditionId:'c'+k,slug:'s'+k,feeSchedule:{rate:0,exponent:1},outcomes:[{direction:'UP',assetId:'u',index:0},{direction:'DOWN',assetId:'d',index:1}]};
    follower.books={DOWN:{fetchedAt:now,tickSize:.01,minOrderSize:1,asks:[{price:.5,size:1000}],bids:[]}};
  };
  return {source,sourceStore,store,follower,order,opening,final,market,setNow:value=>{now=value;},setPrice:value=>{tick={time:now,price:value};}};
}

test('paper follows PR-002 repeated skips while live keeps the original source entry cadence',t=>{
  const {source,sourceStore,follower,order,final,setNow}=fixture(t);
  delete source.signal;
  for(const offset of [-900,-600,-300]){
    order(sourceStore,round+offset,'lost');
    final(round+offset);
  }
  setNow(round*1000+1000);
  const liveStore=new Store(':memory:');t.after(()=>liveStore.close());
  const live=new LossFollowEngine(liveStore,source.venue,{source,mode:'live',now:source.now});
  assert.equal(follower.signal(round).code,'PREVIOUS_REVERSE_COOLDOWN');
  assert.equal(live.signal(round).direction,'UP');
});
test('third provisional loss appears before rollover and gates an independent simulated fill after recheck',async t=>{
  const {source,sourceStore,store,follower,order,opening,final,market,setNow,setPrice}=fixture(t);
  order(sourceStore,round-900,'lost');
  order(sourceStore,round-300,'lost');
  order(sourceStore,round,'open');opening(round);
  assert.equal(follower.monitor(round,undefined,true).losses,3);
  assert.equal(follower.signal(round).code,'LOSS_FOLLOW_WAIT');
  setPrice(105);
  assert.equal(follower.monitor(round,undefined,true).losses,0);
  setNow((round+300)*1000+1000);final(round);
  order(sourceStore,round+300,'open');
  assert.equal(follower.signal(round+300).direction,'DOWN');
  source.signal=()=>({direction:null,code:'PREVIOUS_REVERSE_COOLDOWN',message:'source skips'});
  assert.equal(follower.signal(round+300).code,'PREVIOUS_REVERSE_COOLDOWN');
  source.signal=()=>({direction:'DOWN',code:null,message:'source signal'});
  market(round+300);
  await follower.start('paper');
  await follower.attempt('paper');
  assert.equal(store.orderForRound('paper',round+300)?.strategyVersion,'LF-005');
  assert.equal(store.orderForRound('paper',round+300)?.direction,'DOWN');
  assert.equal(sourceStore.orderCount('paper'),4);
  assert.equal(sourceStore.account('paper').balance,1000);
});
test('trigger survives a skipped entry, a win re-arms from new losses, and voids interrupt the source streak',async t=>{
  const {sourceStore,store,follower,order,final,setNow}=fixture(t);
  order(sourceStore,round-600,'lost');order(sourceStore,round-300,'lost');order(sourceStore,round,'lost');
  setNow((round+300)*1000+1000);
  await follower.start('paper');
  follower.arm();
  assert.equal(follower.monitor(round+300).armed,true);
  order(sourceStore,round+300,'won');
  setNow((round+600)*1000+1000);
  assert.equal(follower.monitor(round+600).active,true);
  order(store,round+600,'won');
  order(sourceStore,round+600,'lost');
  order(sourceStore,round+900,'lost');
  order(sourceStore,round+1200,'void');
  setNow((round+1500)*1000+1000);
  assert.equal(follower.monitor(round+1500).ready,false);
  order(sourceStore,round+1500,'lost');order(sourceStore,round+1800,'lost');order(sourceStore,round+2100,'lost');
  setNow((round+2400)*1000+1000);
  follower.arm();
  assert.equal(follower.monitor(round+2400).activeFrom,round+2100);
});
test('official correction invalidates a provisional armed cycle before its first fill',async t=>{
  const {sourceStore,follower,order,opening,final,setNow}=fixture(t);
  order(sourceStore,round-600,'lost');order(sourceStore,round-300,'lost');
  const pending=order(sourceStore,round,'open');opening(round);
  sourceStore.saveRoundPrediction({round,conditionId:pending.conditionId,open:100,close:95,outcome:'DOWN',source:'polymarket_last_second',oracleWindow:60,observedAt:(round+300)*1000});
  setNow((round+300)*1000+1000);
  await follower.start('paper');follower.arm();
  assert.equal(follower.monitor(round+300).active,true);
  final(round,'UP');
  assert.equal(follower.signal(round+300).code,'LOSS_FOLLOW_WAIT');
});

test('LF-005 consumes a trigger on fill, re-arms from fresh losses, and sizes each cycle at the base',async t=>{
  const {source,sourceStore,store,follower,order,market,setNow}=fixture(t);
  follower.configure('paper',{...store.account('paper').config,baseAmount:5});
  for(const k of [-900,-600,-300])order(sourceStore,round+k,'lost');
  const open=start=>{setNow(start*1000+1000);market(start);};
  open(round);
  await follower.start('paper');await follower.attempt('paper');
  const first=store.orderForRound('paper',round);
  assert.equal(first.budget,5);
  assert.equal(follower.monitor(round).armed,false);
  order(sourceStore,round,'lost');
  open(round+300);
  assert.equal(follower.monitor(round+300).losses,0);
  const restored=new LossFollowEngine(store,follower.venue,{source,now:follower.now});
  assert.equal(restored.signal(round+300).code,'LOSS_FOLLOW_WAIT');
  for(const k of [300,600,900]){
    order(sourceStore,round+k,'lost');
    open(round+k+300);
    await follower.attempt('paper');
  }
  // An open first fill with no forecast neither reopens its trigger nor delays the new one.
  assert.equal(store.prediction(first.id),null);
  assert.deepEqual(store.orders('paper').map(o=>[o.round,o.budget,o.doubling]),[[round+1200,5,0],[round,5,0]]);
  assert.equal(follower.snapshot().accounts.paper.nextAmount,5);
  store.saveOrder({...first,status:'lost'});
  assert.equal(follower.monitor(round+1200).armed,false);
  const second=store.orderForRound('paper',round+1200);
  store.saveOrder({...second,status:'void'});
  assert.equal(follower.signal(round+1500).code,'LOSS_FOLLOW_WAIT');
  const settled=follower.accountAfterSettlement(store.account('paper'),-5,false,first);
  assert.equal(settled.pnl,-5);
  assert.equal(settled.settled,1);
  assert.equal(settled.losses,0);
});

test('LF-004 retains the 5, 15, 35, 75 sequence when the loss markets are not all aligned',async t=>{
  const {source,sourceStore,store,follower,order,market,setNow}=fixture(t,LOSS_FOLLOW_V4);
  follower.configure('paper',{...store.account('paper').config,baseAmount:5});
  for(const offset of [-900,-600,-300])order(sourceStore,round+offset,'lost');
  for(let i=0;i<4;i++){
    const start=round+i*300;setNow(start*1000+1000);market(start);
    source.signal=()=>({direction:i===1?'UP':'DOWN',code:null,message:'source signal'});
    follower.books.UP=follower.books.DOWN;
    if(i){
      const previous=store.orderForRound('paper',start-300);
      const down=previous.direction==='UP';
      const p={round:previous.round,conditionId:previous.conditionId,oracleWindow:60,open:100,close:down?99:101,
        outcome:down?'DOWN':'UP',source:'polymarket_last_second',priceAt:start*1000-1000,observedAt:start*1000};
      store.saveRoundPrediction(p);
      store.savePrediction({orderId:previous.id,...p,won:false});
    }
    if(!i)await follower.start('paper');
    assert.equal(follower.snapshot().accounts.paper.nextAmount,[5,15,35,75][i]);
    await follower.attempt('paper');
    const current=store.orderForRound('paper',start);
    assert.equal(current.budget,[5,15,35,75][i]);
    assert.equal(current.cost,current.budget);
    assert.equal(current.strategyVersion,'LF-004');
    assert.equal(stakeAmount(5,i,5),current.budget);
  }
  assert.equal(store.account('paper').balance,870);
  const last=store.orderForRound('paper',round+900);
  setNow((round+1200)*1000+1000);
  store.savePrediction({orderId:last.id,open:100,close:99,outcome:'DOWN',won:true,
    source:'polymarket_last_second',observedAt:(round+1200)*1000,priceAt:(round+1199)*1000});
  assert.equal(follower.snapshot().accounts.paper.nextAmount,5);
  assert.equal(follower.snapshot().accounts.paper.stakeIncrement,5);
  assert.equal(follower.monitor(round+1200).ready,false);
  assert.equal(source.nextAmount({...sourceStore.account('paper'),losses:1}),20);
});

test('LF-004 uses the increment for cap reset, risk budget, settled wins and restart',t=>{
  const {source,store,follower}=fixture(t,LOSS_FOLLOW_V4);
  const account={...store.account('paper'),losses:2,config:{...store.account('paper').config,baseAmount:5,maxAmount:34}};
  assert.equal(follower.nextAmount(follower.resetStakeCycle(account)),5);
  const equal={...account,config:{...account.config,maxAmount:35}};
  assert.equal(follower.resetStakeCycle(equal),equal);
  assert.equal(follower.nextAmount(equal),35);
  assert.match(follower.riskReason({...equal,losses:1},14),/15\.000000/);
  assert.match(follower.riskReason({...equal,losses:1,riskPnl:-490},1000),/累计亏损/);
  assert.equal(follower.nextAmount(follower.accountAfterSettlement(equal,1,true)),5);
  assert.equal(follower.resetStakeCycle({...equal,config:{...equal.config,maxDoublings:1}}).losses,0);
  store.saveAccount(equal);
  const restored=new LossFollowEngine(store,follower.venue,{source,now:follower.now});
  restored.strategyVersion=store.registerStrategyVersion(LOSS_FOLLOW_V4);
  assert.equal(restored.snapshot().accounts.paper.nextAmount,35);
  assert.equal(stakeAmount(2.25,2,5),24);
});

test('each follower loss in three consecutive DOWN markets skips one round and preserves the stake sequence',async t=>{
  const {source,sourceStore,store,follower,order,market,final,setNow}=fixture(t,LOSS_FOLLOW_V4);
  follower.configure('paper',{...store.account('paper').config,baseAmount:5});
  order(sourceStore,round-1200,'lost','DOWN');
  for(const offset of [-900,-600])order(sourceStore,round+offset,'lost');
  // The immediately preceding market counts even though the source skipped it.
  final(round-600);
  const open=start=>{
    setNow(start*1000+1000);market(start);
    follower.books.UP=follower.books.DOWN;
  };
  // An earlier blocked entry after the trigger is not the first filled order.
  source.signal=()=>({direction:null,code:'PREVIOUS_REVERSE_COOLDOWN',message:'source skips'});
  open(round-300);
  await follower.start('paper');await follower.attempt('paper');
  assert.equal(store.entryBlock('paper',round-300).code,'PREVIOUS_REVERSE_COOLDOWN');
  final(round-300);
  open(round);
  source.signal=()=>({direction:'UP',code:null,message:'source buys UP'});
  await follower.attempt('paper');
  const first=store.orderForRound('paper',round);
  assert.equal(first.budget,5);
  assert.equal(first.direction,'UP');
  open(round+300);
  const predictLoss=order=>{
    const forecast={round:order.round,conditionId:order.conditionId,oracleWindow:60,open:100,close:99,
      outcome:'DOWN',source:'polymarket_last_second',priceAt:(order.end-1)*1000,observedAt:order.end*1000};
    store.saveRoundPrediction(forecast);
    store.savePrediction({orderId:order.id,...forecast,won:false});
  };
  predictLoss(first);
  await follower.attempt('paper');
  const cooldown='LOSS_FOLLOW_SAME_DIRECTION_LOSS_COOLDOWN';
  assert.equal(store.entryBlock('paper',round+300).code,cooldown);
  assert.match(store.entryBlock('paper',round+300).message,/预计失利/);
  assert.match(store.entryBlock('paper',round+300).message,/均收盘为 DOWN/);
  assert.equal(store.orderForRound('paper',round+300),null);
  assert.equal(store.account('paper').running,true);
  const restored=new LossFollowEngine(store,follower.venue,{source,now:follower.now});
  restored.strategyVersion=store.registerStrategyVersion(LOSS_FOLLOW_V4);
  assert.equal(restored.signal(round+300).code,cooldown);
  final(round+300);
  open(round+600);
  await follower.attempt('paper');
  const second=store.orderForRound('paper',round+600);
  assert.equal(second.budget,15);
  open(round+900);
  predictLoss(second);
  await follower.attempt('paper');
  assert.equal(store.entryBlock('paper',round+900).code,cooldown);
  assert.equal(store.orderForRound('paper',round+900),null);
  final(round+900);
  open(round+1200);
  await follower.attempt('paper');
  assert.equal(store.orderForRound('paper',round+1200).budget,35);
});

test('LF-004 only pauses for adjacent markets and uses official results over estimates',async t=>{
  const {source,sourceStore,store,follower,order,final,setNow}=fixture(t,LOSS_FOLLOW_V4);
  source.signal=()=>({direction:'UP',code:null,message:'source buys UP'});
  for(const offset of [-900,-600,-300])order(sourceStore,round+offset,'lost');
  setNow(round*1000+1000);
  await follower.start('paper');follower.arm(round);
  const filled=order(store,round,'open');
  for(const k of [round-300,round])sourceStore.saveRoundPrediction({round:k,conditionId:'c'+k,
    open:100,close:99,oracleWindow:60,outcome:'DOWN',source:'polymarket_last_second',observedAt:(k+300)*1000});
  setNow((round+300)*1000+1000);
  final(round-900);
  assert.equal(follower.signal(round+300).code,null);
  final(round-600);
  assert.equal(follower.signal(round+300).code,'LOSS_FOLLOW_SAME_DIRECTION_LOSS_COOLDOWN');
  final(round-300,'UP');
  assert.equal(follower.signal(round+300).code,null);
  final(round-300);
  store.saveOrder({...filled,status:'won'});
  assert.equal(follower.signal(round+300).code,'LOSS_FOLLOW_WAIT');
});

test('cooldown requires three consecutive same-direction source markets and a same-direction first loss',()=>{
  for(const scenario of ['same','mixed','gap','first won','first opposite','first unfilled']){
    const sourceStore=new Store(':memory:'),store=new Store(':memory:');
    try{
      const source=new PreviousDirectionEngine(sourceStore,{readiness:()=>({enabled:false})});
      source.signal=()=>({direction:'DOWN',code:null,message:'source signal'});
      let now=round*1000;
      const live=new LossFollowEngine(store,{readiness:()=>({enabled:false})},{source,mode:'live',now:()=>now});
      const record=(ledger,mode,k,direction,status,shares)=>ledger.reserveOrder({id:mode+k,
        mode,session:ledger.account(mode).session,round:k,end:k+300,conditionId:'c'+k,direction,status,shares});
      record(sourceStore,'paper',round-(scenario==='gap'?1200:900),'DOWN','lost',5);
      record(sourceStore,'paper',round-600,scenario==='mixed'?'UP':'DOWN','lost',5);
      record(sourceStore,'paper',round-300,'DOWN','lost',5);
      store.saveAccount({...store.account('live'),running:true});live.arm(round);
      const status=scenario==='first won'?'won':scenario==='first unfilled'?'rejected':'lost';
      record(store,'live',round,scenario==='first opposite'?'UP':'DOWN',status,scenario==='first unfilled'?0:5);
      now=(round+300)*1000;
      assert.equal(live.signal(round+300).code==='LOSS_FOLLOW_FIRST_LOSS_COOLDOWN',scenario==='same',scenario);
      assert.equal(live.signal(round+600).code==='LOSS_FOLLOW_FIRST_LOSS_COOLDOWN',false,scenario);
    }finally{store.close();sourceStore.close();}
  }
});
