import test from 'node:test';
import assert from 'node:assert/strict';
import { earlySignalFromTick, withReversal } from '../server/round-signals.mjs';
import { Store } from '../server/store.mjs';
import { RoundHistory } from '../server/history.mjs';
import { roundStart } from '../server/strategy.mjs';

const round = 1800000000;

test('initial signal uses this round opening reference and only actual early seconds', () => {
  const down = earlySignalFromTick(round, { time: (round + 5) * 1000, price: 99 }, 100);
  assert.equal(down.direction, 'DOWN');
  assert.equal(down.referencePrice, 100);
  assert.equal(earlySignalFromTick(round, { time: (round + 4) * 1000, price: 99 }, 100), null);
  assert.equal(earlySignalFromTick(round, { time: (round + 11) * 1000, price: 99 }, 100), null);
  assert.equal(earlySignalFromTick(round, { time: (round + 5) * 1000, price: 99 }, null), null);
  assert.equal(earlySignalFromTick(round, { time: NaN, price: 99 }, 100), null);
});

test('configured entry time uses its own sample window, including zero, and never accepts an earlier price', () => {
  const options = {targetSeconds:10};
  assert.equal(earlySignalFromTick(round,{time:(round+5)*1000,price:99},100,options),null);
  assert.equal(earlySignalFromTick(round,{time:(round+9.999)*1000,price:99},100,options),null);
  const signal = earlySignalFromTick(round,{time:(round+10)*1000,price:101},100,options);
  assert.equal(signal.direction,'UP'); assert.equal(signal.targetSeconds,10);
  assert.equal(earlySignalFromTick(round,{time:(round+15.001)*1000,price:101},100,options),null);
  assert.equal(earlySignalFromTick(round,{time:round*1000,price:99},100,{targetSeconds:0}).direction,'DOWN');
});

test('changing the configured entry time recalculates reversal without reusing or overwriting the 5-second signal', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const historical=round-300;
  store.tick((historical+5)*1000,99);
  store.tick((historical+10)*1000,101);
  const history=new RoundHistory({}, {store,now:()=>round*1000+10000});
  history.cache.set(historical,{round:historical,end:round,open:100,close:102,status:'resolved',result:'UP'});
  const five=history.snapshot(5).items.at(-1);
  const ten=history.snapshot(10).items.at(-1);
  assert.equal(five.initialSignal.direction,'DOWN'); assert.equal(five.reversal,true);
  assert.equal(ten.initialSignal.direction,'UP'); assert.equal(ten.reversal,false);
  assert.equal(ten.initialSignal.observedAt,(historical+10)*1000);
  assert.equal(history.snapshot(5).items.at(-1).reversal,true);
  assert.equal(history.snapshot(20).items.at(-1).initialSignal,null);
  assert.equal(history.snapshot(20).items.at(-1).reversal,null);
  store.saveInitialSignal({...ten.initialSignal,direction:'DOWN'});
  assert.equal(store.initialSignal(historical,10).direction,'UP');
  assert.equal(store.initialSignal(historical,5).direction,'DOWN');
});

test('history fills all ten requested observations from archived ticks and leaves absent points unknown', t => {
  const store=new Store(':memory:'); t.after(()=>store.close());
  const historical=round-300, targets=[5,10,15,20,35,40,45,50,55,60];
  for(const seconds of targets) store.tick((historical+seconds)*1000,seconds%2?99:101);
  const history=new RoundHistory({}, {store,now:()=>round*1000+10000});
  history.cache.set(historical,{round:historical,end:round,open:100,close:102,status:'resolved',result:'UP'});
  history.snapshot();
  for(const seconds of targets) {
    assert.equal(store.initialSignal(historical,seconds).observedAt,(historical+seconds)*1000);
    assert.equal(store.initialSignal(historical,seconds).price,seconds%2?99:101);
  }
  assert.equal(store.initialSignal(historical,25),null);
  assert.equal(store.initialSignal(historical-300,10),null);
});

test('both reversal directions are detected without labeling ordinary matching rounds as reversals', () => {
  assert.equal(withReversal({ status:'resolved',result:'UP' }, { direction:'DOWN' }).reversal, true);
  assert.equal(withReversal({ status:'resolved',result:'DOWN' }, { direction:'UP' }).reversal, true);
  assert.equal(withReversal({ status:'resolved',result:'UP' }, { direction:'UP' }).reversal, false);
});

test('unknown early data, flat signals, and pending or split results remain unclassified', () => {
  assert.equal(withReversal({ status:'resolved',result:'DOWN' }, null).reversal, null);
  assert.equal(withReversal({ status:'resolved',result:'DOWN' }, { direction:null }).reversal, null);
  assert.equal(withReversal({ status:'pending',result:null }, { direction:'UP' }).reversal, null);
  assert.equal(withReversal({ status:'void',result:null }, { direction:'UP' }).reversal, null);
});

test('first early signal is immutable and exchange prices cannot provide an oracle sample', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.tick((round + 5) * 1000, 99, 'binance');
  assert.equal(store.firstOracleTick(round), null);
  store.tick((round + 7) * 1000, 101, 'polymarket');
  const initial = earlySignalFromTick(round, store.firstOracleTick(round), 100);
  store.saveInitialSignal(initial);
  store.saveInitialSignal({ ...initial, direction:'DOWN' });
  assert.equal(store.initialSignal(round).direction, 'UP');
  assert.equal(store.initialSignal(round).observedAt, (round + 7) * 1000);
});

test('historical cached results are enriched from saved early oracle ticks without inventing missing history', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const now = (round + 10) * 1000, historical = roundStart(now) - 300;
  store.tick((historical + 6) * 1000, 99, 'polymarket');
  const history = new RoundHistory({}, { store, now: () => now });
  history.cache.set(historical - 300, { round:historical - 300, open:98, status:'resolved',result:'UP' });
  history.cache.set(historical, { round:historical, open:100, close:101, status:'resolved',result:'UP' });
  const result = history.snapshot();
  const item = result.items.at(-1);
  assert.equal(item.initialSignal.direction, 'DOWN');
  assert.equal(item.reversal, true);
  assert.equal(store.initialSignal(historical).observedAt, (historical + 6) * 1000);
  assert.equal(result.items[0].reversal, null);
});

test('saved legacy early prices are reclassified once against this round opening and then remain immutable', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const historical = round - 300;
  store.saveInitialSignal({ round:historical, observedAt:(historical+5)*1000,
    price:99,referencePrice:90,direction:'UP',rule:'previous_round_open',source:'polymarket' });
  const history = new RoundHistory({}, { store, now:() => round*1000+10000 });
  history.cache.set(historical,{ round:historical,open:100,close:101,status:'resolved',result:'UP' });
  const item=history.snapshot().items.at(-1);
  assert.equal(item.initialSignal.direction,'DOWN'); assert.equal(item.reversal,true);
  assert.equal(store.initialSignal(historical).rule,'current_round_open');
  assert.equal(store.initialSignal(historical).referencePrice,100);
  store.saveInitialSignal({ ...item.initialSignal,direction:'UP' });
  assert.equal(store.initialSignal(historical).direction,'DOWN');
});
