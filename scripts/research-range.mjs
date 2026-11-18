import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {adaptiveFeatures,adaptiveDirection,evaluateSignals} from '../server/range-adaptive.mjs';

const output=existsSync('data/range-research/report.json')?'data/range-research/study-'+Date.now():'data/range-research';
if(output!=='data/range-research'&&!process.argv.includes('--new-study'))throw Error('已有冻结研究。需要新研究时显式使用 --new-study，结果写入新目录，不覆盖 RA-01 或旧留出样本。');
const db=new DatabaseSync('data/range.sqlite',{readOnly:true});db.exec('BEGIN');
const labels=db.prepare("SELECT round,result FROM round_history WHERE status='resolved' AND result IN ('UP','DOWN') ORDER BY round").all();
const openings=new Map(db.prepare('SELECT * FROM round_openings WHERE oracle_window=60').all().map(x=>[x.round,x]));
const bars=db.prepare('SELECT * FROM range_price_bars WHERE oracle_window=60 ORDER BY bucket').all();
const orders=db.prepare("SELECT round,direction,price,fee,cost,pnl,status,created_at FROM orders WHERE mode='paper' AND status IN ('won','lost') ORDER BY created_at").all();db.exec('COMMIT');db.close();
const rounds=new Map;for(const b of bars){const round=Math.floor(b.bucket/300000)*300;if(!rounds.has(round))rounds.set(round,[]);rounds.get(round).push(b);}
const completed=new Map;for(const [round,a] of rounds){if(a[0].first_at>round*1000+10000||a.at(-1).last_at<(round+300)*1000-10000)continue;completed.set(round,{round,open:a[0].open,close:a.at(-1).close});}
const dataset=[];for(const target of labels){
  const history=Array.from({length:48},(_,i)=>completed.get(target.round-(48-i)*300));if(history.some(x=>!x))continue;
  const opening=openings.get(target.round);if(!opening)continue;
  const features={};for(const seconds of [5,15,30,60]){const at=(target.round+seconds)*1000;if(opening.observed_at>at)continue;const bar=rounds.get(target.round)?.findLast(x=>x.last_at<=at&&x.last_at>=at-6000);if(!bar)continue;const f=adaptiveFeatures(history,opening.open_price,bar.close);if(f)features[seconds]=f;}
  if(Object.keys(features).length)dataset.push({round:target.round,outcome:target.result,features});
}
const a=Math.floor(dataset.length*.6),b=Math.floor(dataset.length*.8),train=dataset.slice(0,a),validation=dataset.slice(a,b),test=dataset.slice(b);
const rules=['early','fade','trend','majority','streak','edge','aligned'];
const choose=(model,r)=>{const f=r.features[model.seconds];if(!f||f.move<model.minMove)return null;return adaptiveDirection(f,model.routes[f.regime+':'+f.zone]);};
const models=[];for(const seconds of [5,15,30,60])for(const minMove of [0,0.25,0.5]){
  const routes={};for(const regime of ['trend','range','mixed'])for(const zone of ['below','support','middle','resistance','above']){
    const subset=train.filter(r=>r.features[seconds]?.regime===regime&&r.features[seconds]?.zone===zone&&r.features[seconds].move>=minMove);
    const ranked=rules.map(rule=>({rule,...evaluateSignals(subset,r=>adaptiveDirection(r.features[seconds],rule))})).filter(x=>x.n>=30&&x.interval95[0]>=.5).sort((a,b)=>b.interval95[0]-a.interval95[0]);
    if(ranked[0])routes[regime+':'+zone]=ranked[0].rule;
  }
  const model={seconds,minMove,routes};models.push({...model,train:evaluateSignals(train,r=>choose(model,r)),validation:evaluateSignals(validation,r=>choose(model,r))});
}
// Select on validation only. The final chronological holdout is evaluated exactly once.
models.sort((a,b)=>(b.validation.n>=100?b.validation.interval95[0]:0)-(a.validation.n>=100?a.validation.interval95[0]:0));const selected=models[0];
const report={createdAt:new Date().toISOString(),data:{labels:labels.length,usable:dataset.length,first:dataset[0]?.round,last:dataset.at(-1)?.round,hash:createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),split:{train:train.length,validation:validation.length,test:test.length},validationStart:validation[0]?.round,testStart:test[0]?.round},baseline:{orders:orders.length,wins:orders.filter(x=>x.pnl>0).length,pnl:orders.reduce((s,x)=>s+x.pnl,0)},selected:{...selected,test:evaluateSignals(test,r=>choose(selected,r))},candidates:models,baselineSignals:rules.map(rule=>({rule,train:evaluateSignals(train,r=>adaptiveDirection(r.features[5],rule)),validation:evaluateSignals(validation,r=>adaptiveDirection(r.features[5],rule))})),limitations:['方向研究，不是可成交订单回测；缺少所有历史双边盘口，无法据此证明净盈利或实际成交胜率。','以保存的首个官方起始价 observed_at 和已结束 5 秒桶采样时间约束特征，原始桶没有独立网络接收时间，存在历史行情可用时间误差。','仅约一周样本，按时间 60/20/20 切分；最后 20% 不用于选模型。分区样本少的状态跳过。','趋势指标用此前连续 48 场实时同源报价端点；支撑压力采用其中除最近 15 分钟外的端点极值。非完整复刻旧策略。']};
mkdirSync(output,{recursive:true});writeFileSync(output+'/dataset.json',JSON.stringify(dataset));writeFileSync(output+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({data:report.data,baseline:report.baseline,selected:report.selected,candidates:models.map(m=>({seconds:m.seconds,minMove:m.minMove,train:m.train.winRate,val:m.validation.winRate,n:m.validation.n}))},null,2));
