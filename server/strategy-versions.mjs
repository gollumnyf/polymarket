// Append a new entry and switch the active version when execution rules change.
export const PREVIOUS_DIRECTION_VERSIONS=Object.freeze({
  'PR-001':Object.freeze({
    id:'PR-001',
    name:'固定反买 · 同向只跳一次',
    rules:'反买紧邻上一场；官方结果优先，未结算可用同源预测。恰好连续两场同向时跳过下一场，同一走势只跳一次。开盘 15 秒内按配置价格和盘口检查，每场最多一次。预计失利按马丁加倍、获胜回首笔、超过金额或次数上限回首笔。第三笔没有额外过滤。'
  }),
  'PR-002':Object.freeze({
    id:'PR-002',
    name:'固定反买 · 同向失利间隔跳场',
    rules:'反买紧邻上一场，官方结果优先，未结算可用同源预测。刚形成连续两场同向时跳过下一场。走势继续同向时，紧邻上一场有本会话实际成交且反买失利，跳过本场；再下一场恢复入场检查，后续依同样条件判断。开盘 15 秒内按配置价格和盘口检查，每场最多一次。预计失利按马丁加倍、获胜回首笔、超过金额或次数上限回首笔。'
  }),
});
export const ACTIVE_PREVIOUS_DIRECTION_VERSION=PREVIOUS_DIRECTION_VERSIONS['PR-001'];
export const ACTIVE_PAPER_PREVIOUS_DIRECTION_VERSION=PREVIOUS_DIRECTION_VERSIONS['PR-002'];

export const STREAK_REVERSE_VERSION=Object.freeze({
  id:'SR-001',
  name:'连续三场同向反买 · 固定 10',
  rules:'紧邻的三个已结束五分钟市场结果同向时，按相反方向入场。官方结果优先，未结算使用下单前已保存的同源预计结果，作废、缺失或不同向时不买。沿用 PR-002 跳场节奏，按本盘成交判断同向失利后再次跳场。仅开盘 15 秒内每场买一次，固定 10 pUSD 含手续费预算，卖一 0.40–0.65，逐档成交价最高 0.65，按盘口深度和账户风控检查。'
});

export const TWO_ROUND_STREAK_REVERSE_VERSION=Object.freeze({
  id:'SR-002',
  name:'连续两场同向反买 · 固定 10',
  rules:'紧邻的两个已结束五分钟市场结果同向时，按相反方向入场。官方结果优先，未结算使用下单前已保存的同源预计结果，作废、缺失或不同向时不买。同向延续且本盘上一场成交失利时跳过一场。仅开盘 15 秒内每场买一次，固定 10 pUSD 含手续费预算，卖一 0.40–0.65，逐档成交价最高 0.65，按盘口深度和账户风控检查。'
});

export const LOSS_FOLLOW_VERSION=Object.freeze({
  id:'LF-001',
  name:'三连亏跟随模拟',
  rules:'监控上场方向模拟的三笔连续成交失利，含同源当前场预计结果。下一场复核后按来源策略方向、跳场及盘口价格范围下单，使用独立模拟马丁账本；跟随盘赢一笔后，等来源盘再产生三笔新失利。'
});

export const LOSS_FOLLOW_V2=Object.freeze({
  id:'LF-002',
  name:'三连亏跟随 · 失利翻倍加五',
  rules:LOSS_FOLLOW_VERSION.rules+'资金规则改为：首笔按配置金额，失利后下一笔为上一笔预算×2+5 pUSD；任一获胜回首笔并待命，超过单笔金额或加倍次数上限回首笔。示例首笔5：5、15、35、75。'
});

export const ACTIVE_LOSS_FOLLOW_VERSION=Object.freeze({
  id:'LF-003',
  name:'三连亏跟随 · 首单同向失利跳一场',
  rules:LOSS_FOLLOW_V2.rules+'若来源三笔失利对应三个紧邻且结果同向的市场，且本轮首笔跟随成交反买该方向也失利，仅跳过首笔成交后的紧邻一场。官方结果优先，未公布时使用同源预测。随后按原规则继续跟随及计算预算。'
});

export const LOSS_FOLLOW_V4=Object.freeze({
  id:'LF-004',
  name:'三连亏跟随 · 同向失利跳一场',
  rules:LOSS_FOLLOW_V2.rules+'每笔跟随成交失利后，若失利场次与紧邻其前的两个市场收盘方向相同，则跳过紧接的一场。再下一场恢复原入场检查，资金序列延续；后续每笔成交按同一规则判断。前两场无需成交，官方结果优先，尚未结算时使用同源预测。'
});

export const ACTIVE_PAPER_LOSS_FOLLOW_VERSION=Object.freeze({
  id:'LF-005',
  name:'三连亏跟随 · 每轮一单',
  rules:'监控上场方向模拟连续三笔成交失利，未结算可用同源预测，开盘复核后按来源策略的方向、跳场和价格范围入场。每轮只成交一单，使用配置的首笔金额。成交即结束本轮，只统计跟随成交场次之后的来源新失利，获胜、失利或作废均不改变待命状态；行情或风控暂不允许成交时继续等待入场。'
});

export const LEVEL_LIMITED_VERSION=Object.freeze({
  id:'LP-001',
  name:'上场方向 · 超出支撑压力不下单',
  rules:PREVIOUS_DIRECTION_VERSIONS['PR-001'].rules+'另须入场时本场同源新鲜BTC报价位于本盘独立支撑位至压力位之间，含两端；高于压力或低于支撑禁止下单。区间或报价未就绪等待，15秒内回区间可继续尝试，不成交不计失利。支撑压力按独立回看及滞后参数计算，完整区间内均可下单，不附加蓝区限制。'
});
