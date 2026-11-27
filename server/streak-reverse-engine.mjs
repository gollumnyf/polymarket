import {PreviousDirectionEngine} from './previous-direction-engine.mjs';
import {ROUND_SECONDS,roundStart} from './strategy.mjs';
import {STREAK_REVERSE_VERSION,TWO_ROUND_STREAK_REVERSE_VERSION} from './strategy-versions.mjs';

const fixedConfig={baseAmount:10,maxDoublings:0,minPrice:.40,maxPrice:.65};
const strategies={
  2:{version:TWO_ROUND_STREAK_REVERSE_VERSION,label:'两场',rule:'previous_two_round_streak_reverse',offsets:[2]},
  3:{version:STREAK_REVERSE_VERSION,label:'三场',rule:'previous_three_round_streak_reverse',offsets:[3,2]},
};

export class StreakReverseEngine extends PreviousDirectionEngine{
  constructor(store,venue,{source,marketStore,now,streakRounds=3}){
    if(streakRounds!==2&&streakRounds!==3)throw Error('同向反买只支持两场或三场');
    super(store,venue,{mode:'paper',repeatAfterLoss:false,marketStore,previousMarketStore:source.store,now});
    this.source=source;
    this.history=source.history;
    this.streakRounds=streakRounds;
    this.streakStrategy=strategies[streakRounds];
    const {version}=this.streakStrategy;
    store.transaction(()=>{
      const initialized=store.db.prepare('SELECT 1 FROM strategy_versions WHERE id=?').get(version.id);
      if(!initialized){
        const account=store.account('paper');
        store.saveAccount({...account,balance:10000,startingBalance:10000,
          config:{...account.config,...fixedConfig,initialBalance:10000,stopLoss:1000}});
      }
      this.strategyVersion=store.registerStrategyVersion(version);
    });
  }
  configure(mode,input){return super.configure(mode,{...input,...fixedConfig});}
  nextAmount(){return fixedConfig.baseAmount;}
  resetStakeCycle(account){return account;}
  executionAccount(account){return {...account,losses:0,stakeLosses:0,stakeLabel:'固定投入'};}
  isPreviousStakeCycle(){return true;}
  positionStatus(){return '本场持仓中，等待官方结算';}

  // The source engine owns the forecast fetch and the Chainlink price archive.
  collectPriceTicks(){}
  pollSpot(){}
  refreshPreviousPrediction(){
    this.source.collectPriceTicks();
    return this.source.refreshPreviousPrediction();
  }
  getRoundPrediction(round,order){return this.source.getRoundPrediction(round,order);}
  async tick(){
    this.spot=this.source.spot;
    if(this.source.errors.spot)this.errors.spot=this.source.errors.spot;
    else delete this.errors.spot;
    return super.tick();
  }

  signal(start=roundStart(this.now())){
    const {label,offsets}=this.streakStrategy;
    const signal=super.signal(start,{repeatAfterLoss:true,pauseOnFirstPair:this.streakRounds===3,lossCooldownRounds:this.streakRounds});
    if(signal.code)return signal;
    const previous=offsets.map(offset=>this.marketResult(start-offset*ROUND_SECONDS));
    const rounds=[...previous,{round:signal.round,direction:signal.previousDirection,source:signal.source}];
    const evidence=rounds.map(r=>`#${r.round} ${r.direction?r.direction+(r.source==='official'?'（官方）':'（预计）'):r.source==='official_void'?'作废':'待定'}`).join('、');
    if(previous.some(r=>r.direction!==signal.previousDirection))
      return {...signal,direction:null,code:'STREAK_REVERSE_NO_SIGNAL',message:`紧邻前${label}尚未全部同向：${evidence}；本场暂不买入`};
    return {...signal,message:`紧邻前${label}同向：${evidence}；本场反买 ${signal.direction}`};
  }
  orderSignalFields(account,start){
    return {...super.orderSignalFields(account,start),signalRule:this.streakStrategy.rule};
  }
  snapshot(){
    const snapshot=super.snapshot();
    snapshot.accounts.paper.fixedStake=true;
    snapshot.accounts.paper.streakRounds=this.streakRounds;
    return {...snapshot,strategy:this.streakStrategy.rule,
      previousRoundPrediction:this.source.store.roundPrediction(snapshot.round-ROUND_SECONDS)};
  }
}
