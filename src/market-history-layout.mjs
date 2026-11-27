export const MARKET_STREAK_MIN=5;

export function arrangeMarketHistory(items,dayStart){
  const hours=new Map(),streaks=new Map();
  const longestDirections=new Set();
  let longestLength=0;
  let streak=[];
  const finishStreak=()=>{
    if(streak.length&&streak.length>=longestLength){
      if(streak.length>longestLength)longestDirections.clear();
      longestLength=streak.length;
      longestDirections.add(streak[0].result);
    }
    if(streak.length>=MARKET_STREAK_MIN){
      for(const item of streak)streaks.set(item.round,streak.length);
    }
    streak=[];
  };

  for(const item of [...items].sort((a,b)=>a.round-b.round)){
    const hour=Math.floor((item.round-dayStart)/3600);
    if(!hours.has(hour))hours.set(hour,[]);
    hours.get(hour).push(item);

    const hasDirection=item.verifiedAt!=null&&(item.result==='UP'||item.result==='DOWN');
    const previous=streak.at(-1);
    if(previous&&(!hasDirection||previous.end!==item.round||previous.result!==item.result))finishStreak();
    if(hasDirection)streak.push(item);
  }
  finishStreak();
  return {hours:[...hours].reverse().map(([hour,group])=>[hour,group.reverse()]),streaks,
    longest:{length:longestLength,directions:['UP','DOWN'].filter(direction=>longestDirections.has(direction))}};
}
