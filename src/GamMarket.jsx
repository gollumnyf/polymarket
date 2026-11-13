import React,{useState} from 'react';
import {ArrowDown,ArrowUp,Clock3,ExternalLink} from 'lucide-react';
import PriceChart from './PriceChart.jsx';
import HistoricalRounds from './HistoricalRounds.jsx';

const money=value=>Number.isFinite(value)?`${value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`:'—';
const time=value=>new Date(value).toLocaleTimeString('zh-CN',{hour12:false});

export default function GamMarket({state,now,connected}){
  const [range,setRange]=useState('round');
  const round=Math.floor(now/300000)*300,left=Math.max(0,Math.ceil(round+300-now/1000));
  const spot=state?.spot?.round===round?state.spot:null;
  const fresh=connected&&spot&&now-spot.at<=6000&&!state?.errors?.spot;
  const books=connected&&state?.market?.round===round&&now-state.market.fetchedAt<22000&&!state?.errors?.market?state?.books:{};
  const bookFresh=direction=>books?.[direction]&&now-books[direction].fetchedAt<8000&&!state?.errors?.books;
  return <section className="panel market-panel">
    <div className="market-heading"><div className="market-identity"><span className="bitcoin">₿</span><div><h2>Bitcoin <span>UP / DOWN</span></h2><p>BTC 公允价值与盘口 · 5 分钟市场</p></div></div><a className="round-link" href={`https://polymarket.com/event/btc-updown-5m-${round}`} target="_blank" rel="noreferrer">{time(round*1000)} – {time((round+300)*1000)} <ExternalLink size={13}/></a></div>
    <div className="round-timing"><span className="active-label"><i/>当前场次</span><span className="round-slug">#{round}</span><span className="countdown"><Clock3 size={14}/>距离结束 <strong>{String(Math.floor(left/60)).padStart(2,'0')}:{String(left%60).padStart(2,'0')}</strong></span></div>
    <div className="round-progress"><span style={{width:`${(300-left)/3}%`}}/></div>
    <HistoricalRounds momentum round={round} mode="paper" entryDelay={state?.accounts?.paper?.config?.entryDelay??0}/>
    <div className="chart-toolbar"><div><span className="mini-label">BTC 官方参考价 <span className="price-source">{spot?.windowSeconds?`CHAINLINK TWAP ${spot.windowSeconds}s`:'CHAINLINK'}</span></span><div className="btc-value">{money(spot?.price)}</div><div className="price-caption round-change-caption"><span>本场起始 {money(spot?.currentOpen)}</span><span>本场涨跌 {Number.isFinite(spot?.change)?<b className={spot.change>=0?'green':'red'}>{spot.change>=0?'↑ 上涨':'↓ 下跌'} {money(Math.abs(spot.change))}</b>:'待公布'}</span>{spot&&!fresh&&<b>数据待更新</b>}</div></div><div className="chart-range">{[['round','本场'],['30m','近 30 分钟']].map(([value,label])=><button key={value} className={range===value?'active':''} onClick={()=>setRange(value)}>{label}</button>)}</div></div>
    <PriceChart ticks={state?.ticks||[]} reference={spot?.currentOpen??null} start={round} now={now} range={range}/>
    <div className="chart-legend"><span><i className="legend-price"/>Chainlink 实时参考价</span><span><i className="legend-reference"/>本场起始价 <b>{money(spot?.currentOpen)}</b></span><span className="update-time">{fresh?<><i className="live-dot"/>Polymarket 实时流</>:'等待数据连接'}</span></div>
    <div className="outcome-grid">{[['UP','看涨',ArrowUp],['DOWN','看跌',ArrowDown]].map(([direction,label,Icon])=><div key={direction} className={`outcome ${direction.toLowerCase()}`}><span className="outcome-arrow"><Icon size={20}/></span><div><strong>{label} <span>{direction}</span></strong><small>{bookFresh(direction)?'买一 '+(Number(books[direction].bids?.[0]?.price||0)*100).toFixed(1)+'¢':'等待实时盘口'}</small></div><div className="outcome-price">{bookFresh(direction)&&books[direction].asks?.[0]?(Number(books[direction].asks[0].price)*100).toFixed(1):'—'}<span>卖一价格</span></div></div>)}</div>
  </section>;
}
