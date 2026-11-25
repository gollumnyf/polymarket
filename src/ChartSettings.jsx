import React,{useEffect,useState} from 'react';
import {apiPath} from './api.mjs';

export default function ChartSettings({disabled,onSave,independent=false}){
  const [draft,setDraft]=useState({}),[saved,setSaved]=useState(null),[error,setError]=useState(null);
  useEffect(()=>{
    const abort=new AbortController();
    fetch(apiPath('chart-settings'),{cache:'no-store',signal:abort.signal}).then(res=>{
      if(!res.ok)throw new Error('暂时无法读取图表设置');
      return res.json();
    }).then(value=>{if(!abort.signal.aborted){setDraft(value);setSaved(value);}})
      .catch(error=>{if(!abort.signal.aborted)setError(error.message);});
    return ()=>abort.abort();
  },[]);
  const changed=saved?Object.fromEntries(Object.entries(draft).filter(([key,value])=>Number(value)!==saved[key]).map(([key,value])=>[key,Number(value)])):{};
  return <form onSubmit={async event=>{
    event.preventDefault();
    if(await onSave(changed))setSaved({...saved,...changed});
  }}>
    <div className="settings-grid">
      <label>支撑位 / 压力位回看时间<div className="setting-input"><input required type="number" min={15} max={1440} step={5} value={draft.levelLookbackMinutes??''} disabled={disabled||saved==null} onChange={event=>setDraft({...draft,levelLookbackMinutes:event.target.value})}/><span>分钟</span></div></label>
      <label>中间蓝色区域占比<div className="setting-input"><input required type="number" max={100} step="any" value={draft.middlePercent??''} disabled={disabled||saved==null} onChange={event=>setDraft({...draft,middlePercent:event.target.value})}/><span>%</span></div></label>
    </div>
    <p className="modal-copy">{error||(independent?'本模拟盘独立保存。支撑位和压力位用于下单过滤，中间蓝色占比仅用于显示。修改前暂停策略并等待持仓结算；回看最短15分钟，按5分钟K线计算。':'两盘共用，仅影响图表。默认 60 分钟，最短 15 分钟，按 5 分钟 K 线计算。蓝色占比须大于 0%、不超过 100%，剩余区域上下各一半。')}</p>
    <button className="button secondary" disabled={disabled||saved==null||Object.keys(changed).length===0}>保存图表设置</button>
  </form>;
}
