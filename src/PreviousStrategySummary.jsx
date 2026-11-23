import React from 'react';

export default function PreviousStrategySummary({live=false}){
  return <section className="previous-strategy-summary" aria-label="上场方向策略说明">
    <h3>策略说明</h3>
    <ol>
      <li><strong>统计方式：</strong>将最近 40 个已结束的 BTC 五分钟场次分别与紧邻上一场比较，统计同向和反向命中次数。优先用官方结果，未结算用预计结果；缺失或作废不跨场补算。命中次数仅供参考。</li>
      <li><strong>买入方向：</strong>固定买紧邻上一场的反方向：上一场 UP 就买 DOWN，上一场 DOWN 就买 UP。紧邻上一场无有效方向就跳过。</li>
      <li><strong>暂停一场：</strong>连续两场 UP 或 DOWN 后跳过一场，下一场恢复反向买入检查。同一段走势持续同向时不再跳过；方向改变后重新计数。</li>
      <li><strong>成交条件：</strong>开盘立即尝试，15 秒内每场最多买一次。不看本场 BTC 涨跌，按所选方向的卖一价判断，落在设置的最低与最高买入价之间（含两端）才尝试买入，任何一档成交价均不得超过上限；限价内深度不足则不成交。{live&&'实盘使用全额成交或取消订单。'}</li>
      <li><strong>马丁资金：</strong>首笔可设，预计失利则加倍，预计获胜则恢复首笔。下一笔超过单笔金额或最大加倍次数时，也从首笔开始新一轮。以官方结算为准，余额和累计止损仍生效。</li>
    </ol>
  </section>;
}
