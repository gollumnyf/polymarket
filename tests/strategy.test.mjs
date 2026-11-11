import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig, signalDirection, afterSettlement, nextAmount, simulateFill, riskReason,resetAtAmountLimit } from '../server/strategy.mjs';

function account() { return { config: { ...DEFAULT_CONFIG, baseAmount: 5 }, losses: 0, pnl: 0, cyclePnl: 0, wins: 0, settled: 0, cycle: 1 }; }
const book = { tickSize: .01, minOrderSize: 1, asks: [{ price: '.5', size: '1000' }] };
const fees = { rate: .07, exponent: 1 };

test('direction compares the previous round open with current price; flat/invalid never guesses', () => {
  assert.equal(signalDirection(100, 101), 'UP'); assert.equal(signalDirection(100, 99), 'DOWN');
  assert.equal(signalDirection(100, 100), null); assert.equal(signalDirection(null, 100), null);
});
test('losses double, and any directional win resets even when the cycle remains unprofitable', () => {
  let a = account();
  assert.equal(nextAmount(a), 5);
  a = afterSettlement(a, -5, false); assert.equal(nextAmount(a), 10);
  a = afterSettlement(a, -10, false); assert.equal(nextAmount(a), 20);
  a = afterSettlement(a, 1, true); assert.equal(nextAmount(a), 5);
  assert.equal(a.pnl, -14); assert.equal(a.losses, 0); assert.equal(a.cycle, 2);
});
test('simulated budget includes fees instead of promising 1:1 binary profits', () => {
  const fill = simulateFill(book, 5, DEFAULT_CONFIG, fees);
  assert.equal(fill.cost, 5); assert.ok(fill.fee > 0); assert.ok(fill.shares < 10);
  assert.ok(Math.abs(fill.shares - 5 / .5175) < .000001);
});
test('walks multiple ask levels, enforces slippage, max price, and complete liquidity', () => {
  const deep = { ...book, asks: [{ price: '.51', size: '100' }, { price: '.50', size: '3' }] };
  const fill = simulateFill(deep, 5, DEFAULT_CONFIG, fees);
  assert.ok(fill.price > .5 && fill.price < .51);
  assert.throws(() => simulateFill(deep, 5, { ...DEFAULT_CONFIG, slippage: 0 }, fees), /滑点限制可成交数量/);
  assert.throws(() => simulateFill(book, 5, { ...DEFAULT_CONFIG, maxPrice: .49 }, fees), /卖一价超过最高买价/);
  assert.throws(() => simulateFill({ ...book, asks: [{ price: '.5', size: '1' }] }, 5, DEFAULT_CONFIG, fees), /全部卖盘数量不足/);
});
test('unknown fees and subminimum orders cannot create invented simulated fills', () => {
  assert.throws(() => simulateFill(book, 5, DEFAULT_CONFIG, null), /手续费/);
  assert.throws(() => simulateFill({ ...book, minOrderSize: 10 }, 5, DEFAULT_CONFIG, fees), /最小.*份/);
});

test('quote rejections identify the exact limiting condition and save numeric evidence without ambiguous alternatives',()=>{
  const examples=[
    {code:'MAX_PRICE_BELOW_BEST_ASK',asks:[{price:.60,size:100}],config:{maxPrice:.55},budget:20,expected:{bestAsk:.6,priceLimit:.55,eligibleShares:0,remainingBudget:20}},
    {code:'MAX_PRICE_LIMITED_DEPTH',asks:[{price:.5,size:1},{price:.56,size:100}],config:{maxPrice:.55,slippage:20},expected:{priceLimit:.55,availableBudget:.5175,remainingBudget:4.4825,nextAsk:.56}},
    {code:'SLIPPAGE_LIMITED_DEPTH',asks:[{price:.5,size:1},{price:.52,size:100}],config:{slippage:2},expected:{priceLimit:.51,availableBudget:.5175,remainingBudget:4.4825,nextAsk:.52}},
    {code:'ORDER_BOOK_DEPTH_EXHAUSTED',asks:[{price:.5,size:1}],expected:{availableBudget:.5175,remainingBudget:4.4825,nextAsk:null}},
    {code:'BOTH_PRICE_LIMITS',asks:[{price:.5,size:1},{price:.52,size:100}],config:{maxPrice:.51,slippage:2},expected:{limitSource:'both',priceLimit:.51}},
    {code:'PRICE_TICK_BELOW_BEST_ASK',asks:[{price:.5,size:100}],config:{slippage:0},tickSize:.03,expected:{priceLimit:.48}},
    {code:'BUDGET_BELOW_MINIMUM_SHARES',asks:[{price:.5,size:1000}],budget:2,minOrderSize:5,expected:{requiredBudget:2.5875,remainingBudget:.5875}},
    {code:'BUDGET_BELOW_MINIMUM_SHARES',asks:[{price:.5,size:1},{price:.51,size:1000}],budget:2,minOrderSize:5,expected:{requiredBudget:2.627472,remainingBudget:.627472}},
    {code:'MINIMUM_SHARES_UNAVAILABLE',asks:[{price:.5,size:4}],budget:1,minOrderSize:5,expected:{eligibleShares:4}},
  ];
  for(const item of examples){
    assert.throws(()=>simulateFill({...book,asks:item.asks,tickSize:item.tickSize??book.tickSize,minOrderSize:item.minOrderSize??book.minOrderSize},item.budget??5,{...DEFAULT_CONFIG,...item.config},fees),error=>{
      assert.equal(error.code,item.code);assert.doesNotMatch(error.message,/或|可能|约需/);
      for(const [key,value]of Object.entries(item.expected))assert.equal(error.evidence[key],value,`${item.code}/${key}`);
      return true;
    });
  }
});

test('minimum order size is shares, not pUSD; a $2 buy can fill five shares at a sufficiently low ask', () => {
  const small = { ...book, minOrderSize: 5, asks: [{ price: '.30', size: '1000' }] };
  const fill = simulateFill(small, 2, DEFAULT_CONFIG, fees);
  assert.ok(fill.shares >= 5); assert.equal(fill.cost, 2);
  assert.throws(() => simulateFill({ ...small, asks: [{ price: '.50', size: '1000' }] }, 2, DEFAULT_CONFIG, fees), /低于最小 5 份.*需要 2\.587500 pUSD.*缺少 0\.587500/);
});
test('amount cap starts a new base-stake cycle while other risk conditions still stop trading', () => {
  const a = account(); a.losses = 7;
  assert.match(riskReason(a, 10000), /最大加倍/);
  a.losses = 3; a.config.maxAmount = 25; assert.equal(riskReason(a, 10000),null);
  const reset=resetAtAmountLimit(a);assert.equal(reset.losses,0);assert.equal(reset.cycle,2);assert.equal(nextAmount(reset),5);
  a.config.maxAmount = 100; a.pnl = -480; assert.match(riskReason(a, 10000), /累计亏损/);
  a.pnl = 0; assert.match(riskReason(a, 2), /余额不足/);
});

test('confirmed losses cycle 5,10,20,5 at cap 32 without refunding losses or changing win statistics',()=>{
  let a={...account(),config:{...DEFAULT_CONFIG,baseAmount:5,maxAmount:32},balance:1000};
  const sequence=[nextAmount(a)];
  for(const cost of [5,10,20]){a=afterSettlement(a,-cost,false);sequence.push(nextAmount(a));}
  assert.deepEqual(sequence,[5,10,20,5]);assert.equal(a.cycle,2);assert.equal(a.losses,0);
  assert.equal(a.pnl,-35);assert.equal(a.cyclePnl,0);assert.equal(a.wins,0);assert.equal(a.settled,3);
  assert.equal(a.balance,1000);
  const equal={...account(),losses:2,config:{...DEFAULT_CONFIG,baseAmount:5,maxAmount:20}};
  assert.equal(resetAtAmountLimit(equal),equal);assert.equal(nextAmount(equal),20);
});
test('configuration rejects NaN, numeric strings, invalid windows, unknown fields, and fractional doubling limits', () => {
  for (const input of [{ baseAmount: NaN }, { baseAmount: '5' }, { maxDoublings: 2.2 }, { entryDelay: 50, entryWindow: 30 }, { foo: 1 }])
    assert.throws(() => validateConfig(input));
  assert.equal(validateConfig({ baseAmount: 12 }).baseAmount, 12);
});
test('same-direction option defaults off, accepts boolean settings only and retains other configuration validation',()=>{
  assert.equal(validateConfig({}).sameDirectionOnly,false);
  assert.equal(validateConfig({sameDirectionOnly:true}).sameDirectionOnly,true);
  assert.equal(validateConfig({sameDirectionOnly:false}).sameDirectionOnly,false);
  for(const value of ['true','false',0,1,null])assert.throws(()=>validateConfig({sameDirectionOnly:value}),/布尔/);
});

test('follow-at-open defaults off and rejects nonboolean values',()=>{
  assert.equal(validateConfig({}).followPreviousAtOpen,false);
  assert.equal(validateConfig({followPreviousAtOpen:true,sameDirectionOnly:true}).followPreviousAtOpen,true);
  for(const value of [0,1,'true',null])assert.throws(()=>validateConfig({followPreviousAtOpen:value}),/布尔/);
});

test('reverse mode defaults off, validates booleans and cannot combine with another direction rule',()=>{
  assert.equal(validateConfig({}).reverseSignal,false);
  assert.equal(validateConfig({reverseSignal:true}).reverseSignal,true);
  for(const value of [0,1,'true',null])assert.throws(()=>validateConfig({reverseSignal:value}),/布尔/);
  for(const input of [{followPreviousAtOpen:true},{sameDirectionOnly:true}])assert.throws(()=>validateConfig({...input,reverseSignal:true}),/不能/);
});
