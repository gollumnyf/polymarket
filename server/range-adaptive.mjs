// Pure, causal features shared by historical research and forward observation.
export function adaptiveFeatures(history,opening,price){
  if(history.length!==48||!(opening>0&&price>0)||history.some((x,i)=>![x.open,x.close].every(v=>Number.isFinite(v)&&v>0)||(i>0&&x.round!==history[i-1].round+300)))return null;
  const recent=history.slice(-12),bodies=recent.map(x=>x.close-x.open),noise=bodies.reduce((s,x)=>s+Math.abs(x),0)/12;
  if(!(noise>0))return null;
  // Reference boundaries exclude the nearest 15 minutes, as in the existing range policy.
  const levels=history.slice(0,-3),lower=Math.min(...levels.map(x=>Math.min(x.open,x.close))),upper=Math.max(...levels.map(x=>Math.max(x.open,x.close)));
  if(!(upper>lower))return null;
  const net=recent.at(-1).close-recent[0].open,efficiency=Math.abs(net)/(noise*12),position=(price-lower)/(upper-lower);
  const trend=net>=0?'UP':'DOWN',early=price>opening?'UP':price<opening?'DOWN':null;
  const zone=position<0?'below':position<=0.2?'support':position>=1?'above':position>=0.8?'resistance':'middle';
  const regime=efficiency>=0.3?'trend':efficiency<=0.15?'range':'mixed';
  let streak=1;const last=history.at(-1).close>=history.at(-1).open?'UP':'DOWN';for(let i=46;i>=0;i--){if((history[i].close>=history[i].open?'UP':'DOWN')!==last)break;streak++;}
  return {regime,zone,trend,early,position,efficiency,noise,move:Math.abs(price-opening)/noise,lower,upper,streak,last,majority:bodies.filter(x=>x>=0).length>=6?'UP':'DOWN'};
}
const inverse=d=>d==='UP'?'DOWN':d==='DOWN'?'UP':null;
export function adaptiveDirection(f,rule){
  if(!f)return null;
  if(rule==='early')return f.early;
  if(rule==='fade')return inverse(f.early);
  if(rule==='trend')return f.trend;
  if(rule==='majority')return f.majority;
  if(rule==='streak')return f.streak>=3?inverse(f.last):null;
  if(rule==='edge')return ['support','below'].includes(f.zone)?'UP':['resistance','above'].includes(f.zone)?'DOWN':null;
  if(rule==='aligned')return f.early===f.trend?f.early:null;
  return null;
}
export function wilson(wins,n){if(!n)return [0,1];const z=1.96,p=wins/n,d=1+z*z/n,mid=(p+z*z/(2*n))/d,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [mid-half,mid+half];}
export function evaluateSignals(rows,choose){
  let wins=0,n=0,streak=0,maxLossStreak=0;const byDay={};
  for(const r of rows){const d=choose(r);if(!d)continue;n++;const won=d===r.outcome;wins+=Number(won);streak=won?0:streak+1;maxLossStreak=Math.max(maxLossStreak,streak);const day=new Date((r.round+8*3600)*1000).toISOString().slice(0,10);const bucket=byDay[day]??={n:0,wins:0};bucket.n++;bucket.wins+=Number(won);}
  return {n,wins,losses:n-wins,winRate:n?wins/n:null,coverage:rows.length?n/rows.length:0,interval95:wilson(wins,n),maxLossStreak,byDay};
}
