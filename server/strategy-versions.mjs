// Append a new entry and switch the active version when execution rules change.
export const PREVIOUS_DIRECTION_VERSIONS=Object.freeze({
  'PR-001':Object.freeze({
    id:'PR-001',
    name:'固定反买 · 同向只跳一次',
    rules:'反买紧邻上一场；官方结果优先，未结算可用同源预测。恰好连续两场同向时跳过下一场，同一走势只跳一次。开盘 15 秒内按配置价格和盘口检查，每场最多一次。预计失利按马丁加倍、获胜回首笔、超过金额或次数上限回首笔。第三笔没有额外过滤。'
  }),
});
export const ACTIVE_PREVIOUS_DIRECTION_VERSION=PREVIOUS_DIRECTION_VERSIONS['PR-001'];

export const LOSS_FOLLOW_VERSION=Object.freeze({
  id:'LF-001',
  name:'三连亏跟随模拟',
  rules:'监控上场方向模拟的三笔连续成交失利，含同源当前场预计结果。下一场复核后按来源策略方向、跳场及盘口价格范围下单，使用独立模拟马丁账本；跟随盘赢一笔后，等来源盘再产生三笔新失利。'
});

export const ACTIVE_LOSS_FOLLOW_VERSION=Object.freeze({
  id:'LF-002',
  name:'三连亏跟随 · 失利翻倍加五',
  rules:LOSS_FOLLOW_VERSION.rules+'资金规则改为：首笔按配置金额，失利后下一笔为上一笔预算×2+5 pUSD；任一获胜回首笔并待命，超过单笔金额或加倍次数上限回首笔。示例首笔5：5、15、35、75。'
});

export const LEVEL_LIMITED_VERSION=Object.freeze({
  id:'LP-001',
  name:'上场方向 · 超出支撑压力不下单',
  rules:PREVIOUS_DIRECTION_VERSIONS['PR-001'].rules+'另须入场时本场同源新鲜BTC报价位于本盘独立支撑位至压力位之间，含两端；高于压力或低于支撑禁止下单。区间或报价未就绪等待，15秒内回区间可继续尝试，不成交不计失利。支撑压力按独立回看及滞后参数计算，完整区间内均可下单，不附加蓝区限制。'
});
