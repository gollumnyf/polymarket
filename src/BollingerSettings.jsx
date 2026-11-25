import React,{useEffect,useState} from 'react';
import {validateBollinger} from './bollinger.mjs';

export default function BollingerSettings({config,disabled,onSave}){
  const [draft,setDraft]=useState(config),[error,setError]=useState('');
  useEffect(()=>setDraft(config),[config.enabled,config.period,config.deviations,config.intervalSeconds]);
  return <form className="bollinger-settings" onSubmit={async event=>{
    event.preventDefault();setError('');
    try{await onSave(validateBollinger(draft));}catch(error){setError(error.message);}
  }}>
    <h3>布林线参数</h3>
    <div className="settings-grid">
      <label>显示布林线<select value={String(draft.enabled)} disabled={disabled} onChange={event=>setDraft({...draft,enabled:event.target.value==='true'})}><option value="true">显示</option><option value="false">隐藏</option></select></label>
      <label>K线时长<select value={draft.intervalSeconds} disabled={disabled} onChange={event=>setDraft({...draft,intervalSeconds:Number(event.target.value)})}>{[[15,'15 秒'],[30,'30 秒'],[60,'1 分钟'],[300,'5 分钟']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label>布林线周期<div className="setting-input"><input type="number" required min={2} max={200} step={1} value={draft.period} disabled={disabled} onChange={event=>setDraft({...draft,period:event.target.value===''?'':Number(event.target.value)})}/><span>根</span></div></label>
      <label>标准差倍数<div className="setting-input"><input type="number" required min={0.1} max={10} step="any" value={draft.deviations} disabled={disabled} onChange={event=>setDraft({...draft,deviations:event.target.value===''?'':Number(event.target.value)})}/><span>倍</span></div></label>
    </div>
    <p className="modal-copy">{error||'仅用于本模拟盘图表，不参与交易判断。中轨为收盘价均值，上下轨为均值 ± 倍数 × 总体标准差；当前未收盘K线实时更新，缺失K线或预言机口径变化后重新积累。运行中也可保存。'}</p>
    <button className="button secondary" disabled={disabled}>保存布林线参数</button>
  </form>;
}
