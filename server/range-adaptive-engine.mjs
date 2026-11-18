import {RangeEngine} from './range-engine.mjs';
import {Engine} from './engine.mjs';
import {adaptiveDirection} from './range-adaptive.mjs';
import {ADAPTIVE_MODEL} from './range-adaptive-model.mjs';
import {roundStart,simulateFill} from './strategy.mjs';

// Paper-only replacement. Live explicitly calls legacySignal(), never signal().
export class RangeAdaptiveEngine extends RangeEngine{
  constructor(store,venue,options={}){
    super(store,venue,{...options,modes:['paper']});this.adaptivePaper=true;this.decision=null;
    const a=store.account('paper'),config=this.fixedConfig(a.config);
    if(Object.keys(config).some(k=>config[k]!==a.config[k]))store.saveAccount({...a,config});
  }
  fixedConfig(c){return {...c,entryDelay:60,entryWindow:65,maxPrice:0.5,sameDirectionOnly:false,followPreviousAtOpen:false,reverseSignal:false};}
  executionAccount(projected){
    if(projected.mode!=='paper')return projected;
    const last=this.store.recentAdaptiveOutcomes(projected.session);
    const twoLosses=last.length===2&&last.every(o=>o.status==='lost'||(o.status==='open'&&o.predicted_won===0));
    if(!twoLosses&&projected.losses<2)return projected;
    return {...projected,stakeLosses:0,stakeProtection:'RA-01.1 连续两笔失利保护：按首笔金额投入，获胜后恢复正常序列'};
  }
  legacySignal(){return RangeEngine.prototype.signal.call(this);}
  signal(){
    const round=roundStart(this.now()),at=(round+60)*1000;
    const block=(code,message)=>({...((this.decision?.round===round)?this.decision:{}),direction:null,code,message});
    if(this.now()<at)return block('RA_WAIT','RA-01 等待开盘第 60 秒的固定决策点');
    if(this.now()>at+5000)return block('RA_CLOSED','RA-01 已超过第 65 秒，当前场次不再买入');
    if(!this.adaptiveSampler)return block('RA_NOT_READY','RA-01 历史采样服务尚未就绪');
    if(this.decision?.round!==round){
      const s=this.adaptiveSampler.sample(round,at);let direction=null,rule=null,message=s.error;
      if(s.f){
        rule=ADAPTIVE_MODEL.routes[s.f.regime+':'+s.f.zone]??null;direction=adaptiveDirection(s.f,rule);
        if(!rule)message=`${s.f.regime}/${s.f.zone} 未达到训练证据要求，本场空仓`;
        else if(!direction)message=rule==='streak'?`连续同向只有 ${s.f.streak} 场（${s.f.last}），需要至少 3 场，本场空仓`:!s.f.early?`第 60 秒报价 ${s.price} 等于起始价 ${s.opening}，本场空仓`:`本场 ${s.f.early} 与近 1 小时 ${s.f.trend} 不同向，本场空仓`;
        else message=`RA-01 ${s.f.regime}/${s.f.zone} → ${rule} → 买 ${direction}；第 60 秒报价 ${s.price}，起始价 ${s.opening}；近 1 小时趋势 ${s.f.trend}，连续 ${s.f.streak} 场 ${s.f.last}；区间位置 ${(s.f.position*100).toFixed(2)}%；成交价 ≤0.50，最晚第 65 秒，资金沿用原马丁序列`;
      }
      let code=direction?null:'RA_NO_SIGNAL';
      if(direction&&rule==='streak'&&direction!==s.f.early){
        message=s.f.early
          ? `RA-01.1 跳过：前 ${s.f.streak} 场连续 ${s.f.last}，反买方向为 ${direction}；本场第 60 秒报价 ${s.price} 相对起始价 ${s.opening} 为 ${s.f.early}，方向冲突`
          : `RA-01.1 跳过：连续同向反买方向为 ${direction}，本场第 60 秒报价 ${s.price} 与起始价 ${s.opening} 持平，未确认反转`;
        direction=null;code='RA_STREAK_NOT_CONFIRMED';
      }else if(direction&&rule==='streak'){
        message+=`；RA-01.1 第 60 秒涨跌已确认反买方向 ${direction}`;
      }
      this.decision={round,direction,code,message,rule,features:s.f??null,referencePrice:s.opening??null,signalPrice:s.price??null,decisionAt:at,directionRule:'adaptive_ra01'};
    }
    return this.decision;
  }
  entryGuard(){
    const s=this.signal();if(s.code)return s;
    if(this.spot?.windowSeconds!==60)return {code:'RA_ORACLE_WINDOW',message:'RA-01 仅验证过 60 秒预言机窗口，当前窗口不匹配'};
    if(!this.spot?.conditionId||this.spot.conditionId!==this.market?.conditionId)return {code:'RA_MARKET_MISMATCH',message:'当前官方报价与盘口场次不一致'};
    return null;
  }
  requiresCurrentOpening(){return true;}
  quote(book,budget,config,schedule){
    const at=(roundStart(this.now())+60)*1000;
    if(!Number.isFinite(book.fetchedAt)||book.fetchedAt<at||book.fetchedAt>this.now()+1000||this.now()-book.fetchedAt>3000)throw Object.assign(Error('RA-01 需要第 60 秒后获取且不超过 3 秒的盘口'),{code:'RA_BOOK_TIME'});
    return simulateFill(book,budget,{...config,maxPrice:0.5},schedule,{strictTicks:true,ignoreSlippage:true});
  }
  quoteGuard(){return this.entryGuard();}
  orderSignalFields(){const s=this.signal();return {entryReason:`RA-01.1｜${s.message}`,signalRule:'range_adaptive_ra01',referencePrice:s.referencePrice,signalPrice:s.signalPrice,adaptiveSignal:{modelHash:ADAPTIVE_MODEL.datasetHash,decisionAt:s.decisionAt,rule:s.rule,...s.features}};}
  configure(mode,input){if(mode!=='paper')throw Error('RA-01 仅支持模拟盘');const {rangeConfig,...trading}=input;return Engine.prototype.configure.call(this,mode,this.fixedConfig(trading));}
  snapshot(){
    const s=super.snapshot(),f=this.decision?.round===roundStart(this.now())?this.decision.features:null;
    return {...s,strategy:'range_adaptive_ra01',adaptiveExecution:true,adaptiveExecutionRevision:'RA-01.1',adaptiveModel:ADAPTIVE_MODEL.id,adaptiveLevels:f?{lower:f.lower,upper:f.upper,actualLower:f.lower,actualUpper:f.upper}:null};
  }
}
