import {EventEmitter} from 'node:events';

export function oracleSpec(config) {
  if (!config || config.asset?.toLowerCase() !== 'btc') throw new Error('缺少本场 BTC 预言机配置');
  if (config.twapEnabled === true && [30, 60].includes(Number(config.twapLookbackSeconds))) {
    const seconds = Number(config.twapLookbackSeconds);
    return { topic: seconds === 60 ? 'crypto_prices_twap_sixty' : 'crypto_prices_twap_thirty',
      seconds, label: `Polymarket · Chainlink TWAP ${seconds}s` };
  }
  if (config.twapEnabled === false) return { topic: 'crypto_prices_chainlink', seconds: 0, label: 'Polymarket · Chainlink BTC/USD' };
  throw new Error('本场预言机类型暂不支持，暂停价格信号');
}

export function decodePriceFrame(frame, spec, now = Date.now()) {
  if (frame?.topic !== spec.topic || frame.payload?.symbol !== 'btc/usd') return [];
  if (spec.seconds && Number(frame.payload.window_s) !== spec.seconds) return [];
  const ticks = Array.isArray(frame.payload.data) ? frame.payload.data : [frame.payload];
  return ticks.map(tick => ({ time: Number(tick.timestamp),
    price: tick.full_accuracy_value != null ? Number(tick.full_accuracy_value) / 1e18 : Number(tick.value) }))
    .filter(t => Number.isFinite(t.price) && t.price > 0 && Number.isFinite(t.time) &&
      t.time > now - 7200000 && t.time <= now + 2000).sort((a, b) => a.time - b.time);
}

// The public RTDS TWAP channel is verified at runtime. If it is retired or stale,
// fail closed; never substitute a different exchange or an unweighted price.
export class PolymarketPriceFeed extends EventEmitter {
  constructor({ now = () => Date.now(), socketFactory = url => new WebSocket(url) } = {}) {
    super();this.now = now; this.socketFactory = socketFactory; this.socket = null;
    this.spec = null; this.round = null; this.latest = null; this.queue = []; this.nextConnectAt = 0;
    this.readers = new WeakMap(); this.acceptedCount=0; this.topicSince=null;
    this.points = new Map();
    this.heartbeat = null; this.lastFreshAt = 0;
  }
  connect(spec,round=null) {
    if(round!=null&&this.round!=null&&(round<this.round||(round===this.round&&this.spec?.topic!==spec.topic)))return false;
    if(round!=null)this.round=round;
    if (this.spec?.topic !== spec.topic) {
      this.topicSince=this.spec&&round!=null?round*1000:null;
      this.close(); this.latest = null; this.points.clear(); this.nextConnectAt = 0;
    }
    this.spec = spec;
    // A replacement socket gets its own grace period; cached ticks predate it.
    if(this.socket&&this.now()-this.lastFreshAt>15000)this.close();
    if (this.socket || this.now() < this.nextConnectAt) return true;
    const socket = this.socketFactory('wss://ws-live-data.polymarket.com');
    this.socket = socket; this.lastFreshAt = this.now();
    socket.addEventListener('open', () => {
      if(this.socket!==socket)return;
      socket.send(JSON.stringify({ action: 'subscribe', subscriptions: [
        { topic: spec.topic, type: '*', filters: JSON.stringify({ symbol: 'btc/usd' }) },
      ] }));
      this.heartbeat = setInterval(() => { if (socket.readyState === 1) socket.send('PING'); }, 5000);
      this.heartbeat.unref?.();
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      try {
        const points = decodePriceFrame(JSON.parse(String(event.data)), spec, this.now());
        const accepted=[];
        for (const point of points) {
          if(this.topicSince!=null&&point.time<this.topicSince)continue;
          if (!this.latest || point.time > this.latest.time) {
            this.latest=point;this.queue.push({...point,oracleWindow:spec.seconds});this.acceptedCount++;
            this.points.set(point.time,point.price);accepted.push(point);
          }
        }
        for (const time of this.points.keys()) if (time < this.now() - 7200000) this.points.delete(time);
        if (this.queue.length > 7200) this.queue = this.queue.slice(-7200);
        if(accepted.length){
          if(this.now()-this.latest.time<=6000)this.lastFreshAt=this.now();
          this.emit('price',{...this.latest,oracleWindow:spec.seconds},accepted);
        }
      } catch { /* heartbeat or unrelated frame */ }
    });
    const disconnected = () => {
      if (this.socket !== socket) return;
      this.close(); this.nextConnectAt = this.now() + 2000;
    };
    socket.addEventListener('error', disconnected); socket.addEventListener('close', disconnected);
    return true;
  }
  async fresh(spec,round=null) {
    if(this.connect(spec,round)===false)throw new Error('Official price feed moved to another round or oracle');
    const deadline = Date.now() + 6000;
    do {
      if(this.spec?.topic!==spec.topic||(round!=null&&this.round!==round))throw new Error('Official price feed moved to another round or oracle');
      if (this.latest && this.now() - this.latest.time <= 6000 && this.latest.time <= this.now() + 2000)
        return { ...this.latest };
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    if(!this.latest)throw new Error(`${spec.label} 等待 6000 毫秒后仍未收到有效报价；WebSocket readyState=${this.socket?.readyState??'未创建'}`);
    const age=this.now()-this.latest.time;
    if(age>6000)throw new Error(`${spec.label} 报价过期：距今 ${age} 毫秒，允许最大 6000 毫秒`);
    if(this.latest.time>this.now()+2000)throw new Error(`${spec.label} 报价时间超前 ${this.latest.time-this.now()} 毫秒，允许最大 2000 毫秒`);
    throw new Error(`${spec.label} 未能在 6000 毫秒等待窗口内提供有效报价；WebSocket readyState=${this.socket?.readyState??'未创建'}`);
  }
  drain(consumer) {
    const unread=this.acceptedCount-(this.readers.get(consumer)??0);
    this.readers.set(consumer,this.acceptedCount);
    return this.queue.slice(Math.max(0,this.queue.length-unread));
  }
  recent(count=2){return [...this.points.entries()].slice(-count).map(([time,price])=>({time,price}));}
  pointAt(time) { return this.points.get(time) ?? null; }
  close() {
    clearInterval(this.heartbeat); this.heartbeat = null;
    const socket = this.socket; this.socket = null;
    if (socket && socket.readyState < 2) socket.close();
  }
}
