# 页面与代码索引

现行规则、调度优先级、数据库隔离和接手约定以 [交接文档](HANDOFF.md) 为准。

| 任务 | 代码入口 |
| --- | --- |
| 模拟 / 实盘页面 | src/main.jsx、src/Sidebar.jsx；/previous 与 /previous-live |
| 策略设置与说明 | src/StrategyControl.jsx、src/StrategySettings.jsx、src/PreviousStrategySummary.jsx |
| K 线与市场历史 | src/PriceChart.jsx、src/HistoricalRounds.jsx、src/history-summary.mjs、src/live-prediction.mjs、src/chart-prices.mjs（独立行情事件去重与绘图时间窗）、server/index.mjs（共享图表 SSE）、server/price-feed.mjs（共用 RTDS，独立读游标，按连接监测新鲜报价并重连）、server/chart-opening.mjs（官方 target）、server/chart-range.mjs（共享支撑压力及过渡区间） |
| 交易记录、日志和报表 | src/HistoryPanel.jsx、src/ReportsPage.jsx、server/reports.mjs |
| 页面名称与唯一标识 | src/pages.mjs（固定ID与中文名称）、src/Sidebar.jsx（菜单英文副标题与data-page-id）；更名保留路由及账本 |
| 页面连接与刷新性能 | server/ui-stream.mjs（独立状态/行情生产，共用SSE连接）、src/page-stream.mjs（隐藏页断开/可见重连）、src/coalesced-refresh.mjs（分页版本刷新合并）；[诊断说明](UI_PERFORMANCE.md) |
| 本机 API、后台请求调度与退出 | server/index.mjs、scripts/service-control.mjs |
| 固定反买、开盘预取与报价 | server/previous-direction-engine.mjs、server/engine.mjs、server/strategy.mjs |
| 三连亏跟随模拟与实盘 | `/loss-follow`、`/loss-follow-live`，`server/loss-follow-engine.mjs` 共用触发和资金规则，`server/redemption.mjs` 处理实盘兑换 |
| Polymarket 请求、链上兑换及行情 | server/polymarket.mjs、server/redemption.mjs、server/price-feed.mjs |
| 市场/盘口网络故障恢复 | server/polymarket.mjs.readPublic（短超时、并发合并、429冷却、网络代码）、server/engine.mjs.marketPollInterval（失败后1秒重查）；[说明](MARKET_CONNECTIVITY.md) |
| 市场历史与持久化 | server/history.mjs、server/store.mjs、server/schema.sql、[数据库文档](database.md) |

range 模块保留图表参考和归档相关能力。旧选向规则见 [区间策略归档](research/legacy-range-rules.md)。
