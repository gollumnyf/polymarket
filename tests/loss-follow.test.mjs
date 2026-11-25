import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {PreviousDirectionEngine} from '../server/previous-direction-engine.mjs';
import {LossFollowEngine} from '../server/loss-follow-engine.mjs';
import {stakeAmount} from '../src/stake-amount.mjs';

const round=1800000000;
function fixture(t){
  let now=round*1000+290000,tick={time:now,price:95};
  const sourceStore=new Store(':memory:'),store=new Store(':memory:');
  t.after(()=>{store.close();sourceStore.close();});
  const venue={readiness:()=>({enabled:false}),priceFeed:{round,spec:{seconds:60},recent:()=>[tick]}};
  const source=new PreviousDirectionEngine(sourceStore,venue,{now:()=>now});
  source.signal=()=>({direction:'DOWN',code:null,message:'source signal'});
  const follower=new LossFollowEngine(store,venue,{source,now:()=>now});
  const order=(target,k,status)=>{
    const id=target===store?'own'+k:'source'+k;
    const value={id,round:k,end:k+300,mode:'paper',session:target.account('paper').session,direction:'UP',status,shares:10,conditionId:'c'+k,oracleWindow:60,cost:5};
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
  assert.equal(store.orderForRound('paper',round+300)?.strategyVersion,'LF-002');
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

test('LF-002 fills 5, 15, 35, 75 using pending losses and resets on a predicted win',async t=>{
  const {source,sourceStore,store,follower,order,market,setNow}=fixture(t);
  follower.configure('paper',{...store.account('paper').config,baseAmount:5});
  for(const offset of [-900,-600,-300])order(sourceStore,round+offset,'lost');
  for(let i=0;i<4;i++){
    const start=round+i*300;setNow(start*1000+1000);market(start);
    if(i){
      const previous=store.orderForRound('paper',start-300);
      const p={round:previous.round,conditionId:previous.conditionId,oracleWindow:60,open:100,close:101,
        outcome:'UP',source:'polymarket_last_second',priceAt:start*1000-1000,observedAt:start*1000};
      store.saveRoundPrediction(p);
      store.savePrediction({orderId:previous.id,...p,won:false});
    }
    if(!i)await follower.start('paper');
    assert.equal(follower.snapshot().accounts.paper.nextAmount,[5,15,35,75][i]);
    await follower.attempt('paper');
    const current=store.orderForRound('paper',start);
    assert.equal(current.budget,[5,15,35,75][i]);
    assert.equal(current.cost,current.budget);
    assert.equal(current.strategyVersion,'LF-002');
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

test('LF-002 uses the increment for cap reset, risk budget, settled wins and restart',t=>{
  const {source,store,follower}=fixture(t);
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
  assert.equal(restored.snapshot().accounts.paper.nextAmount,35);
  assert.equal(stakeAmount(2.25,2,5),24);
});
