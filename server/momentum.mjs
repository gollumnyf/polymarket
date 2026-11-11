import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {DEFAULT_CONFIG,signalDirection,roundStart,simulateFill} from './strategy.mjs';
import {safeError} from './polymarket.mjs';

export const MOMENTUM_CONFIG=Object.freeze({...DEFAULT_CONFIG,entryDelay:0,entryWindow:299,maxPrice:0.5});
const fixedConfig=config=>({...config,entryDelay:0,maxPrice:0.5,sameDirectionOnly:false,followPreviousAtOpen:false,reverseSignal:false});

// A separate database keeps balances, configuration versions, reservations and
// history independent of the original paper account. Signal evidence is typed.
export class MomentumStore extends Store {
  constructor(path){
    super(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS momentum_order_signals (
      order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      opening_source TEXT NOT NULL, oracle_window INTEGER NOT NULL,
      previous_at INTEGER NOT NULL, previous_price REAL NOT NULL CHECK(previous_price>0),
      latest_at INTEGER NOT NULL, latest_price REAL NOT NULL CHECK(latest_price>0),
      CHECK(latest_at>previous_at)
    )`);
    this.signalSchemaReady=true;
  }
  freshAccount(mode,config=MOMENTUM_CONFIG){return super.freshAccount(mode,fixedConfig(config));}
  reserveOrder(order,book){
    return this.transaction(()=>{
      if(!super.reserveOrder(order,book))return false;
      if(order.signalRule==='official_momentum'){
        const s=order.momentumSignal;
        this.db.prepare('INSERT INTO momentum_order_signals VALUES (?,?,?,?,?,?,?)')
          .run(order.id,s.openingSource,s.oracleWindow,s.previousAt,s.previousPrice,s.latestAt,s.latestPrice);
      }
      return true;
    });
  }
  readOrder(row){
    const order=super.readOrder(row);
    if(order&&this.signalSchemaReady){
      const signal=this.db.prepare(`SELECT opening_source AS openingSource,oracle_window AS oracleWindow,
        previous_at AS previousAt,previous_price AS previousPrice,latest_at AS latestAt,latest_price AS latestPrice
        FROM momentum_order_signals WHERE order_id=?`).get(order.id);
      if(signal)order.momentumSignal={...signal};
    }
    return order;
  }
}

export function momentumSignal(spot,sample,now,start=roundStart(now)){
  const reject=(code,message,extra={})=>({direction:null,code,message,...extra});
  if(spot?.sourceId!=='polymarket'||spot?.openingSource!=='polymarket_official')return reject('OFFICIAL_SOURCE_REQUIRED','等待 Polymarket 官方初始价和官方价格流；不使用其他来源或本地边界价代替');
  if(spot.round!==start)return reject('OFFICIAL_WRONG_ROUND',`官方参考价场次 #${spot.round} 与当前 #${start} 不一致`);
  if(!Number.isFinite(spot.currentOpen)||spot.currentOpen<=0)return reject('OFFICIAL_OPEN_MISSING','Polymarket 尚未公布本场有效初始价，继续等待');
  if(!Number.isFinite(spot.windowSeconds)||sample?.oracleWindow!==spot.windowSeconds)return reject('OFFICIAL_WINDOW_MISMATCH',`官方价格窗口不一致：本场 ${String(spot.windowSeconds)} 秒，价格流 ${String(sample?.oracleWindow)} 秒`);
  const points=sample?.points;
  if(!Array.isArray(points)||points.length!==2)return reject('OFFICIAL_TWO_PRICES_REQUIRED',`需要最近两笔独立官方报价，当前仅收到 ${points?.length??0} 笔`);
  const [previous,latest]=points;
  if(![previous.price,latest.price].every(p=>Number.isFinite(p)&&p>0)||![previous.time,latest.time].every(Number.isFinite))return reject('OFFICIAL_PRICE_INVALID','最近两笔官方报价缺少有效价格或时间戳');
  if(latest.time<=previous.time)return reject('OFFICIAL_DUPLICATE_TIME',`官方报价时间没有递增：前笔 ${previous.time}，最新 ${latest.time}`);
  if(latest.time<=start*1000)return reject('OFFICIAL_AFTER_OPEN_REQUIRED','最新官方报价尚未晚于本场开盘时间，等待开盘后的新报价');
  if(latest.time>now)return reject('OFFICIAL_FUTURE_PRICE',`最新官方报价时间超前当前时间 ${latest.time-now} 毫秒，暂不使用`);
  if(now-latest.time>6000)return reject('OFFICIAL_LATEST_STALE',`最新官方报价距今 ${now-latest.time} 毫秒，超过 6000 毫秒新鲜度上限`);
  if(now-previous.time>6000)return reject('OFFICIAL_PREVIOUS_STALE',`前一笔官方报价距今 ${now-previous.time} 毫秒，超过 6000 毫秒新鲜度上限`);
  const direction=signalDirection(spot.currentOpen,latest.price),movement=signalDirection(previous.price,latest.price);
  const evidence={referencePrice:spot.currentOpen,previousAt:previous.time,previousPrice:previous.price,latestAt:latest.time,latestPrice:latest.price,oracleWindow:sample.oracleWindow,openingSource:spot.openingSource};
  if(!direction)return reject('OFFICIAL_AT_OPEN_PRICE',`最新官方价 ${latest.price} 与本场初始价 ${spot.currentOpen} 持平，继续等待`,evidence);
  if(!movement)return reject('OFFICIAL_LAST_MOVE_FLAT',`最近两笔官方价格均为 ${latest.price}，最新变动持平，不买入`,evidence);
  if(direction!==movement)return reject('OFFICIAL_DIRECTION_CONFLICT',`本场方向 ${direction}（初始 ${spot.currentOpen} → 最新 ${latest.price}），最新变动 ${movement}（前笔 ${previous.price} → 最新 ${latest.price}），两者冲突，不买入`,evidence);
  return {direction,movement,code:null,message:`本场 ${direction}，最近两笔官方价格同向 ${movement}`, ...evidence};
}

export class MomentumEngine extends Engine {
  constructor(store,venue,options={}){
    super(store,venue,{...options,modes:options.modes??['paper']});
    this.onPrice=point=>{
      if(this.closing)return;
      this.store.tick(point.time,point.price,'polymarket',point.oracleWindow);
      if(this.spot?.round===roundStart(this.now())&&this.spot.windowSeconds===point.oracleWindow){
        this.spot={...this.spot,price:point.price,at:point.time,direction:signalDirection(this.spot.currentOpen,point.price),
          change:this.spot.currentOpen==null?null:point.price-this.spot.currentOpen,
          changePercent:this.spot.currentOpen==null?null:(point.price-this.spot.currentOpen)/this.spot.currentOpen*100};
        for(const mode of this.modes)void this.attempt(mode).catch(error=>this.runtimeIssue(mode,`本次交易检查失败，下次继续重试：${safeError(error)}`,'error')).finally(()=>{if(!this.closing)this.broadcast();});
      }
    };
    venue.priceFeed?.on?.('price',this.onPrice);
  }
  signal(){return momentumSignal(this.spot,this.venue.latestOfficialPrices?.(),this.now());}
  snapshot(){return {...super.snapshot(),strategy:'official_momentum',entrySignal:this.signal()};}
  entryGuard(){
    const result=this.signal();if(result.code)return result;
    if(!this.spot.conditionId||this.spot.conditionId!==this.market?.conditionId)return {code:'OFFICIAL_MARKET_MISMATCH',message:`官方初始价所属市场 ${String(this.spot.conditionId)} 与当前盘口市场 ${String(this.market?.conditionId)} 不一致，禁止买入`};
    return null;
  }
  entryDirection(){return this.signal().direction;}
  orderSignalFields(){const s=this.signal();return {signalRule:'official_momentum',referencePrice:s.referencePrice,signalPrice:s.latestPrice,momentumSignal:s};}
  quote(book,budget,config,schedule){return simulateFill(book,budget,{...config,maxPrice:0.5},schedule,{strictTicks:true});}
  async attempt(mode){
    if(!this.modes.includes(mode)||this.entryBusy||this.closing)return;
    this.entryBusy=true;
    try{return await super.attempt(mode);}finally{this.entryBusy=false;}
  }
  async start(mode){if(!this.modes.includes(mode))throw Error('此页面不支持该交易模式');return super.start(mode);}
  configure(mode,input){
    if(mode!=='paper')throw Error('此页面仅支持模拟交易');
    if(input.entryDelay!==0||input.maxPrice!==0.5||input.sameDirectionOnly||input.followPreviousAtOpen||input.reverseSignal)throw Error('此策略固定为官方双价格同向、零延迟、最高买价 0.50');
    return super.configure(mode,fixedConfig(input));
  }
}
