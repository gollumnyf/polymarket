import React,{useState} from 'react';
import {Info,ShieldCheck,Check} from 'lucide-react';
import {ENTRY_MODES,entryMode,withEntryMode} from './entry-mode.mjs';

export default function Settings({account,mode,busy,pending,onSave,momentum=false,rangeMode=false,rangeConfig}) {
  const [config,setConfig]=useState({...account.config});
  const [rangeDraft,setRangeDraft]=useState({lookbackHours:rangeConfig?.lookbackHours??2,levelLookbackHours:rangeConfig?.levelLookbackHours??4,breakoutPercent:rangeConfig?.breakoutPercent??0.1,breakoutRounds:rangeConfig?.breakoutRounds??2});
  const [entryMinutes,setEntryMinutes]=useState(Number((account.config.entryWindow/60).toFixed(4)));
  const locked=account.running||pending;
  const followRange=rangeMode&&mode==='live';
  const selected=ENTRY_MODES.find(item=>item.value===entryMode(config));
  const fields=[['baseAmount','首笔投入','pUSD',1,100000,'.01'],['maxAmount','单笔金额上限','pUSD',1,1000000,'.01'],['maxDoublings','最大加倍次数','次',0,16,1],['stopLoss','累计亏损上限','pUSD',1,1000000,'.01'],['entryDelay','开盘后入场延迟','秒',0,240,1],['entryWindow','开盘后入场截止','秒',1,285,1],['slippage','相对卖一价最大滑点','%',0,20,'.1'],['maxPrice','每份最高买入价','pUSD','.01','.99','.01']];
  if(momentum||rangeMode){for(const key of ['entryDelay','maxPrice'])fields.splice(fields.findIndex(field=>field[0]===key),1);fields.find(field=>field[0]==='entryWindow')[4]=299;}
  if(rangeMode){const field=fields.find(field=>field[0]==='entryWindow');field[1]='开盘后检测时长';field[2]='分钟';field[3]=1/60;field[4]=299/60;field[5]='any';}
  if(mode==='paper')fields.push(['initialBalance','重置后的模拟初始资金','pUSD',1,10000000,'.01']);
  return <form onSubmit={event=>{event.preventDefault();onSave(rangeMode?{...withEntryMode({...config,entryWindow:Math.round(Number(entryMinutes)*60)},'independent'),rangeConfig:rangeDraft}:withEntryMode(config,selected.value));}}>
    {rangeMode?<label className="entry-mode-setting">入场规则<select value="range_regime" disabled><option value="range_regime">稳定区间固定方向 / 突破跟随 · 买价 &lt; 0.50</option></select><small>开盘立即检测，截止开盘后 {entryMinutes||'—'} 分钟。每场结束重算近 {rangeDraft.levelLookbackHours||'—'} 小时的5 分钟实体 K 线最高/最低价。当前价格在上下界内即为区间内，无需往返、触及或宽度确认；按近 {rangeDraft.lookbackHours||'—'} 小时五分钟场次多数方向首次选向，同票取上一场反方向，区间内锁定沿用。贴近压力位买 DOWN、贴近支撑位买 UP。突破须截至上一场连续 {rangeDraft.breakoutRounds} 场收盘超过同一参考边界，且距离严格超过参考区间宽度的 {rangeDraft.breakoutPercent}%；中间缺失、回落或反向均中断连续计数；确认期间固定参考上下界，未确认继续边界反向，确认后顺向买入。</small></label>:momentum?<label className="entry-mode-setting">入场规则<select value="official_momentum" disabled><option value="official_momentum">官方价格同向 · 买价 ≤ 0.50</option></select><small>零延迟等待首个符合条件的新鲜官方报价。本场方向与最近两笔价格的方向一致才买入；持平、冲突均继续等待。使用官方卖盘成交，最高 0.50，检查 tick、最小份额和实际深度。</small></label>:<label className="entry-mode-setting">入场规则<select value={selected.value} disabled={locked||busy} onChange={event=>setConfig(withEntryMode(config,event.target.value))}>{ENTRY_MODES.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select><small>{selected.description}{['same_direction','follow_previous'].includes(selected.value)&&'上一场方向使用平台起止价或同源末秒价预测。'}所有模式均需有效盘口并通过风控。</small></label>}
    <p className="modal-copy">{rangeMode?(followRange?'区间突破实盘':'区间突破模拟盘'):momentum?'官方同向模拟盘':mode==='paper'?'模拟盘':'实盘'}资金参数独立保存。{!momentum&&!rangeMode&&'四种模式均按开盘后入场延迟执行，'}每场最多买入一次，任意一场获胜即恢复首笔金额。</p>
    {followRange&&<p className="modal-copy">区间参数、检测时长和方向信号跟随区间突破模拟；请在模拟盘中修改。实盘首笔金额、风控及马丁资金序列独立。</p>}
    {locked&&<p className="settings-warning"><Info size={15}/>请先暂停策略并等待持仓结算，再修改参数。</p>}
    {rangeMode&&<div className="settings-grid">{[['lookbackHours','方向统计小时数','小时',1,24,1],['levelLookbackHours','历史区间小时数','小时',1,24,1],['breakoutPercent','突破距离 / 区间宽度','%',0,100,'any'],['breakoutRounds','连续突破确认场数','场',1,48,1]].map(([key,label,unit,min,max,step])=><label key={key}>{label}<div className="setting-input"><input required type="number" min={min} max={max} step={step} disabled={locked||busy||followRange} value={rangeDraft[key]} onChange={event=>setRangeDraft({...rangeDraft,[key]:event.target.value===''?'':Number(event.target.value)})}/><span>{unit}</span></div></label>)}</div>}
    <div className="settings-grid">{fields.map(([key,label,unit,min,max,step])=><label key={key}>{label}<div className="setting-input"><input required type="number" min={min} max={max} step={step} value={rangeMode&&key==='entryWindow'?entryMinutes:config[key]} disabled={locked||busy||(followRange&&key==='entryWindow')} onChange={event=>rangeMode&&key==='entryWindow'?setEntryMinutes(event.target.value):setConfig({...config,[key]:event.target.value===''?'':Number(event.target.value)})}/><span>{unit}</span></div></label>)}</div>
    <div className="settings-summary"><ShieldCheck size={16}/><p>单笔金额超限时恢复首笔并开始新轮。错误不会自动暂停策略；达到最大加倍次数、累计止损或余额不足时跳过本次买入，持续检查，条件恢复后继续。参数修改保留当前连败次数。{mode==='paper'&&'修改初始模拟资金后，需重置模拟账户才能生效。'}</p></div>
    <button className="button primary" disabled={busy||locked}><Check size={16}/>保存策略参数</button>
  </form>;
}
