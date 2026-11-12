import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGam, targetResidual, rebalance, arbitrage } from '../server/gam-mv.mjs';

test('GAM maps additive market state to complementary fair values', () => {
  const value = evaluateGam({ beta0: 0, smooths: { d: [{ x: 0, y: 0 }, { x: 1, y: 1 }], v: [{ x: 0, y: 0 }], tau: [{ x: 0, y: 0 }], ofi: [{ x: 0, y: 0 }] } }, { d: 1 });
  assert.equal(value.pUp, 1 / (1 + Math.exp(-1)));
  assert.equal(value.fairUp + value.fairDown, 1);
});

test('mean variance residual is bounded and only hedges excess exposure', () => {
  const target = targetResidual({ pUp: 0.6, downCost: 0.45, gamma: 2, maxResidual: 0.2 });
  assert.ok(target >= 0 && target <= 0.2);
  assert.equal(rebalance({ upExposure: 0.8, downExposure: 0, pUp: 0.6, downCost: 0.45, gamma: 2, maxResidual: 0.2 }).downToBuy, 0.8 - target);
});

test('paired inventory reports arbitrage only below one dollar', () => {
  assert.equal(arbitrage({ upCost: 0.48, downCost: 0.49 }).available, true);
  assert.equal(arbitrage({ upCost: 0.5, downCost: 0.5 }).available, false);
});
