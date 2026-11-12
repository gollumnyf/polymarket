import { MomentumEngine } from './momentum.mjs';
import { evaluateGam, targetResidual, arbitrage } from './gam-mv.mjs';

const DEFAULT_MODEL = Object.freeze({ beta0: 0, gamma: 2, maxResidual: 0.25, minEdge: 0.02, smooths: {
  d: [{ x: -0.01, y: -1.2 }, { x: 0, y: 0 }, { x: 0.01, y: 1.2 }],
  v: [{ x: 0, y: 0 }, { x: 0.01, y: -0.15 }, { x: 0.05, y: -0.35 }],
  tau: [{ x: 0, y: 0 }, { x: 30, y: 0.12 }, { x: 300, y: 0.25 }],
  ofi: [{ x: -1, y: -0.4 }, { x: 0, y: 0 }, { x: 1, y: 0.4 }]
} });

export class GamMvEngine extends MomentumEngine {
  constructor(store, venue, options = {}) {
    super(store, venue, { ...options, modes: ['paper'] });
    this.gamModel = options.model || DEFAULT_MODEL;
  }
  modelSignal() {
    const spot = this.spot || {};
    const start = Number(spot.currentOpen);
    const price = Number(spot.price);
    const tau = Math.max(0, (this.roundStart() + 300) - this.now() / 1000);
    const d = Number.isFinite(start) && start ? (price - start) / start : 0;
    const v = Math.abs(Number(spot.changePercent) || 0) / 100;
    const ofi = 0;
    const fair = evaluateGam(this.gamModel, { d, v, tau, ofi });
    const upCost = Number(this.books?.UP?.asks?.[0]?.price);
    const downCost = Number(this.books?.DOWN?.asks?.[0]?.price);
    const target = targetResidual({ pUp: fair.pUp, downCost: Number.isFinite(downCost) ? downCost : 1, gamma: this.gamModel.gamma, maxResidual: this.gamModel.maxResidual });
    return { ...fair, d, v, tau, ofi, upCost: Number.isFinite(upCost) ? upCost : null, downCost: Number.isFinite(downCost) ? downCost : null, targetResidual: target,
      arbitrage: Number.isFinite(upCost) && Number.isFinite(downCost) ? arbitrage({ upCost, downCost }) : null };
  }
  roundStart() { return Math.floor(this.now() / 300000) * 300; }
  signal() {
    const s = this.modelSignal();
    const direction = s.fairUp - (s.upCost ?? 1) >= this.gamModel.minEdge ? 'UP' : s.fairDown - (s.downCost ?? 1) >= this.gamModel.minEdge ? 'DOWN' : null;
    return { ...s, direction, code: direction ? null : 'GAM_EDGE_TOO_SMALL', message: direction ? `GAM ${direction} 估值超过买入成本` : 'GAM 估值边际不足，继续等待' };
  }
  snapshot() { return { ...super.snapshot(), strategy: 'gam_mv', gam: this.signal(), gamModel: this.gamModel }; }
  entryDirection() { return this.signal().direction; }
  entryGuard() { const result = this.signal(); return result.code ? result : super.entryGuard(); }
  orderSignalFields() { const s = this.signal(); return { signalRule: 'gam_mean_variance', referencePrice: this.spot?.currentOpen, signalPrice: this.spot?.price, gamSignal: s }; }
}

