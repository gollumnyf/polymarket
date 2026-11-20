# 页面与代码索引

现行规则、调度优先级、数据库隔离和接手约定以 [交接文档](HANDOFF.md) 为准。

| 任务 | 代码入口 |
| --- | --- |
| 模拟 / 实盘页面 | src/main.jsx、src/Sidebar.jsx；/previous 与 /previous-live |
| 策略设置与说明 | src/StrategyControl.jsx、src/StrategySettings.jsx、src/PreviousStrategySummary.jsx |
| K 线与市场历史 | src/PriceChart.jsx、src/HistoricalRounds.jsx、src/history-summary.mjs、src/live-prediction.mjs、src/chart-prices.mjs（价格事件去重合并） |
| 交易记录、日志和报表 | src/HistoryPanel.jsx、src/ReportsPage.jsx、server/reports.mjs |
| 本机 API、后台请求调度与退出 | server/index.mjs、scripts/service-control.mjs |
| 固定反买、开盘预取与报价 | server/previous-direction-engine.mjs、server/engine.mjs、server/strategy.mjs |
| Polymarket 请求、链上兑换及行情 | server/polymarket.mjs、server/redemption.mjs、server/price-feed.mjs |
| 市场历史与持久化 | server/history.mjs、server/store.mjs、server/schema.sql、[数据库文档](database.md) |

range 模块保留图表参考和归档相关能力。旧选向规则见 [区间策略归档](research/legacy-range-rules.md)。
