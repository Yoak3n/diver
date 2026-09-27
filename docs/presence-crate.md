# diver-presence crate 实现指南

> 陪伴状态机的**代码视角**：crate 结构、L0–L3 分层在代码中的落点、公开 API、
> 测试清单。设计语义（状态图、迁移表 T01–T21、裁决流程）以
> [companion-presence-fsm.md](companion-presence-fsm.md) 为准——本文讲代码与
> 设计的对应及已知偏差。

## 分层 ↔ 代码映射

| 层 | 回答的问题 | 代码落点 | 说明 |
|---|---|---|---|
| **L0 HSM** | 现在是什么相位 | `fsm/`（`PresenceFsm`） | 层级状态机，纯逻辑无定时器；状态树嵌套枚举实现，深历史只记 Ambient 子叶；时间事件（QuietElapsed/StillElapsed）由调用方 `evaluate(now)` 补发 |
| **L1 能力矩阵** | 这个相位允许做什么 | `capability.rs` | 表驱动 `can(phase, cap)`；8 个能力位；proactive_inject 仅 receptive 相位放行 |
| **L2 策略** | 什么时候真的执行（节流） | `proactive.rs`（ProactiveSpeak）、`explore.rs`（ExplorePolicy） | quiet/cooldown/max_triggers 与词级冷却+日预算；busy 由 L0/L1 先拦，L2 只管节流；**不反写 L0 相位** |
| **L3 执行** | 待执行的载荷 | 载荷概念，非 crate 模块 | `InjectRequest` / `ExploreRequest` 结构体；执行由壳层发送 HTTP（services 注入） |

裁决门面 `presence/`（`CompanionPresence`，设计 §8）：组合 fsm + proactive +
explore；请求裁决顺序 = **先 L1 能力门、再 L2 veto+claim**，`RequestResult::Reject`
携带 `layer: "L1" | "L2"`。

## 模块清单

| 文件 | 职责 |
|---|---|
| `lib.rs` | 分层说明 + 全部 re-export |
| `types.rs` | 对外契约：`Phase`(10 叶)/`Regime`(5)/`Capability`(8 位)/`Event`(18 变体)/`Intent`(3)/各 Config/`RequestResult`/`now_ms` |
| `fsm/{mod,states,transitions,tests}.rs` | L0：状态树（Companion→On→Booting\|Live→Resting\|Attending\|Solitary）、迁移 T01–T21、`evaluate(now)` |
| `capability.rs` | L1：`can()` 矩阵 + 4 单测 |
| `proactive.rs` | L2：Idle Gate 语义（quiet/cooldown/quota） |
| `explore.rs` | L2：ExplorePolicy（should_wake/veto/claim/release，词冷却+日预算） |
| `presence/{mod,adjudicate,snapshot,tests}.rs` | 裁决门面：boot/handle/evaluate/request/request_web_explore/snapshot |

依赖仅 serde——**无传输层、无定时器**，全部可 `cargo test -p diver-presence`。

## 公开 API 面（壳层消费）

消费方：`src-tauri/src/core/presence.rs`（`PresenceHandle` 按实例注册表——
多实例各一份 FSM，sidecar 回压经 `x-diver-instance` 头路由；桌宠/探索/主动开口
等壳级行为归属 active 实例）、`core/explore_policy/`（web_explore 裁决）、
`core/presence/parse_event.rs`（前端事件名 → `Event`）、
`core/pet_interaction/`（手势事件）。

- 门面：`CompanionPresence::{boot, handle, evaluate, request, request_web_explore,
  explore_should_wake, phase, can, snapshot, set_*_config}`
- 类型：`Event`（前端状态事件解析而来）、`Intent`（ProactiveInject / MemoryDream /
  WebExplore）、`RequestResult`（untagged serde：Accept / Reject{layer, reason}）、
  `InjectRequest`（kind/detail/text，随 payload 注入 session inbox）
- 快照：`PresenceSnapshot`（含 proactive 调试块；explore 快照独立，经
  `explore_policy()` 访问）

## 代码 vs 设计文档已知偏差

以代码为准（`companion-presence-fsm.md` 是设计定稿，未逐条回写）：

1. 设计 §3.1 `Resting→Passive` 有叶子；代码 Resting **无叶子**，`phase()` 直接映射 `Phase::Passive`。
2. 设计 §4 矩阵 booting 行有 ○（条件放行）；代码 `Off | Booting => false`。
3. 设计 §6 事件 `REGIME(name, on|off)` 带载荷、有 `EVAL`；代码是 `Regime(Regime)` / 无载荷 `PetGesture`，`EVAL` 不是事件而是 `evaluate(now)` 方法。
4. 设计 §7.5 PendingInquiry、§7.3 DreamPolicy、§7.2 PresenceSchedule/DndPolicy/PetReactionPolicy **无对应实现**（日程在壳层 `core/presence_schedule`，dream 只占 Intent 位）。
5. 设计 §8 snapshot 含各策略调试块；代码只含 proactive 块。
6. 设计 §8 说 layer 可为 `'L0'`；代码实际只产生 `"L1"/"L2"`。

## 测试（38 个）

- `fsm/tests.rs` 19：迁移主链（t03/t15/t01/t06/t07-t08/t09-t11/t10/t09b/t09c×2/t04-t05/t12-t13/t14/t20-t21/t16/t17 + regime/深历史守卫；t09b/t09c 为 DELIVERING_START 自 Listening/Ambient/Resting 进入 Delivering）
- `capability.rs` 4：矩阵守卫（proactive 仅 receptive / 输入 / dream+explore / auto_tts）
- `proactive.rs` 4：boot 记时间、quiet/cooldown/quota、user_chat 重置、note 不重置
- `explore.rs` 4：claim/veto、词冷却、日预算、should_wake
- `presence/tests.rs` 7：裁决全链（L1 先于 L2、receptive 窗口、regime 阻断、快照形状、explore claim/release）
