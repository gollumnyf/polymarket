import {EventEmitter} from 'node:events';
import {ROUND_SECONDS,roundStart} from './strategy.mjs';

export class ChartRange extends EventEmitter {
  constructor(source,feed,{now=Date.now}={}){
    super();this.source=source;this.feed=feed;this.now=now;
    this.ready=null;this.sample=null;this.published=null;
  }
  current(){
    const round=roundStart(this.now()),window=this.feed.round===round?this.feed.spec?.seconds:null;
    const ready=this.ready;
    if(!ready||(window!=null&&ready.window!==window))return {round,zone:null};
    if(ready.round===round)return {round,zone:ready.zone};
    if(ready.round===round-ROUND_SECONDS)return {round,zone:{...ready.zone,fallbackFrom:ready.round}};
    return {round,zone:null};
  }
  poll(canAnalyze){
    const now=this.now(),round=roundStart(now),window=this.feed.round===round?this.feed.spec?.seconds:null;
    const spot=this.source.spot,bucket=Math.floor(now/5000);
    if(canAnalyze&&window!=null&&spot?.round===round&&spot.windowSeconds===window&&this.sample!==bucket){
      this.sample=bucket;
      const {candidate,config}=this.source.analysis();
      if(candidate?.levelAnalysis?.ready&&Number.isFinite(candidate.lower)&&Number.isFinite(candidate.upper)&&candidate.upper>candidate.lower){
        this.ready={round,window,zone:{lower:candidate.lower,upper:candidate.upper,edgePercent:config.edgePercent,phase:'reference'}};
      }
    }
    const value=this.current(),key=JSON.stringify(value);
    if(key!==this.published){this.published=key;this.emit('range',value);}
  }
}
