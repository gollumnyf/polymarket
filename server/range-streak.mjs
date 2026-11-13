// Only adjacent completed market rounds count. Orders and account PnL are irrelevant.
export function streakEvidence(lastRound,count,outcome){
  const samples=Array.from({length:count},(_,i)=>outcome(lastRound-(count-1-i)*300));
  const marketDirection=samples[0]?.outcome;
  const valid=['UP','DOWN'].includes(marketDirection)&&samples.every((sample,i)=>sample?.round===lastRound-(count-1-i)*300&&sample.outcome===marketDirection);
  return {firstRound:lastRound-(count-1)*300,lastRound,roundsRequired:count,marketDirection:valid?marketDirection:null,direction:valid?(marketDirection==='UP'?'DOWN':'UP'):null,samples};
}

export function resolveStreak(store,config,window,currentRound,now,outcome){
  if(!config.streakReverseEnabled)return null;
  const save=evidence=>store.saveStreakEvent({...evidence,configId:config.id,oracleWindow:window,observedAt:now});
  const latest=streakEvidence(currentRound-300,config.streakReverseRounds,outcome);
  if(latest.direction)return save(latest);
  // Historical trigger events are audit records, never a substitute for the
  // exact N rounds immediately preceding this market's opening.
  return null;
}
