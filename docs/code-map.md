# 当前页面与代码结构

## 页面入口

`src/main.jsx` 在挂载时选择页面，左侧菜单统一由 `src/Sidebar.jsx` 提供。

| 地址 | 页面 | 主要组件 | API | 数据库 |
| --- | --- | --- | --- | --- |
| `/range` | 区间突破模拟 | `main.jsx`、`RangeStatus.jsx`、`StrategySettings.jsx` | `/range/api/*` | `data/range.sqlite` |
| `/live` | 区间突破实盘 | `main.jsx`、`RangeStatus.jsx`、`StrategySettings.jsx` | `/api/*` | `data/trading.sqlite` |
| `/reports` | 区间突破模拟报表 | `ReportsPage.jsx` | `/range/api/paper/report` | 只读区间突破模拟数据 |

旧 `/paper`、`/momentum` 地址在前端重定向到 `/live`。旧策略模块和历史数据库仍保留兼容代码，不代表当前菜单存在这些页面。

## 前端共用部分

- `api.mjs`：按页面选择 API 前缀；控制操作完成后读取服务端已保存状态；合并快照时拒绝旧时间戳覆盖新状态。
- `HistoryPanel.jsx`：交易和日志分页、导出、预测展示。清空由页面提供回调，缺少回调时不展示清空按钮。
- `HistoricalRounds.jsx`：已结束市场场次结果，与账户订单盈亏分开。
- `AccountStats.jsx`：共用余额、累计净盈亏、胜率、下一笔投入四张卡片，分别读取当前页面的独立账户。
- `StrategyControl.jsx`：共用首笔金额输入、策略明细、资金序列和启动/暂停单按钮；页面传入自身策略说明和控制回调。
- `styles.css`：共用样式，每条样式规则一行。


## 后端执行链

`server/index.mjs` 创建三个独立引擎和数据库，挂载 API，统一关闭行情连接和数据库。

- `engine.mjs`：共用入场、资金序列、订单、预测续投、结算与运行日志。
- `range-strategy.mjs` / `range-engine.mjs`：区间分析、连续收盘确认、边界暂停和恢复、触发价格与成交上限。
- `range-live-engine.mjs`：读取区间模拟的方向和共用参数；实盘资金、订单和日志独立保存。
- `store.mjs` / `range-store.mjs`：SQLite 持久化。读取运行中的数据库时使用只读连接；Store 构造函数具有账户暂停和迁移副作用。


## 验证与运行

运行 `npm.cmd test`、`npm.cmd run build` 和 `npm.cmd run check`。前端源码修改由开发服务更新；修改后端需要重启服务才能生效。启动服务不等于启动交易策略，新增模拟账户默认暂停。
