// GAM + mean-variance paper model.  This module is deliberately independent
// from the execution engines: it can be used by a simulator, a backtest, or
// a UI without ever placing an order.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Evaluate a fitted additive logistic model.
 * Each smooth is a list of {x, y} knots. Linear interpolation between knots
 * keeps the model deterministic and makes a fitted model portable as JSON.
 */
export function evaluateGam({ beta0 = 0, smooths = {} }, { d = 0, v = 0, tau = 0, ofi = 0 } = {}) {
  const inputs = { d, v, tau, ofi };
  const z = beta0 + Object.entries(inputs).reduce((sum, [name, x]) => sum + smooth(smooths[name], x), 0);
  const pUp = 1 / (1 + Math.exp(-clamp(z, -60, 60)));
  return { z, pUp, pDown: 1 - pUp, fairUp: pUp, fairDown: 1 - pUp };
}

export function smooth(knots = [], x = 0) {
  if (!knots.length) return 0;
  const points = [...knots].sort((a, b) => a.x - b.x);
  if (x <= points[0].x) return points[0].y;
  if (x >= points.at(-1).x) return points.at(-1).y;
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i].x) {
      const a = points[i - 1], b = points[i], t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return points.at(-1).y;
}

/** Directional residual target from the mean-variance allocator. */
export function targetResidual({ pUp, downCost, gamma = 1, maxResidual = 1 }) {
  if (!(pUp >= 0 && pUp <= 1) || !(downCost >= 0) || !(gamma > 0)) return 0;
  const denominator = gamma * pUp * (1 - pUp);
  if (denominator <= 0) return 0;
  return clamp((pUp - (1 - downCost)) / denominator, 0, maxResidual);
}

export function rebalance({ upExposure = 0, downExposure = 0, pUp, upCost, downCost, gamma, maxResidual }) {
  const target = targetResidual({ pUp, downCost, gamma, maxResidual });
  const residual = upExposure - downExposure;
  return { targetResidual: target, residual, downToBuy: Math.max(0, residual - target), upToBuy: Math.max(0, -residual - (1 - target)) };
}

export function arbitrage({ upCost, downCost, fee = 0 }) {
  const totalCost = upCost + downCost + fee;
  return { totalCost, edge: 1 - totalCost, available: totalCost < 1 };
}

export function decideEntry({ fairValue, buyCost, minEdge = 0 }) {
  return { edge: fairValue - buyCost, enter: fairValue - buyCost >= minEdge };
}

