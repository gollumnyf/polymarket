# 当前页面与代码结构

## 页面入口

`src/main.jsx` 在挂载时选择页面，左侧菜单统一由 `src/Sidebar.jsx` 提供。

| 地址 | 页面 | 主要组件 | API | 数据库 |
| --- | --- | --- | --- | --- |
| `/range` | 区间突破模拟 | `main.jsx`、`RangeStatus.jsx`、`StrategySettings.jsx` | `/range/api/*` | `data/range.sqlite` |
| `/lead` | 行情领先与配对实验模拟 | `GamMvPage.jsx` lead 分支 | `/lead/api/*` | `data/lead-pair.sqlite` |
| `/gam` | GAM 均值方差模拟 | `GamMvPage.jsx`、`GamMarket.jsx` | `/gam/api/*` | `data/gam-mv.sqlite` |
| `/live` | 区间突破实盘 | `main.jsx`、`RangeStatus.jsx`、`StrategySettings.jsx` | `/api/*` | `data/trading.sqlite` |
| `/reports` | 区间突破模拟报表 | `ReportsPage.jsx` | `/range/api/paper/report` | 只读区间突破模拟数据 |

旧 `/paper`、`/momentum` 地址在前端重定向到 `/live`。旧策略模块和历史数据库仍保留兼容代码，不代表当前菜单存在这些页面。

## 前端共用部分

- `api.mjs`：按页面选择 API 前缀；控制操作完成后读取服务端已保存状态；合并快照时拒绝旧时间戳覆盖新状态。
- `HistoryPanel.jsx`：交易和日志分页、导出、预测展示。清空由页面提供回调，缺少回调时不展示清空按钮。
- `HistoricalRounds.jsx`：已结束市场场次结果，与账户订单盈亏分开。
- `PriceChart.jsx`：区间模拟、实盘和 GAM 共用行情图，包括坐标轴、悬浮时间秒数、target 起始线和本场/近 30 分钟模式；区间页面另外传入支撑、压力和边界区域数据。
- `AccountStats.jsx`：共用余额、累计净盈亏、胜率、下一笔投入四张卡片，分别读取当前页面的独立账户。
- `StrategyControl.jsx`：共用首笔金额输入、策略明细、资金序列和启动/暂停单按钮；页面传入自身策略说明和控制回调。
- `styles.css`：共用样式，每条样式规则一行。

GAM 页面分别管理连接错误与操作错误。断线时不显示“已连接”；重连重新获取控制令牌，启动/暂停防止重复提交。倒计时独立更新，历史清空只调用 GAM 自己的 API。

## 后端执行链

`server/index.mjs` 创建三个独立引擎和数据库，挂载 API，统一关闭行情连接和数据库。

- `engine.mjs`：共用入场、资金序列、订单、预测续投、结算与运行日志。
- `range-strategy.mjs` / `range-engine.mjs`：区间分析、连续收盘确认、边界暂停和恢复、触发价格与成交上限。
- `range-live-engine.mjs`：读取区间模拟的方向和共用参数；实盘资金、订单和日志独立保存。
- `gam-mv.mjs`：GAM 插值、概率映射、均值方差和双边报价计算。
- `gam-mv-engine.mjs`：独立模拟引擎，以模型公允价值与卖一之差选向；复用 `MomentumEngine` 的执行路径和最高 0.50 买价约束，不继承区间策略的 0.55 成交上限。
- `store.mjs` / `range-store.mjs`：SQLite 持久化。读取运行中的数据库时使用只读连接；Store 构造函数具有账户暂停和迁移副作用。

GAM 当前模型系数定义在引擎内，OFI 输入固定为 0；目标残差、再平衡和双边套利计算尚未接入订单执行。`gamSignal` 虽由引擎生成，但尚无独立信号表保存全部模型依据。页面只将这些数据展示为指标，不宣称已执行对冲或双边套利。

## 验证与运行

运行 `npm.cmd test`、`npm.cmd run build` 和 `npm.cmd run check`。前端源码修改由开发服务更新；修改后端需要重启服务才能生效。启动服务不等于启动交易策略，新增模拟账户默认暂停。
