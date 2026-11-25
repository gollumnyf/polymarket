export const ROUND_SECONDS = 300;
export const DEFAULT_CONFIG = Object.freeze({
  baseAmount: 10, initialBalance: 1000, maxAmount: 320, maxDoublings: 6,
  stopLoss: 500, entryDelay: 5, entryWindow: 45, slippage: 2, maxPrice: 0.85, minPrice: 0.4, sameDirectionOnly: false, followPreviousAtOpen: false, reverseSignal:false,
});

export const roundStart = (now = Date.now()) => Math.floor(now / 1000 / ROUND_SECONDS) * ROUND_SECONDS;
export const money = value => Math.round((value + Number.EPSILON) * 1e6) / 1e6;
export const nextAmount = account => money(account.config.baseAmount * 2 ** (account.stakeLosses??account.losses));
export function resetAtAmountLimit(account,amountFor=nextAmount) {
  // The doubling-count limit remains an independent stop condition.
  if (account.losses > account.config.maxDoublings ||
      account.config.baseAmount > account.config.maxAmount || amountFor(account) <= account.config.maxAmount) return account;
  return {...account,losses:0,cycle:account.cycle+1,cyclePnl:0};
}
export const signalDirection = (reference, current) => {
  if (![reference, current].every(n => Number.isFinite(n) && n > 0)) return null;
  return current > reference ? 'UP' : current < reference ? 'DOWN' : null;
};

export function validateConfig(input) {
  const config = { ...DEFAULT_CONFIG, ...input };
  const ranges = {
    baseAmount: [1, 100000], initialBalance: [1, 10000000], maxAmount: [1, 1000000],
    maxDoublings: [0, 16], stopLoss: [1, 1000000], entryDelay: [0, 240],
    entryWindow: [1, 299], slippage: [0, 20], maxPrice: [0.01, 0.99], minPrice: [0.01, 0.99],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < min || config[key] > max)
      throw new Error(`${key} 必须是 ${min} 到 ${max} 之间的数字`);
  }
  for (const key of ['maxDoublings', 'entryDelay', 'entryWindow']) {
    if (!Number.isInteger(config[key])) throw new Error(`${key} 必须是整数`);
  }
  if (typeof config.sameDirectionOnly !== 'boolean') throw new Error('sameDirectionOnly 必须是布尔值');
  if (typeof config.followPreviousAtOpen !== 'boolean') throw new Error('followPreviousAtOpen 必须是布尔值');
  if (typeof config.reverseSignal !== 'boolean') throw new Error('reverseSignal 必须是布尔值');
  if (config.reverseSignal&&(config.followPreviousAtOpen||config.sameDirectionOnly)) throw new Error('反向买入不能与跟随或同向模式同时启用');
  if (config.entryDelay >= config.entryWindow) throw new Error('入场延迟必须小于入场截止秒数');
  if (config.maxAmount < config.baseAmount) throw new Error('单笔上限不能小于首笔金额');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`不支持的参数：${key}`);
  return Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(key => [key, config[key]]));
}

export function riskReason(account, available,amountFor=nextAmount) {
  account=resetAtAmountLimit(account,amountFor);
  const amount = amountFor(account);
  if (account.losses > account.config.maxDoublings) return `达到最大加倍次数：当前连续失利 ${account.losses} 次 > 配置 ${account.config.maxDoublings} 次，本次暂不买入，策略持续检查`;
  if (amount > account.config.maxAmount) return `首笔金额超过单笔上限：下一笔 ${amount.toFixed(6)} pUSD > 上限 ${account.config.maxAmount.toFixed(6)} pUSD`;
  if ((account.riskPnl ?? account.pnl) - amount < -account.config.stopLoss) return `下一笔突破累计亏损上限：当前风控盈亏 ${(account.riskPnl??account.pnl).toFixed(6)} pUSD，下一笔 ${amount.toFixed(6)} pUSD，扣除后 ${((account.riskPnl??account.pnl)-amount).toFixed(6)} pUSD < 止损线 ${(-account.config.stopLoss).toFixed(6)} pUSD，本次暂不买入，策略持续检查`;
  if (Number.isFinite(available) && amount > available) return `可用余额不足：下一笔 ${amount.toFixed(6)} pUSD > 可用余额 ${available.toFixed(6)} pUSD，缺少 ${(amount-available).toFixed(6)} pUSD，本次暂不买入，策略持续检查`;
  return null;
}

export function afterSettlement(account, pnl, won, reset=resetAtAmountLimit) {
  return reset({ ...account, pnl: money(account.pnl + pnl), cyclePnl: won ? 0 : money(account.cyclePnl + pnl),
    losses: won ? 0 : account.losses + 1, wins: account.wins + (won ? 1 : 0),
    settled: account.settled + 1, cycle: account.cycle + (won ? 1 : 0) });
}

export function feePerShare(price, schedule) {
  if (!schedule || !Number.isFinite(schedule.rate) || schedule.rate < 0 || !Number.isFinite(schedule.exponent))
    throw new Error('市场手续费参数缺失，等待数据');
  return schedule.rate * (price * (1 - price)) ** schedule.exponent;
}

// The configured stake is the total budget, including taker fees. Walk the asks;
// never assume infinite liquidity at the displayed best price.
export function simulateFill(book, budget, config, schedule, {strictTicks=false,ignoreSlippage=false,minimumBestAsk=null}={}) {
  let asks = book.asks.map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(l => l.price > 0 && l.price < 1 && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => a.price - b.price);
  const evidence={budget,maxPrice:config.maxPrice,slippage:config.slippage,bookAt:book.fetchedAt??null};
  const number=n=>Number(n).toFixed(6);
  const reject=(code,message,extra={})=>{throw Object.assign(new Error(message),{code,evidence:{...evidence,...extra}});};
  if (!asks.length) reject('ASKS_EMPTY',`卖盘为空：收到 ${book.asks.length} 档，价格有效且数量大于 0 的卖单为 0 档；无法买入预算 ${number(budget)} pUSD`);
  evidence.bestAsk=asks[0].price;
  const tick = Number(book.tickSize);
  if (!Number.isFinite(tick) || tick <= 0) reject('TICK_SIZE_INVALID',`盘口价格精度无效：接口 tickSize=${String(book.tickSize)}，必须为大于 0 的有限数字`);
  if(strictTicks){
    const invalid=asks.find(level=>Math.abs(level.price/tick-Math.round(level.price/tick))>1e-8);
    if(invalid)reject('ASK_OFF_TICK',`官方卖盘价格不符合 tick：卖价 ${number(invalid.price)}，tickSize ${number(tick)}；本次不模拟成交，等待有效盘口`,{tickSize:tick});
  }
  const slippageLimit=ignoreSlippage?config.maxPrice:asks[0].price*(1+config.slippage/100),rawPriceLimit=Math.min(config.maxPrice,slippageLimit);
  const priceLimit = Math.floor((rawPriceLimit + 1e-10) / tick) * tick;
  const limitSource=ignoreSlippage?'execution_cap':config.maxPrice<slippageLimit?'max_price':config.maxPrice>slippageLimit?'slippage':'both';
  Object.assign(evidence,{tickSize:tick,slippageLimit,rawPriceLimit,priceLimit:money(priceLimit),limitSource});
  if(asks[0].price>config.maxPrice+(strictTicks?0:1e-10))
    reject('MAX_PRICE_BELOW_BEST_ASK',`卖一价超过最高买价：卖一 ${number(asks[0].price)} > 配置上限 ${number(config.maxPrice)}，超出 ${number(asks[0].price-config.maxPrice)}；限价内可成交 0 份，预算 ${number(budget)} pUSD 全部无法成交`,{eligibleShares:0,availableBudget:0,remainingBudget:budget,nextAsk:asks[0].price});
  if(minimumBestAsk!=null&&asks[0].price<minimumBestAsk)
    reject('BEST_ASK_BELOW_MIN_PRICE',`卖一价低于最低买价：卖一 ${number(asks[0].price)} < 配置下限 ${number(minimumBestAsk)}；本次不触发买入`);
  if(priceLimit+1e-10<asks[0].price)
    reject('PRICE_TICK_BELOW_BEST_ASK',`按价格精度向下取整后无法买入：原始限价 ${number(rawPriceLimit)}，tickSize ${number(tick)}，有效限价 ${number(priceLimit)} < 卖一 ${number(asks[0].price)}`,{eligibleShares:0,availableBudget:0,remainingBudget:budget,nextAsk:asks[0].price});
  if(!schedule||!Number.isFinite(schedule.rate)||schedule.rate<0||!Number.isFinite(schedule.exponent))
    reject('FEE_SCHEDULE_INVALID',`市场手续费参数缺失：rate=${String(schedule?.rate??'未提供')}，exponent=${String(schedule?.exponent??'未提供')}；无法计算含手续费的 ${number(budget)} pUSD 成交预算`);
  const withinLimit=level=>level.price<=priceLimit+1e-10&&(!strictTicks||level.price<=config.maxPrice);
  const eligible=asks.filter(withinLimit).map(level=>({...level,feeRate:feePerShare(level.price,schedule)}));
  const nextAsk=asks.find(level=>!withinLimit(level))?.price??null;
  const eligibleShares=eligible.reduce((total,level)=>total+level.size,0);
  const availableBudget=eligible.reduce((total,level)=>total+level.size*(level.price+level.feeRate),0);
  Object.assign(evidence,{eligibleShares:money(eligibleShares),availableBudget:money(availableBudget),nextAsk,feeRate:schedule.rate,feeExponent:schedule.exponent});
  let remaining = budget, shares = 0, notional = 0, fee = 0;
  for (const level of eligible) {
    const rate = level.feeRate;
    const quantity = Math.min(level.size, remaining / (level.price + rate));
    shares += quantity; notional += quantity * level.price; fee += quantity * rate;
    remaining -= quantity * (level.price + rate);
    if (remaining < 1e-7) break;
  }
  if (remaining > 0.0001 || shares <= 0) {
    const amounts=`预算 ${number(budget)} pUSD，限价 ${number(priceLimit)} 内共 ${number(eligibleShares)} 份，含手续费最多成交 ${number(availableBudget)} pUSD，缺少 ${number(Math.max(0,remaining))} pUSD`;
    const detail={remainingBudget:money(remaining),estimatedShares:money(shares)};
    if(nextAsk==null)reject('ORDER_BOOK_DEPTH_EXHAUSTED',`全部卖盘数量不足：${amounts}；接口有效卖盘中没有更高档卖单`,detail);
    if(limitSource==='execution_cap')reject('EXECUTION_PRICE_LIMITED_DEPTH',`成交硬上限内深度不足：${amounts}；配置成交上限 ${number(config.maxPrice)}，下一档 ${number(nextAsk)} 超出；本策略不使用相对滑点百分比限制`,detail);
    if(limitSource==='max_price')reject('MAX_PRICE_LIMITED_DEPTH',`最高买价限制可成交数量：${amounts}；最高买价 ${number(config.maxPrice)} 按 tickSize ${number(tick)} 取整为有效限价 ${number(priceLimit)}；下一档 ${number(nextAsk)} 超过有效限价；滑点 ${number(config.slippage)}% 对应上限 ${number(slippageLimit)}`,detail);
    if(limitSource==='slippage')reject('SLIPPAGE_LIMITED_DEPTH',`滑点限制可成交数量：${amounts}；卖一 ${number(asks[0].price)}，滑点 ${number(config.slippage)}% 对应上限 ${number(slippageLimit)}，按 tickSize ${number(tick)} 取整为 ${number(priceLimit)}；下一档 ${number(nextAsk)} 超过有效限价；最高买价为 ${number(config.maxPrice)}`,detail);
    reject('BOTH_PRICE_LIMITS',`最高买价与滑点上限同时限制可成交数量：${amounts}；两个上限均为 ${number(rawPriceLimit)}，下一档 ${number(nextAsk)} 超过有效限价`,detail);
  }
  const minimumShares = Number(book.minOrderSize);
  evidence.minimumShares=Number.isFinite(minimumShares)?minimumShares:null;
  if (!Number.isFinite(minimumShares) || minimumShares <= 0) reject('MINIMUM_SHARES_INVALID',`盘口最小订单份额无效：接口 minOrderSize=${String(book.minOrderSize)}，必须为大于 0 的有限数字`);
  if (shares + 1e-6 < minimumShares) {
    let missingShares=minimumShares,required=0;
    for(const level of eligible){const quantity=Math.min(missingShares,level.size);required+=quantity*(level.price+level.feeRate);missingShares-=quantity;if(missingShares<1e-6)break;}
    if(missingShares>1e-6)reject('MINIMUM_SHARES_UNAVAILABLE',`预计 ${number(shares)} 份，低于最小 ${minimumShares} 份；有效限价 ${number(priceLimit)} 内全部卖盘仅 ${number(eligibleShares)} 份，还缺 ${number(missingShares)} 份才能达到最小订单`,{estimatedShares:money(shares),remainingBudget:0});
    reject('BUDGET_BELOW_MINIMUM_SHARES',`预计 ${number(shares)} 份，低于最小 ${minimumShares} 份；按当前逐档卖价及手续费，达到最小份额需要 ${number(required)} pUSD；当前预算 ${number(budget)} pUSD，缺少 ${number(Math.max(0,required-budget))} pUSD`,{estimatedShares:money(shares),requiredBudget:money(required),remainingBudget:money(Math.max(0,required-budget))});
  }
  return { shares: money(shares), notional: money(notional), fee: money(fee),
    cost: money(notional + fee), price: notional / shares, priceLimit: money(priceLimit) };
}
