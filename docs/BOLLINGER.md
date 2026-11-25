# 上场方向布林模拟

页面 `/bollinger`，报表 `/reports` 中的「上场方向布林模拟」标签。侧栏「上场方向布林模拟」可进入。新账户默认暂停。

## 策略及账户

完整复用 `PreviousDirectionEngine` 的 PR-001：买紧邻上一场市场结果的反方向；刚好形成连续两场同向时跳过一次；开盘15秒内按本盘配置买价、深度、tick、最小份额和费用检查，每场最多一次。马丁失利纯翻倍、获胜回首笔、超过金额或次数上限回首笔。布林线只是展示，暖机或历史加载不阻塞下单。

首次创建 `data/previous-bollinger.sqlite` 时只复制原上场方向模拟当前配置，按 `initialBalance` 新建独立资金；不复制原盘交易、余额、日志、会话及运行状态。以后两个模拟盘分别修改配置，账户、交易、日志、隐藏、重置和报表均隔离。复用官方行情 WebSocket、共享 target 和支撑压力位，不增加市场行情连接。

## 参数及计算

在图表「配置布林线」或侧栏「策略设置」修改，运行中可保存。

| 参数 | 默认 | 允许值 |
| --- | --- | --- |
| 显示布林线 | 显示 | 显示、隐藏 |
| 周期 N | 20根 | 整数2–200 |
| 标准差倍数 K | 2 | 0.1–10 |
| K线时长 | 1分钟 | 15秒、30秒、1分钟、5分钟 |

按UTC时间戳对齐K线桶，以同源报价中每桶最新实际采样作为收盘价。中轨为最近N根收盘价的简单均值；标准差使用总体标准差 `sqrt(sum((close-mean)^2)/N)`，上轨为 `mean+K*σ`，下轨为 `mean-K*σ`。未完成K线随最新报价更新，因此其布林值会变化。缺失的已结束K线自动从官方接口补数，不复制相邻价格；尚未补齐或预言机TWAP窗口变化时，滚动窗口仍按连续数据计算，显示当前补数进度。

计算历史覆盖“N根配置K线＋31分钟图表范围”，向配置K线边界取整。先用共享本地实采数据，缺失桶从 Polymarket `/api/crypto/crypto-price` 按该桶最后一秒读取同口径官方参考价：`eventStartTime=桶终点−1秒`、`variant=fiveminute`、`endDate=eventStartTime+5分钟`、`twapEnabled/twapLookbackSeconds` 匹配行情口径；取 `openPrice`，不要求查询区间的 `closePrice` 已发布。2026-11-25 已实测分钟、15秒边界及最后一秒查询与本地同源报价相符。API所得是指定时刻的参考快照，不宣称恢复整根逐笔OHLC。

补得价格单独存入布林库 `bollinger_history_prices`，保留报价时刻、价格、来源、TWAP窗口及获取时间，不写入实时ticks、市场结果或交易预测。换参数后按新的周期和K线时长计算缺失，短周期缓存只能在其时刻正好匹配长周期末秒时复用。本地实采桶优先。当前未结束K线继续使用实时流，不请求或伪造未来收盘价。

中轨金色虚线、上轨紫色、下轨蓝色。三轨参与图表纵轴范围，保留既有实时价格、target、支撑压力及蓝区背景。本场和近30分钟视图都可展示，指标计算使用视图之前的历史暖机，不在换场时清空。

图表裁剪保留左边界之前最近一个有效布林点，在左边界使用该已知指标值作为绘图起点，再连接窗口内后续指标点，避免按收盘时间取点导致开头空出一根K线。不会将窗口内后续收盘值向前移到开盘；若历史点超过一根K线时长，或下一点已属于缺口/口径变化后的新段，则保持断线。本场与近30分钟窗口共用 `visibleBollingerBands` 规则，原始报价、指标计算时间及交易规则不变。

## 实现及接口

- `src/bollinger.mjs`：前后端共用参数校验，以及前端指标计算。
- `server/bollinger-engine.mjs`：`BollingerStore` 专用参数及补数价格表；`BollingerEngine` 复用交易引擎并在后台调度补数；`server/bollinger-history.mjs` 聚合共享历史5秒桶并维护 `BollingerHistoryRepair` 队列。
- `src/BollingerChart.jsx`：合并共享实时流与暖机历史，绘制指标说明及三轨；`src/PriceChart.jsx` 负责SVG三轨和纵轴范围。
- `src/BollingerSettings.jsx`：独立表单；保存不要求停止策略。
- `/bollinger/api/state`、`events`、`history`、`paper/*`：复用既有隔离交易接口，仅允许paper，支持本盘分页、导出、隐藏、清空、重置及报表。
- `POST /bollinger/api/bollinger-settings`：增量保存显示参数，使用该页面的本机Origin和控制令牌，保存后广播包含 `bollinger` 的状态。无网络上游依赖。
- `GET /bollinger/api/bollinger-history`：返回 `{oracleWindow,points:[{time,price,oracleWindow,source?}],repair:{state,expected,available,missing,active,error}}`。接口先返回已有数据，缺失异步排队，不等待上游请求。开盘保护时返回202，前端2秒重试；补数中2秒刷新，补齐后60秒刷新，请求错误15秒重试。卸载或参数变更取消旧前端请求；页面2分钟未再请求，后端停止发起新补数请求。

前端通过 `/bollinger/api/events?chart=1` 一条SSE接收状态和独立生产的图表事件；隐藏页释放长连接并暂停布林历史轮询，返回后重连回放。避免多个交易页占满浏览器同源连接池，详见 [页面请求性能](UI_PERFORMANCE.md)。

后台最多2个并发请求，按“窗口＋所需末秒时刻”去重；单次6秒超时，失败按1秒到30秒退避并持续重试。每次发起前检查全局开盘保护，已发出的请求可完成，但不会继续启动下一笔。任务不进入策略判断及下单的等待链，关闭服务等待在途任务完成或超时。部分补齐立即可用，不要求整批完成。

参数逐列存于 `bollinger_settings`，不使用JSON保存。交易策略没有改变，订单继续记录PR-001；布林图表设置不会被解释成交易信号版本。

相关测试：`node --test --test-isolation=none tests/bollinger-history.test.mjs tests/bollinger.test.mjs tests/previous-direction-engine.test.mjs tests/api.test.mjs tests/reports.test.mjs`。验证标准差、当前K线更新、暖机/缺失/口径隔离、补数范围、去重和重试、并发及保护窗口、真实末秒时间、缓存持久化、参数克隆仅一次、令牌隔离和原策略行为。
