// Prefer vertical placement; use the right side when neither vertical space fits.
export function positionHistoryTooltip(anchor, width, height, viewportWidth, viewportHeight) {
  const margin=12,gap=10,minSideWidth=160;
  width=Math.min(width,Math.max(1,viewportWidth-margin*2));
  const above=Math.max(0,anchor.top-gap-margin),below=Math.max(0,viewportHeight-margin-anchor.bottom-gap);
  const right=Math.max(0,viewportWidth-margin-anchor.right-gap),left=Math.max(0,anchor.left-gap-margin);
  const clamp=(value,min,max)=>Math.min(Math.max(value,min),Math.max(min,max));
  const centeredLeft=clamp((anchor.left+anchor.right-width)/2,margin,viewportWidth-margin-width);
  const vertical=(placement,space)=>({placement,width,maxHeight:space,left:centeredLeft,
    top:placement==='bottom'?anchor.bottom+gap:anchor.top-gap-Math.min(height,space)});
  if(height<=below)return vertical('bottom',below);
  if(height<=above)return vertical('top',above);
  let placement=right>=width?'right':left>=width?'left':null;
  if(!placement&&Math.max(left,right)>=minSideWidth){
    placement=right>=left?'right':'left';width=Math.min(width,placement==='right'?right:left);
  }
  if(placement){
    const maxHeight=Math.max(1,viewportHeight-margin*2),visibleHeight=Math.min(height,maxHeight);
    return {placement,width,maxHeight,left:placement==='right'?anchor.right+gap:anchor.left-gap-width,
      top:clamp((anchor.top+anchor.bottom-visibleHeight)/2,margin,viewportHeight-margin-visibleHeight)};
  }
  // Narrow screens: scroll within the larger vertical space without covering the dot.
  return above>below?vertical('top',above):vertical('bottom',below);
}
