import { createPublicClient, createSecureClient, OrderSide, OrderType, AssetType } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { roundStart, signalDirection, money, feePerShare } from './strategy.mjs';
import { PolymarketPriceFeed, oracleSpec } from './price-feed.mjs';

export async function timedFetch(input, init = {}) {
  const signals = [AbortSignal.timeout(10000), init.signal, input instanceof Request ? input.signal : null].filter(Boolean);
  return fetch(input, { ...init, signal: AbortSignal.any(signals) });
}

export function safeError(error) {
  let message = String(error?.message || error || '未知错误');
  for (const [key, value] of Object.entries(process.env)) {
    if (/PRIVATE_KEY|SECRET|PASSPHRASE|API_KEY/i.test(key) && value) message = message.replaceAll(value, '[已隐藏]');
  }
  return message.replace(/0x[a-fA-F0-9]{64}\b/g, '[已隐藏]').slice(0, 400);
}

export function normalizeMarket(raw, start) {
  if (!['v1', 'v2'].includes(raw.version)) throw new Error('未知市场协议版本，禁止下单');
  const outcomes = Object.values(raw.outcomes).map((o, index) => ({ index, direction: o.label.toUpperCase(),
    assetId: raw.version === 'v2' ? o.positionId : o.tokenId, price: o.price == null ? null : Number(o.price) }));
  if (!outcomes.some(o => o.direction === 'UP') || !outcomes.some(o => o.direction === 'DOWN') || outcomes.some(o => !o.assetId))
    throw new Error('本场不是可交易的 UP/DOWN 二元市场');
  const f = raw.trading.feeSchedule;
  const feeSchedule = raw.trading.feesEnabled === false ? { rate: 0, exponent: 1 }
    : f ? { rate: Number(f.rate), exponent: Number(f.exponent) } : null;
  return { id: raw.id, slug: raw.slug, conditionId: raw.conditionId, question: raw.question,
    description: raw.description, round: start, end: start + 300, version: raw.version,
    active: raw.state.active === true && raw.state.closed === false && raw.state.acceptingOrders === true,
    marketState:{active:raw.state.active,closed:raw.state.closed,acceptingOrders:raw.state.acceptingOrders},
    volume: Number(raw.metrics?.volume || 0), outcomes, feeSchedule, fetchedAt: Date.now() };
}

export class Polymarket {
  constructor({ fetchImpl = timedFetch, priceFeed = new PolymarketPriceFeed(), now = () => Date.now(),officialOpeningOnly=false,deferOpeningPrice=false } = {}) {
    this.fetch = fetchImpl;
    this.public = createPublicClient({ fetch: fetchImpl });
    this.secure = null;
    this.authPromise = null;
    this.liveBalance = null;
    this.balanceAt = 0;
    this.liveError = null;
    this.priceFeed = priceFeed; this.now = now; this.references = null;
    this.officialOpeningOnly=officialOpeningOnly;
    this.deferOpeningPrice=deferOpeningPrice;this.openingTask=null;
  }
  readiness() {
    return { enabled: process.env.LIVE_TRADING_ENABLED === 'true',
      configured: Boolean(process.env.POLYMARKET_PRIVATE_KEY && process.env.POLYMARKET_WALLET_ADDRESS),
      authenticated: Boolean(this.secure), wallet: process.env.POLYMARKET_WALLET_ADDRESS || null,
      balance: this.liveBalance, balanceAt: this.balanceAt, error: this.liveError };
  }
  async authenticate() {
    const ready = this.readiness();
    if (!ready.enabled) throw new Error('请先在本机 .env 设置 LIVE_TRADING_ENABLED=true 并重启服务');
    if (!ready.configured) throw new Error('请先在本机 .env 配置交易钱包地址和签名私钥，并重启服务');
    if (this.secure) return this.secure;
    if (!this.authPromise) {
      this.authPromise = createSecureClient({ wallet: process.env.POLYMARKET_WALLET_ADDRESS,
        signer: privateKey(process.env.POLYMARKET_PRIVATE_KEY), fetch: this.fetch })
        .then(client => { this.secure = client; this.liveError = null; return client; })
        .catch(error => { this.liveError = safeError(error); throw error; })
        .finally(() => { this.authPromise = null; });
    }
    return this.authPromise;
  }
  async balance() {
    const client = await this.authenticate();
    const result = await client.fetchBalanceAllowance({ assetType: AssetType.COLLATERAL });
    // Official CLOB balance response is base units; pUSD uses 6 decimals.
    const value = Number(result.balance) / 1e6;
    if (!Number.isFinite(value) || value < 0) throw new Error('钱包余额响应无效');
    this.liveBalance = value; this.balanceAt = Date.now();
    return value;
  }
  async market(start) {
    const raw = await this.public.fetchMarket({ slug: `btc-updown-5m-${start}` });
    const market = normalizeMarket(raw, start);
    if (!market.feeSchedule && market.conditionId) {
      const info = await this.public.fetchMarketInfo({ conditionId: market.conditionId });
      market.feeSchedule = info.feeInfo;
    }
    return market;
  }
  async books(market) {
    const results = await this.public.fetchOrderBooks(market.outcomes.map(o => ({ assetId: o.assetId })));
    const books = {};
    for (const outcome of market.outcomes) {
      const book = results.find(b => b.assetId === outcome.assetId);
      if (!book) throw new Error('盘口响应缺少结果代币');
      books[outcome.direction] = { ...book, fetchedAt: Date.now(),
        asks: [...book.asks].sort((a, b) => Number(a.price) - Number(b.price)),
        bids: [...book.bids].sort((a, b) => Number(b.price) - Number(a.price)) };
    }
    return books;
  }
  async spot() {
    const start = roundStart(this.now());
    if (this.references?.round !== start || (this.references.currentOpen == null && this.now() - this.references.updatedAt >= (this.officialOpeningOnly?1000:30000))) {
      const q = new URLSearchParams({ limit: '2' });
      for (const round of [start - 300, start]) q.append('slug', `btc-updown-5m-${round}`);
      const response = await this.fetch(`https://gamma-api.polymarket.com/events?${q}`);
      if (!response.ok) throw new Error(`Polymarket 场次参考价 HTTP ${response.status}`);
      const events = await response.json();
      if (!Array.isArray(events)) throw new Error('Polymarket 场次响应无效');
      const current = events.find(e => e.slug === `btc-updown-5m-${start}`);
      const previous = events.find(e => e.slug === `btc-updown-5m-${start - 300}`);
      const market = current?.markets?.find(m => m.slug === current.slug);
      const previousMarket = previous?.markets?.find(m => m.slug === previous.slug);
      const spec = oracleSpec(market?.cryptoMarketConfig);
      const previousSpec = this.officialOpeningOnly?null:oracleSpec(previousMarket?.cryptoMarketConfig);
      if (previousSpec&&spec.topic !== previousSpec.topic) throw new Error('相邻场次结算口径变更，等待核对');
      this.priceFeed.connect(spec);
      const [latest, previousOpen] = await Promise.all([
        this.priceFeed.fresh(spec), this.officialOpeningOnly?
          Promise.resolve(Number(previous?.eventMetadata?.priceToBeat)>0?Number(previous.eventMetadata.priceToBeat):null):this.openingPrice(previous, start - 300, spec),
      ]);
      // Current-round opening is the trading reference. Keep streaming prices
      // while that opening is delayed, but withhold the entry direction.
      const metadataOpen = Number(current?.eventMetadata?.priceToBeat);
      let currentOpen = Number.isFinite(metadataOpen) && metadataOpen > 0 ? metadataOpen : this.officialOpeningOnly?null:this.priceFeed.pointAt?.(start * 1000);
      if (currentOpen == null&&!this.deferOpeningPrice) currentOpen = await this.openingPrice(current, start, spec).catch(() => null);
      const metadataClose = Number(previous?.eventMetadata?.finalPrice);
      const previousClose = Number.isFinite(metadataClose) && metadataClose > 0 ? metadataClose : currentOpen;
      this.references = { round: start, spec, conditionId:market?.conditionId??null,currentOpen, previousOpen, previousClose, updatedAt: this.now() };
      if(currentOpen==null&&this.deferOpeningPrice&&this.openingTask?.round!==start){
        const task={round:start};this.openingTask=task;
        task.promise=Promise.resolve().then(()=>this.openingPrice(current,start,spec)).then(price=>{
          if(this.references?.round===start&&this.references.spec.topic===spec.topic&&this.references.currentOpen==null)this.references.currentOpen=price;
        }).catch(()=>{/* The next price poll retries a still unpublished opening. */}).finally(()=>{if(this.openingTask===task)this.openingTask=null;});
      }
    }
    const { spec, currentOpen, previousOpen, previousClose } = this.references;
    const latest = await this.priceFeed.fresh(spec);
    return { price: latest.price, previousOpen, currentOpen,conditionId:this.references.conditionId, previousStart: start - 300, round: start,
      previousClose, previousChange: previousClose == null || previousOpen==null ? null : money(previousClose - previousOpen),
      previousChangePercent: previousClose == null || previousOpen==null ? null : (previousClose - previousOpen) / previousOpen * 100,
      change: currentOpen == null ? null : money(latest.price - currentOpen),
      changePercent: currentOpen == null ? null : (latest.price - currentOpen) / currentOpen * 100,
      direction: signalDirection(currentOpen, latest.price), signalRule: 'current_round_open',
      referencePrice: currentOpen, source: spec.label, sourceId: 'polymarket',
      windowSeconds: spec.seconds, at: latest.time, receivedAt: this.now(),openingSource:this.officialOpeningOnly?'polymarket_official':null };
  }
  async openingPrice(event, start, spec) {
    const metadataPrice = event?.eventMetadata?.priceToBeat;
    if (metadataPrice != null && Number.isFinite(Number(metadataPrice)) && Number(metadataPrice) > 0) return Number(metadataPrice);
    const boundary = this.officialOpeningOnly?null:this.priceFeed.pointAt?.(start * 1000);
    if (boundary != null) return boundary;
    const params = new URLSearchParams({ symbol: 'BTC', eventStartTime: new Date(start * 1000).toISOString(),
      variant: 'fiveminute', endDate: new Date((start + 300) * 1000).toISOString(),
      twapEnabled: String(spec.seconds > 0), twapLookbackSeconds: String(spec.seconds || 60) });
    const response = await this.fetch(`https://polymarket.com/api/crypto/crypto-price?${params}`);
    if (!response.ok) throw new Error(`Polymarket 开盘参考价 HTTP ${response.status}`);
    const data = await response.json();
    const price = Number(data.openPrice);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Polymarket 尚未公布场次起始价');
    return price;
  }
  drainPriceTicks() { return this.priceFeed.drain().map(point=>({...point,oracleWindow:this.priceFeed.spec?.seconds??null})); }
  latestOfficialPrices(){return {points:this.priceFeed.recent?.(2)||[],oracleWindow:this.priceFeed.spec?.seconds??null};}
  async roundPrices(order) {
    const slug=`btc-updown-5m-${order.round}`;
    const query=new URLSearchParams({slug,limit:'1'});
    const response=await this.fetch(`https://gamma-api.polymarket.com/events?${query}`);
    if (!response.ok) throw new Error(`场次预测价格接口 HTTP ${response.status}`);
    const events=await response.json();
    const event=Array.isArray(events) ? events.find(item=>item.slug===slug) : null;
    const market=event?.markets?.find(item=>item.slug===slug && (!order.conditionId || item.conditionId===order.conditionId));
    if (!market) return null;
    const price=value=>!['number','string'].includes(typeof value) || String(value).trim()==='' ||
      !Number.isFinite(Number(value)) || Number(value)<=0 ? null : Number(value);
    const open=price(event.eventMetadata?.priceToBeat), close=price(event.eventMetadata?.finalPrice);
    const spec=oracleSpec(market.cryptoMarketConfig);
    if (order.oracleWindow != null && order.oracleWindow !== spec.seconds) throw new Error('场次预测价格的 TWAP 窗口与下单时不一致');
    if (open != null && close != null) return {round:order.round,conditionId:market.conditionId,
      open,close,oracleWindow:spec.seconds,source:'polymarket_event_metadata'};
    const params=new URLSearchParams({symbol:'BTC',eventStartTime:new Date(order.round*1000).toISOString(),
      endDate:new Date(order.end*1000).toISOString(),variant:'fiveminute',
      twapEnabled:String(spec.seconds>0),twapLookbackSeconds:String(spec.seconds||60)});
    const fallback=await this.fetch(`https://polymarket.com/api/crypto/crypto-price?${params}`);
    if (!fallback.ok) throw new Error(`场次起止价接口 HTTP ${fallback.status}`);
    const pair=await fallback.json();
    const apiOpen=price(pair.openPrice), apiClose=price(pair.closePrice);
    if (apiOpen == null || apiClose == null) return null;
    if (open != null && Math.abs(apiOpen-open)>1e-6) throw new Error('平台两个接口的场次起始价不一致，暂不生成预计结果');
    return {round:order.round,conditionId:market.conditionId,open:apiOpen,close:apiClose,oracleWindow:spec.seconds,source:'polymarket_crypto_price'};
  }
  close() { this.priceFeed.close(); }
  async resolution(order) {
    if (!order.conditionId) throw new Error('缺少官方 conditionId');
    const results = await this.public.fetchResolutions({ conditionIds: [order.conditionId] });
    const row = results.find(r => r.status === 'resolved' && r.conditionId === order.conditionId);
    if (!row || !Array.isArray(row.payouts) || row.payouts.length !== 2) return null;
    const payouts = row.payouts.map(Number);
    if (payouts.some(p => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(payouts[0] + payouts[1] - 1) > 1e-6)
      throw new Error('官方兑付比例无效，等待核对');
    return { payout: payouts[order.outcomeIndex], payouts, resolvedAt: row.lastUpdatedAt };
  }
  async buy(order, quote, canSubmit = () => true) {
    const client = await this.authenticate();
    let signed;
    try {
      // The high-level placeMarketOrder helper can create unlimited token approvals
      // and retry. Sign separately and post once so those actions remain explicit.
      signed = await client.createMarketOrder({ assetId: order.assetId, side: OrderSide.BUY,
        amount: String(order.budget), maxSpend: String(order.budget),
        maxPrice: String(quote.priceLimit), orderType: OrderType.FOK });
    } catch (error) {
      return { ok: false, message: `签名/订单准备失败，未提交：${safeError(error)}` };
    }
    if (!canSubmit()) return { ok: false, message: '策略已暂停或入场窗口已结束，未提交买单' };
    return client.postOrder(signed);
  }
  async reconcile(order) {
    const client = await this.authenticate();
    if (!order.venueOrderId) return null; // Unknown submission is never inferred from wallet positions.
    const page = await client.listAccountTrades({ assetId: order.assetId, market: order.conditionId }).firstPage();
    let all = page.items;
    let cursor = page.nextCursor;
    for (let n = 0; cursor && n < 20; n++) {
      const next = await client.listAccountTrades({ assetId: order.assetId, market: order.conditionId }).from(cursor).firstPage();
      all = [...all, ...next.items]; cursor = next.nextCursor;
    }
    if (cursor) throw new Error('成交分页尚未读取完整，等待核对');
    const trades = [...new Map(all.map(t => [t.id, t])).values()].filter(t => t.takerOrderId === order.venueOrderId && t.side === 'BUY');
    if (!trades.length) {
      const venueOrder = await client.fetchOrder({ orderId: order.venueOrderId });
      if (venueOrder.assetId !== order.assetId || venueOrder.side !== 'BUY') throw new Error('平台订单与本地买入记录不符');
      if (Number(venueOrder.sizeMatched) === 0 && ['CANCELED', 'CANCELLED', 'UNMATCHED', 'EXPIRED'].includes(venueOrder.status.toUpperCase()))
        return { rejected: true, note: '官方确认该订单未成交' };
      return null;
    }
    if (trades.some(t => !['CONFIRMED', 'MINED'].includes(t.status.toUpperCase()))) return null;
    // MINED can still reorganize: only CONFIRMED permits strategy progression.
    if (trades.some(t => t.status.toUpperCase() !== 'CONFIRMED')) return null;
    const shares = trades.reduce((n, t) => n + Number(t.size), 0);
    const notional = trades.reduce((n, t) => n + Number(t.size) * Number(t.price), 0);
    const fee = trades.reduce((n, t) => n + Number(t.size) * feePerShare(Number(t.price), order.feeSchedule), 0);
    if (!(shares > 0) || !Number.isFinite(notional + fee)) return null;
    return { shares: money(shares), notional: money(notional), fee: money(fee), feeEstimated: true,
      cost: money(notional + fee), price: notional / shares, tradeIds: trades.map(t => t.id) };
  }
}
