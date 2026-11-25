// Closed form of repeatedly applying previous amount * 2 + increment.
export function stakeAmount(base,step,increment=0){
  return Math.round(((base+increment)*2**step-increment+Number.EPSILON)*1e6)/1e6;
}
