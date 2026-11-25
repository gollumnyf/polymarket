import React from 'react';
import {stakeAmount} from './stake-amount.mjs';
import {SlidersHorizontal,Layers3,Check,Info,ShieldCheck,Settings2,LoaderCircle,CirclePause,Play,ChevronRight} from 'lucide-react';
const fmt=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const cash=n=>n==null?'—':'$'+fmt(n);
const signed=n=>n==null?'—':(n>=0?'+':'−')+'$'+fmt(Math.abs(n));

export default function StrategyControl({account,busy,connected,token,live=false,authenticated=false,base,baseLocked,baseDirty,setEditingBase,setBase,onSettings,onToggle,title,entryTime,entryMode,adaptive=false}){
  const sequenceLosses=account?.stakeStep??account?.projectedLosses??account?.losses??0;
  const protectedStake=adaptive&&account?.stakeProtected;
  const increment=account?.stakeIncrement??0;
  return <aside className="strategy-column">
          <section className="panel strategy-panel"><div className="panel-heading"><h2><SlidersHorizontal size={17}/>策略控制</h2><span className="version-tag">{'MARTINGALE'}</span></div><div className="strategy-name"><span className="strategy-symbol"><Layers3 size={20}/></span><div><strong>{title}</strong><small>{increment?'失利 ×2+5 · 获胜复位':adaptive?'只加倍一次 · 两连亏回首笔':'亏损加倍 · 获胜复位'}</small></div><span className="strategy-check"><Check size={14}/></span></div>
            <div className="amount-field">
              <label htmlFor="baseAmount">{'首笔投入金额'} <Info size={12}/></label>
              <div className="amount-input"><span>$</span><input id="baseAmount" type="number" min="1" step="0.01" value={baseLocked ? String(account.config.baseAmount) : base} onFocus={() => setEditingBase(true)} onChange={e => setBase(e.target.value)} disabled={busy || !account || baseLocked}/><span>pUSD</span></div>
              {baseDirty && !baseLocked ? <p className="amount-hint">启动时自动保存并使用输入金额。</p> : account && <p className="amount-hint">生效首笔 {cash(account.config.baseAmount)} · 下一笔 {cash(account.nextAmount)}</p>}
            </div>
            <div className="strategy-details"><div><span>{increment?'失利后金额':'加倍倍数'}</span><strong>{increment?'上一笔 × 2 + 5':<>2.0 <span>×</span></>}</strong></div><div><span>入场时间</span><strong>{entryTime}</strong></div><div><span>单场买入次数</span><strong>{'1 次'} <ShieldCheck size={12}/></strong></div><div><span>入场模式</span><strong>{entryMode}</strong></div><div><span>{'预计获胜后'}</span><strong className="green">{'恢复首笔金额'}</strong></div></div>
            {onSettings&&<button className="advanced-button" onClick={onSettings}>高级参数与风险限额 <Settings2 size={14}/></button>}
            <div className="strategy-state"><span className={`state-dot ${account?.running ? 'running' : ''}`}/><strong>{account?.running ? '策略运行中' : '策略已暂停'}</strong><span>{account?.running ? 'RUNNING' : 'STANDBY'}</span></div>
            {account?.projectedCount > 0 && <p className="amount-hint">按预计结果续投 · {account.projectedCount} 笔待官方结算</p>}
            <button className={`button primary start-button ${account?.running ? 'stop' : ''}`} disabled={busy || !connected || !account || !token || (live && !authenticated)} onClick={onToggle}>{busy ? <LoaderCircle className="spinning" size={17}/> : account?.running ? <CirclePause size={17}/> : <Play size={16} fill="currentColor"/>}{account?.running ? '暂停策略' : `启动${live ? '实盘' : '模拟'}交易`}</button>
            <div className="execution-note"><ShieldCheck size={12}/>{live ? '使用真实资金，启动前请确认参数' : '仅使用模拟资金，不产生真实订单'}</div>
          </section>

          <section className="panel cycle-panel"><div className="panel-heading"><h2>{'本轮资金序列'}</h2><span className="subtle">{<>第 {account?.projectedCycle ?? account?.cycle ?? 1} 轮</>}</span></div><div className="sequence">{adaptive?[0,1,0,0].map((step,i)=><React.Fragment key={i}>{i>0&&<ChevronRight size={12}/>}<div className={`sequence-step ${i===(protectedStake?2:sequenceLosses)?'current':''}`}><span>{cash((account?.config.baseAmount||10)*2**step)}</span><small>{i===(protectedStake?2:sequenceLosses)?'下一笔':i>1?'保护期':`${2**step}×`}</small></div></React.Fragment>):Array.from({ length: 4 }, (_, index) => { const step = Math.max(0, sequenceLosses - 2) + index; return <React.Fragment key={step}>{index > 0 && <ChevronRight size={12}/>}<div className={step === sequenceLosses ? 'sequence-step current' : step < sequenceLosses ? 'sequence-step past' : 'sequence-step'}><span>{cash(stakeAmount(account?.config.baseAmount ?? 10,step,increment))}</span><small>{step === sequenceLosses ? '下一笔' : increment?`第 ${step+1} 笔`:`${2 ** step}×`}</small></div></React.Fragment>; })}</div><div className="cycle-footer"><span>{account?.projectedCount ? '已结算序列盈亏' : '本轮已实现盈亏'}</span><strong className={account?.cyclePnl < 0 ? 'red' : ''}>{signed(account?.cyclePnl || 0)}</strong></div></section>
          <div className="risk-note"><Info size={15}/><p>{adaptive?'连亏两笔后按首笔金额继续，直至获胜；优先用官方结果，待结算用预计结果。金额、余额和止损限制仍生效。':'连败时投入将指数增长。单场获胜不保证覆盖累计亏损，单笔超限会恢复首笔继续；其他限额触发时跳过本次买入并持续检查；错误不会自动暂停。'}</p></div>
        </aside>;
}
