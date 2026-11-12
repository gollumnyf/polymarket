import test from 'node:test';
import assert from 'node:assert/strict';
import {positionHistoryTooltip} from '../src/history-tooltip.mjs';

const anchor={left:300,right:324,top:220,bottom:244};
const check=(layout,anchor,height,width,viewportHeight)=>{
  const bottom=layout.top+Math.min(height,layout.maxHeight),right=layout.left+layout.width;
  assert.ok(layout.left>=12&&right<=width-12);
  assert.ok(layout.top>=12&&bottom<=viewportHeight-12);
  assert.ok(right<=anchor.left||layout.left>=anchor.right||bottom<=anchor.top||layout.top>=anchor.bottom,'panel must not overlap the hovered marker');
};

test('history tooltip uses below then above when its actual height fits',()=>{
  const below=positionHistoryTooltip(anchor,258,100,1100,800);
  assert.equal(below.placement,'bottom');check(below,anchor,100,1100,800);
  const above=positionHistoryTooltip({...anchor,top:650,bottom:674},258,400,1100,800);
  assert.equal(above.placement,'top');check(above,{...anchor,top:650,bottom:674},400,1100,800);
});

test('tall history details move right when neither above nor below fits',()=>{
  const layout=positionHistoryTooltip(anchor,360,420,1100,600);
  assert.equal(layout.placement,'right');assert.equal(layout.left,334);
  check(layout,anchor,420,1100,600);
});

test('near the right edge the same tall panel moves left without covering the marker',()=>{
  const target={...anchor,left:1000,right:1024};
  const layout=positionHistoryTooltip(target,360,420,1100,600);
  assert.equal(layout.placement,'left');check(layout,target,420,1100,600);
});

test('very long details remain beside the marker and scroll within the viewport',()=>{
  const layout=positionHistoryTooltip(anchor,360,1200,1100,600);
  assert.equal(layout.placement,'right');assert.equal(layout.maxHeight,576);
  check(layout,anchor,1200,1100,600);
});

test('narrow screens use a scrollable vertical panel when neither side can fit readable text',()=>{
  const target={left:168,right:192,top:250,bottom:274};
  const layout=positionHistoryTooltip(target,258,900,360,600);
  assert.equal(layout.placement,'bottom');assert.equal(layout.maxHeight,304);
  check(layout,target,900,360,600);
});

test('a narrower side panel respects viewport and marker edges after text wraps taller',()=>{
  const target={left:250,right:274,top:220,bottom:244};
  const layout=positionHistoryTooltip(target,360,900,700,600);
  assert.equal(layout.placement,'right');check(layout,target,900,700,600);
  const smaller=positionHistoryTooltip(target,360,1100,600,600);
  assert.equal(smaller.placement,'right');assert.equal(smaller.width,304);check(smaller,target,1100,600,600);
});
