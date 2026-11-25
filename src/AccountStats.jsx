import React from 'react';
import {Wallet,BarChart3,Gauge,Layers3} from 'lucide-react';
const fmt=(n,digits=2)=>n==null||!Number.isFinite(Number(n))?'—':Number(n).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits});
const cash=n=>n==null?'—':'$'+fmt(n);
const signed=n=>n==null?'—':(n>=0?'+':'−')+'$'+fmt(Math.abs(n));

export default function AccountStats({account,live=false,state}){
  const balances=live?state?.live.balance:account?.balance,pnl=account?.pnl||0,sequenceLosses=account?.projectedLosses??account?.losses??0;
  return <section className="stats-grid">
          <Stat icon={Wallet} title={live ? '钱包可用余额' : '模拟可用余额'} value={cash(balances)}><span className="subtle">{live ? (state?.live.balanceAt ? `更新于 ${new Date(state.live.balanceAt).toLocaleTimeString('zh-CN')}` : '连接钱包后读取') : `初始资金 ${cash(account?.startingBalance ?? account?.config.initialBalance)}`}</span><span className="unit-tag">pUSD</span></Stat>
          <Stat icon={BarChart3} title="累计净盈亏" value={signed(pnl)} positive={pnl >= 0}><span className="subtle">{live ? '按成交与市场费率估算' : '已结算交易 · 已计入估算手续费'}</span>{!live && account?.settled > 0 && <span className="stat-percent">{fmt(pnl / (account.startingBalance ?? account.config.initialBalance) * 100)}%</span>}</Stat>
          <Stat icon={Gauge} title="策略胜率" value={account?.settled ? `${fmt(account.wins / account.settled * 100, 1)}%` : '—'}><span className="subtle"><span className="green">{account?.wins || 0} 胜</span><span className="slash">/</span>{(account?.settled || 0) - (account?.wins || 0)} 负</span><span className="subtle">共 {account?.settled || 0} 场</span></Stat>
          <Stat icon={Layers3} title="下一笔投入" value={cash(account?.nextAmount)}><span className="subtle">{sequenceLosses ? `${account?.projectedCount ? '预计连败' : '连续失利'} ${sequenceLosses} 场` : '首笔金额 · 等待入场'}</span><span className="multiplier">{account?.stakeIncrement?'×2+5':`${2 ** sequenceLosses}×`}</span></Stat>
        </section>;
}

function Stat({ icon: Icon, title, value, children, positive }) {
  return <div className="stat-card"><div className="stat-label">{title}<Icon size={16}/></div><div className={`stat-value ${positive === true ? 'green' : positive === false ? 'red' : ''}`}>{value}</div><div className="stat-bottom">{children}</div></div>;
}

