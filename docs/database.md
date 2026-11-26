# SQLite 数据结构

数据库：`data/trading.sqlite`。建表 SQL：`server/schema.sql`。所有业务字段独立存列，不使用 JSON/body 列；金额与份额沿用程序的六位小数精度，代币/条件/订单 ID 用 TEXT，避免大整数精度损失。

| 表 | 主键 / 关联 | 内容 |
| --- | --- | --- |
| `accounts` | `mode`，关联当前 session/config | 模拟盘、实盘各一条；当前策略运行状态和暂停原因 |
| `strategy_configs` | 自增 `id`，`mode` | 首笔金额、初始资金、金额上限、加倍次数、止损、入场时间、滑点、最高买价、同向过滤与跟随上一场方向开关、版本创建时间；修改时新增版本 |
| `account_sessions` | `id`，`mode` | 每次初始化或模拟账户重置对应一个会话，保存可用余额、本金基数、累计盈亏、本轮盈亏、连败、胜场、结算数、资金轮次和创建/关闭时间。重置保留旧会话。2026-11-25 的模拟增资按盘同时增加 `balance` 和 `starting_balance` 各 9,000 pUSD，增资记录存入 `logs`。 |
| `orders` | `id`；唯一 `(mode, round)` | 一笔本地下单/交易一行：场次、方向、预算、实际成本/份额/均价/费用、策略加倍级数、入场参考价与信号价、价格来源、费率、状态、兑付、盈亏、平台订单 ID、备注和时间 |
| `order_rounds` | `(mode, round)`，原订单 ID 唯一 | 独立保存每场买入占用；历史订单被手动清空后仍防止同场重复买入 |
| `order_trade_ids` | `(order_id, trade_id)` | 一笔订单对应的多个平台成交 ID，保留平台返回顺序 |
| `order_events` | 自增 `id`，关联订单 | 订单状态、备注、平台订单 ID 的变更轨迹及记录时间 |
| `order_predictions` | `order_id`，关联订单 | 该场次起始价与终止参考价、预计方向/胜负、接口或末秒来源、末秒采样时间、记录时间、官方核对时间及是否一致；独立于实际交易盈亏 |
| `round_predictions` | `round` | 不依赖是否参与交易的场次预计 UP/DOWN、预测价格依据、条件 ID、来源、TWAP 窗口、末秒采样时间与记录时间；用于同向过滤与跟随上一场 |
| `round_openings` | `round` | 同源场次起始价、条件 ID、TWAP 窗口与记录时间；保留首个有效值，供末秒预测使用 |
| `order_books` | `order_id` | 下单时用于报价的盘口采样时间、价格精度、最小份额 |
| `order_book_levels` | `(order_id, side, position)` | 下单时的买卖盘逐档价格和数量，用于之后复查模拟成交依据 |
| `round_signals` | `(round, target_seconds)` | 按配置入场秒数采样的信号方向、实际采样时间/价格、参考价、规则、来源与 TWAP 窗口；不同入场秒数分别保留 |
| `ticks` | `(source, time)` | 本机实际接收到的 BTC 价格及 TWAP 窗口采样；来源相互隔离，同一时间可保存不同来源 |
| `round_history` | `round` | 已读取的场次起止价、官方结果、状态、变动金额/比例、最后获取时间；供重启和接口暂时不可用时展示 |
| `entry_blocks` | `(mode, round)` | 本场暂未下单的最近拦截原因及发生时间 |
| `entry_diagnostics` | 自增 `id`；索引 `(mode,round,id DESC)` | 每次受阻检查的原因代码、具体说明、时间、配置版本、方向、预算、入场窗口、行情/市场/盘口时间、起始价/信号价、限价/滑点、可成交数量及预算差额，均为独立列 |
| `entry_diagnostic_levels` | `(diagnostic_id,side,position)` | 拦截检查使用的逐档买卖盘价格和数量；与成功订单盘口独立保存 |
| `logs` | 自增 `id` | 本地运行日志的时间、模式、级别和内容 |
| `log_clear_positions` | `mode` | 本模式已清空的共享系统日志位置及清空时间；模拟盘清空不会删除实盘共享的系统日志 |
| `schema_migrations` | `version` | 已执行的结构迁移版本与时间 |

`orders.config_id` 关联下单时的配置版本，后续改首笔金额不会覆盖旧订单的参数依据。旧版本没有记录历史配置快照，因此迁入的旧订单此字段为空。`orders.session` 保留原始会话 ID；迁移前已被重置覆盖的会话统计无法还原，因此该列不强制外键到会话表。

场次边界 `round` / `end` 为 Unix 秒；采样、创建、结算、事件等时间为 Unix 毫秒。页面按浏览器所在时区显示日期和秒级时间。

- `orders.created_at`：本地生成并预占本场订单的下单时间，实盘此时尚可能正在准备签名。
- `orders.settled_at`：程序确认官方结果并完成本地结算的时间，不使用场次计划结束时间冒充。未结算为空；未成交显示“未成交”；旧记录缺失结算时间显示“未记录”。CSV 通过 `createdAt` / `settledAt` 导出原始毫秒时间戳。

交易记录、配置版本、会话、早期信号、盘口证据、价格采样、日志和已保存的历史结果不自动删除。页面状态和 SSE 仅返回当前待处理订单、订单总数及历史版本号，历史列表由独立分页接口按需查询；价格仍展示最近两小时，历史圆点仍显示最近 20 场。展示范围不会清理 SQLite 中的存档。数据库会随运行增长，备份及归档时须包含 WAL 中的数据。

`GET /api/:mode/orders` 和 `GET /api/:mode/logs` 支持 `page`（从 1 开始）、`pageSize`（默认 20，最多 50）；订单支持 `status` 筛选。日志包含该模式及 system 日志。返回 `items/page/pageSize/total/pages/anchor`。后续翻页传回 `anchor` 可将查询限定在第一次加载时已存在的记录范围，避免新插入记录挤动旧页；回到首页或点击刷新则读取最新记录。状态变化仍实时反映，并可能改变状态筛选的匹配数。页面只加载当前选中的标签页，翻页、筛选和模式切换会取消旧请求。

实时盘口、市场状态和可用钱包余额仍从官方接口读取并检查新鲜度；数据库历史缓存只用于查看，不作为恢复买入的实时行情。私钥、签名凭据、控制令牌不写入这些表，仍按现有本机环境配置管理。

## 旧库迁移与事务

首次启动自动识别旧 `accounts/body` 结构，使用 `VACUUM INTO` 生成包含已提交 WAL 数据的独立备份：`data/trading.sqlite.pre-v1-时间戳.sqlite`。之后在一个事务内拆分账户、订单、早期信号，搬运日志和原始价格，检查成功才提交并记录版本。遇到未映射字段或约束冲突会回滚，避免静默丢数据。重复启动不会再次导入。

v2 将信号主键升级为 `(round,target_seconds)`；从 v1 升级前自动生成 `data/trading.sqlite.pre-v2-时间戳.sqlite`，原有信号按已记录的目标秒数迁入，缺失目标秒数的旧记录按旧版默认 5 秒处理。交易、配置、余额和其他历史表保持原值。

v3 新增 `order_predictions`。升级前备份到 `data/trading.sqlite.pre-v3-时间戳.sqlite`。预测仅在场次结束后，基于相同场次、相同 TWAP 窗口的 Polymarket 起始/终止价生成，并保留第一次有效预测的完整依据。官方结算到达时写入 `verified_at/matches`，预测本身不覆盖实际 `orders.status/pnl/payout/settled_at`。

v4 为配置增加 `same_direction_only INTEGER NOT NULL DEFAULT 0`，接口使用布尔值 `sameDirectionOnly`，旧配置默认关闭且保留配置版本 ID；新增 `round_predictions` 保存未参与场次的预计方向。从 v3 升级前自动备份到 `data/trading.sqlite.pre-v4-时间戳.sqlite`。同向检查固定取 `当前场次 round - 300` 的预计方向，在报价前、钱包读取后以及实盘提交前检查本场信号，未通过时不发送买单。

v5 新增 `order_rounds/log_clear_positions`，升级前备份到 `data/trading.sqlite.pre-v5-时间戳.sqlite`。已有订单自动补入独立场次占用表；后续预占时与订单同一事务保存。

v6 新增 `strategy_configs.follow_previous_at_open INTEGER NOT NULL DEFAULT 0`（接口字段 `followPreviousAtOpen`）、`round_openings`、`ticks.oracle_window` 及两张预测表的 `price_at` 毫秒列。升级前备份到 `data/trading.sqlite.pre-v6-时间戳.sqlite`；旧配置保留 ID 且新模式默认关闭。历史报价仅在该场已有信号元数据明确记录同一 TWAP 窗口时回填窗口；无法核实的仍为空，不用于末秒预测。平台预测已获取时优先使用；否则以相同窗口、结束前最后一秒内最后报价即时预测。首次有效预测固定保留，后续接口返回不修改已用于下单的依据，官方结算仍核对并入账。

入场方向下拉框沿用现有列存储：不跟随为两个开关均为 0；同向买入为 `same_direction_only=1,follow_previous_at_open=0`；跟随上一场为 `same_direction_only=0,follow_previous_at_open=1`。旧库两个开关同时为 1 时按跟随模式解释，再次保存下拉设置时转为互斥值。`follow_previous_at_open` 保留兼容字段名，运行时三种模式都使用 `entry_delay`，不再把跟随模式延迟强制归零；无须修改历史配置 ID 或新增数据库迁移。

v7 新增 `strategy_configs.reverse_signal INTEGER NOT NULL DEFAULT 0`（接口字段 `reverseSignal`），从 v6 升级前自动备份到 `data/trading.sqlite.pre-v7-时间戳.sqlite`。旧配置保留 ID，新模式默认关闭；反向模式保存为 `reverse_signal=1` 且另外两个方向开关为 0，接口拒绝混合启用。当前四种模式均遵守 `entry_delay`。反向订单使用 `signal_rule=current_round_reverse`，原始参考价与行情价照常保留；方向变化后的实盘钱包复核与提交前检查仍会执行。历史反向信号按当前配置由原始记录取反生成，原始 `round_signals` 不覆盖。

v8 新增 `entry_diagnostics/entry_diagnostic_levels`，升级前备份到 `data/trading.sqlite.pre-v8-时间戳.sqlite`，既有交易、配置和财务状态不改写。有效入场窗口中的每次受阻检查保留一行依据，报价受阻时额外保留该次盘口；超过截止只新增一次记录，窗口内最近原因仍可查。重复日志按场次和原因代码节流，SQLite 检查依据不被节流丢弃。日志/交易清空不删除诊断证据。旧记录仅有模糊说明时标记 `LEGACY_DETAILS_UNAVAILABLE`，不伪造历史盘口。

`POST /api/paper/orders/clear` 仅删除已结束的模拟订单（won/lost/void/rejected），按外键顺序一并清理盘口档位、盘口、成交 ID、订单预测和状态事件。待处理订单、场次占用、配置、会话统计、余额、累计盈亏及资金轮次保留。`POST /api/paper/logs/clear` 删除 paper 日志，并记录此前共享 system 日志的显示截止 ID；共享原始日志保留给实盘，后续新 system 日志仍可在模拟盘显示。两个写接口沿用同源与控制令牌校验，不提供实盘清空接口。

账户表保留已确认的连败、资金轮次及盈亏。下单时按这些确认值与按场次排序的待结订单预测计算临时资金序列；官方结算按场次顺序入账，已结订单移出预测链后不会再次推进资金序列。页面 `projectedLosses/projectedCycle/projectedCount/nextAmount` 表示这一临时序列，`pnl/balance/wins/settled/cyclePnl` 仍为实际数据。SQLite 重启后由持久化订单和预测重新计算，不会丢失或重复应用预测。未结订单成本保守计入止损敞口；预计兑付不作为可用余额。

单笔金额超限采用轮回复位：当下一笔翻倍金额严格超过 `max_amount`，在未触发最大加倍次数限制的前提下，将资金序列级数 `losses` 置 0、`cycle` 加 1、`cycle_pnl` 归 0，后续按 `base_amount` 继续。`pnl/balance/wins/settled` 和历史订单不因复位修改，旧轮亏损不会消失或退回。预测链与实际结算分别按同一规则推进，官方结果到账移出预测链时不会重复复位。旧版因单笔上限暂停的账户，在重新启动时持久化完成这次复位；服务重启后也不会重复增加轮次。

历史反转按当前页面所选模拟/实盘配置的 `entryDelay` 重新计算。例如入场 10 秒，选用开盘第 10 秒起的第一个 Polymarket 有效报价，最多容许 5 秒采样延迟，不使用第 10 秒之前的价格。实际采样时间在浮层中展示。信号从已保存的同源报价补算并缓存，不同目标秒数之间不会互相覆盖或借用；没有对应窗口数据时返回未记录。该展示用于比较配置规则，已执行交易的原始方向与盈亏不会被改写。

每场固定记录第 **5、10、15、20、35、40、45、50、55、60 秒**的价格与方向；当前模拟/实盘配置的入场时间若不在这组中，会额外采样。采样独立于策略运行/暂停和网页是否打开，只要本地服务持续接收有效行情即可。每条记录保存 `target_seconds`、`observed_at`、`price`、`reference_price`、`direction`、`source`、`rule`、`oracle_window`；实际数据缺失时不造一条占位价格。历史页面读取时也会用已存原始价格补算这组时刻。

订单预占、盘口证据和初始事件一同提交；成交后的账户扣款与订单更新、结算后的余额与盈亏更新保持事务原子性。每个账户模式和场次的唯一约束继续防止重复下单。启用外键、WAL、5 秒忙等待；嵌套写入用 savepoint。服务启动仍先暂停策略；不明实盘提交继续保留并要求核对。

之前已经被两小时价格/2000 条日志清理策略删除的数据、未实际采集的早期信号，以及旧版本未保存的盘口和配置版本，无法补造。本次仅迁移现有数据，并从升级后开始完整保留新增记录。

## 查询示例

```sql
-- 交易时间及盈亏（原始时间戳为毫秒）
SELECT mode, round, direction, created_at, settled_at, cost, status, pnl
FROM orders ORDER BY round DESC;

-- 某笔订单当时使用的首笔金额与风控
SELECT o.id, c.base_amount, c.max_amount, c.stop_loss
FROM orders o LEFT JOIN strategy_configs c ON c.id = o.config_id;

-- 原始价格不会受图表展示两小时的限制
SELECT source, time, price FROM ticks
WHERE source = 'polymarket' AND time BETWEEN 1800000000000 AND 1800000300000
ORDER BY time;
```

## 连续同向反买

`range_configs.streak_reverse_enabled`、`streak_reverse_rounds` 保存开关及连续场数；升级为当前配置创建默认启用、3 场的新版本，历史配置保留关闭状态。

- `range_streak_events`：按配置与预言机窗口保存触发、官方核对及失效事件，包括连续场数、首末场次、市场方向、反买方向和观察时间。
- `range_streak_samples`：每个事件对应的各场结果、来源、起止价独立存行。
- `range_streak_order_signals`：每单的配置、连续场数、触发首末场次、市场方向、买入方向和观察时间。
- `range_streak_order_samples`：该单观察到的逐场结果与价格来源；后续官方修正不改写历史订单依据，清空已结束订单时级联清理。

持续方向从最近仍有效的事件恢复，重启后重新核对市场结果。模拟和实盘各自持久化订单依据。

### 记录级隐藏（schema v9）

- orders.is_hide、logs.is_hide：INTEGER NOT NULL DEFAULT 0，限定 0/1。隐藏为 1，新记录默认为 0。订单结算及状态更新不会改写此字段。
- system_log_visibility(log_id, mode, is_hide)：联合主键 (log_id,mode)，外键关联 logs；共享 system 日志按模拟／实盘分别记录隐藏标志，避免互相影响。
- POST /api/:mode/orders/visibility 或 /logs/visibility，body 为 {"hidden":true/false}，分别隐藏当前模式当前标签已有全部记录或恢复全部隐藏记录，不受分页和状态筛选影响；仍需本机 Origin 与控制令牌。range/gam 使用各自路径前缀及数据库。
- 分页接口仅查询可见记录，返回 hiddenCount。完整导出保留隐藏记录及 isHide（订单）/is_hide（日志）字段。pending、订单占用、策略状态、报表及结算均不按隐藏标记过滤。隐藏不是清空；原有清空按钮仍执行删除。
- v8 自动升级到 v9，已有数据默认可见。旧浏览器 localStorage 隐藏偏好不再读取。

### 历史场次刷新

当前交易页读取 41 场已结束市场（另在前端显示当前场）。后台结算查询按最多 20 个 condition ID 分批执行，单批失败不会丢弃其他批次或已取得的场次起止价。后台策略轮询与页面历史读取共用 round_history；历史接口不等上游请求，先合并并返回 SQLite 中的新结果；开盘保护时段延后补拉，避免内存 pending 缓存遮盖已结算数据。缺失字段不覆盖已保存价格，暂未结算或接口漏项不覆盖已确认结果；新获得的官方价格仍可补齐已结算记录。隐藏交易记录不作用于 round_history。

### 下单原因（schema v10）

orders.entry_reason 为独立 TEXT 字段。订单占用时保存当次策略说明、参考价、蓝色区域条件、开盘后秒数、马丁金额、盘口及成交限价。后续结算、隐藏、配置修改均不重写原因；CSV 使用 entryReason 导出。旧记录为空时，页面仅按该订单已有策略证据还原并标明历史依据，证据不足则明确提示未记录。连续反买只评估本场紧前 N 场；range_streak_events 是审计记录，不再用旧事件替代当前连续窗口。

迁移 v12 新增 strategy_versions（版本编号、名称、规则、首次登记时间）和 orders.strategy_version 外键。新单下单占用时固化版本；旧单保留 NULL，只按已有 signal_rule、config_id 和下单依据分析。版本说明不可用同号覆盖。CSV 同时导出 strategyVersion 和 configId；可按 mode、strategy_version 分组比较已结算订单。

共享图表回看窗口保存于 data/range.sqlite 的 chart_settings 单行表，level_lookback_minutes 默认 60、最短 15、按 5 分钟调整；middle_percent 保存中间蓝色区域占比，首次升级从旧图表边界比例换算，默认 60%，两项均不写入交易策略配置。

三连亏跟随模拟使用独立 `data/loss-follow.sqlite`，新订单登记 LF-004，旧订单沿用原版本。`loss_follow_triggers` 按本盘会话保存触发三场与检测时间；首单前若来源官方结果推翻触发信号，则撤回触发。LF-004 根据本盘上一场成交和相邻市场结果判断是否跳过当前场，沿用 `round_history`、`round_predictions` 和共享场次数据，拦截原因写入现有诊断和日志表。无需数据迁移。

三连亏跟随实盘使用独立的 `data/loss-follow-live.sqlite`，复用标准订单、实时成交核对、`live_redemptions` 与 `loss_follow_triggers` 表。当前版本为 LF-003。模拟源账本只读，跟随触发、订单和风险参数在本盘独立保存。首次建库复制上场方向实盘的首笔和三个风控参数，以 LF-002 或 LF-003 注册记录标识已初始化。LF-003 利用已保存的触发场次和首笔成交判断跳过轮次，拦截原因写入现有诊断和日志表。

### 上场方向布林模拟（已归档）

下线后保留 `data/previous-bollinger.sqlite`，服务不打开该库。历史版本中该库使用标准账户、参数、订单、日志及历史表，交易策略版本仍为 PR-001。首次建库只复制来源模拟盘当前资金参数，以配置初始余额新建独立暂停会话；不复制订单或实际资金。之后重启不再覆盖本盘参数和余额。

`bollinger_settings` 为该库专用单行表（`id=1`），字段：`enabled` INTEGER 0/1；`period` INTEGER 2–200；`deviations` REAL 0.1–10；`interval_seconds` INTEGER 限15/30/60/300；`updated_at` Unix毫秒。默认1/20/2/60。独立表在 `BollingerStore` 创建，标准schema版本不变，既有数据库不受影响。图表参数不参与订单策略配置及入场判断。

指标暖机优先通过只读SQL聚合共享 `data/range.sqlite.range_price_bars`，按预言机窗口隔离；覆盖最近指标周期加31分钟。缺失的已结束K线，后台从官方 crypto-price 接口读取末秒参考快照并写入布林库专用 `bollinger_history_prices`：联合主键 `(oracle_window,price_at)`，`price` REAL正数，`source` TEXT固定 `polymarket_crypto_price`，`observed_at` Unix毫秒。字段独立存储，不写入实时ticks、市场场次结果或交易预测；本地实采桶优先。配置变化后按新周期计算缺失，重启复用已保存参考价，不新增实时行情连接。

### 上场方向震荡区间模拟（已归档）

下线后保留 `data/previous-level-limited.sqlite`，服务不打开该库。该库保存独立标准账户、交易参数版本、订单、日志、历史与LP-001策略版本。首次初始化以来源当前配置创建独立初始余额，后续不再复制或覆盖。标准schema版本保持不变，新增表由 `LevelLimitedStore` 创建：

- `level_limit_settings`：单行 `id=1`；`level_lookback_minutes`（15–1440，5分钟倍数）、`middle_percent`（0–100，不含0，仅图表显示）、`level_lag_minutes`（0–1440，5分钟倍数，首次复制原窗口滞后）、`updated_at`。独立于共享图表及其他模拟盘配置。
- `level_limit_order_signals`：`order_id` 主键及orders外键，`lower_price`、`upper_price`、`observed_price`、`price_at`、`oracle_window`、`levels_round`、`observed_at`。下单占用时同一事务保存区间与报价证据，结算和隐藏不重写；清空已结束订单时一并清理，去重占用仍保留。下单原因也记录确切价格和上下界。

原始区间行情和官方起止价复用共享range库，不复制原盘交易。越界拦截写入本盘entry_diagnostics及运行日志，不创建亏损订单，不推进马丁轮次。
