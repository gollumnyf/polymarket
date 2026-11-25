import React,{useEffect,useMemo,useState} from 'react';
import PriceChart from './PriceChart.jsx';
import {apiPath} from './api.mjs';
import {mergeChartPrices} from './chart-prices.mjs';
import {bollingerBands} from './bollinger.mjs';

const fmt=n=>n==null?'—':n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
export default function BollingerChart({bollinger,onSettings,...props}){
  const [seed,setSeed]=useState(null),[error,setError]=useState('');
  const key=`${bollinger.period}:${bollinger.intervalSeconds}`;
  const window=props.ticks.at(-1)?.oracleWindow;
  useEffect(()=>{
    if(!bollinger.enabled)return;
    const abort=new AbortController();let timer;
    const load=async()=>{
      let delay=60000;
      try{
        if(document.hidden)return;
        const response=await fetch(apiPath('bollinger-history'),{signal:abort.signal,cache:'no-store'});
        if(response.status===202){delay=2000;return;}
        if(!response.ok)throw Error('暂时无法读取布林线历史，稍后重试');
        const data=await response.json();
        if(data.repair?.missing>0)delay=2000;
        if(!abort.signal.aborted){setSeed({key,...data});setError('');}
      }catch(error){if(!abort.signal.aborted){setError(error.message);delay=15000;}}
      finally{if(!abort.signal.aborted)timer=setTimeout(load,delay);}
    };
    void load();
    return ()=>{abort.abort();clearTimeout(timer);};
  },[key,bollinger.enabled,window]);
  const bands=useMemo(()=>{
    const saved=seed?.key===key&&(!Number.isFinite(window)||seed.oracleWindow===window)?seed.points:[];
    const prices=mergeChartPrices(saved,props.ticks);
    return bollingerBands(prices,bollinger,props.now);
  },[seed,key,window,props.ticks,bollinger.enabled,bollinger.period,bollinger.deviations,bollinger.intervalSeconds,props.now]);
  const last=bands.at(-1);
  const repair=seed?.key===key?seed.repair:null;
  return <>
    <div className="bollinger-legend"><strong>BOLL ({bollinger.period}, {bollinger.deviations}) · {bollinger.intervalSeconds<60?`${bollinger.intervalSeconds}秒`:`${bollinger.intervalSeconds/60}分钟`}</strong>
      {bollinger.enabled?<><span className="bollinger-upper">上轨 {fmt(last?.upper)}</span><span className="bollinger-middle">中轨 {fmt(last?.middle)}</span><span className="bollinger-lower">下轨 {fmt(last?.lower)}</span>{repair?.missing>0?<span>{repair.state==='retrying'?`补数重试：${repair.error}；`:repair.state==='waiting_for_opening'?'开盘保护，稍后补数；':''}正在补齐官方K线 {repair.available}/{repair.expected}</span>:!last&&<span>{error||`等待 ${bollinger.period} 根连续K线`}</span>}</>:<span>已隐藏</span>}
      <button className="text-button" onClick={onSettings}>配置布林线</button>
    </div>
    <PriceChart {...props} bands={bands} bandIntervalSeconds={bollinger.intervalSeconds}/>
  </>;
}
