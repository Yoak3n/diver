# 陪伴运行时存在感状态机（Companion Presence FSM）

> **全局共享 · 壳端控制面**：状态机描述「陪伴体（Diver）此刻处于何种运行时存在感」，
> 并由此派生**能力矩阵**（能不能主动开口、能不能朗读、能不能播动作、能不能抢打断…）。
>
> **主动开口（Proactive Speak）只是策略消费者之一**——不是本机的全部职责。
> **记忆 Dream（离线巩固）同理**：L2 策略在合适相位发起后台意图，sidecar 执行整理。
> **sidecar 只做执行者**：按已裁决命令跑 agent / 记忆工具 / TTS；不拥有、不流转本状态机。
>
> 状态：设计定稿（职责可拓展；落地从 §11「切片 0」开始；Dream 外延样例见 §7.3）。
> 相关：[pet-interaction-events.md](pet-interaction-events.md) · [channels.md](channels.md) · [architecture.md](architecture.md)
> 旧名：[proactive-idle-fsm.md](proactive-idle-fsm.md)（仅重定向）

---

## 1. 职责定位（从「闲时门控」到「存在感总控」）

| 层 | 名称 | 问什么 | 例子 |
|---|---|---|---|
| L0 | **Presence FSM（本机）** | 陪伴体现在是什么状态？ | `booting` / `receptive` / `engaged` / `working` / `resting` / `disabled` |
| L1 | **能力矩阵** | 该状态下允许哪些对外行为？ | `proactive_inject` / `auto_tts` / **`memory_dream`** / `idle_motion`… |
| L2 | **策略（可插拔）** | 在允许的前提下再收紧吗？ | ProactiveSpeak、**DreamPolicy**、**ExplorePolicy**、**PendingInquiry**、presence 日程、DND… |
| L3 | **执行面** | 把裁决变成动作 | 壳 inject / TTS / Live2D；sidecar `followup` |

**原则：**

1. **FSM 只回答存在感与能力**，不绑死「主动开口」一种产品行为。
2. **策略可插拔**：节流/日程/DND 都是 L2，可增删而不改 L0 迁移表骨架。
3. **sidecar 仍只是执行者**：已裁决命令进、状态回压出。
4. **拓展靠加能力位 / 加策略 / 加正交区**，而不是把新功能硬塞进「idle 布尔与运算」。

---

## 2. 控制面 / 执行面（不变）

| | **壳（控制面）** | **sidecar（执行面）** |
|---|---|---|
| 本 FSM | 唯一属主（进程级单例） | 不持有 |
| 输入 | 手势、日程、设置、用户输入、busy 回压 | — |
| 输出 | 能力查询 + 已裁决命令 | 执行 inject / 会话；上报 busy/turn/message |
| 拓展 | 新源、新策略、新能力位 | 新执行工具（截图、TTS…）仍只执行 |

```text
                    壳 · CompanionPresence（全局）
                    ┌───────────────────────────┐
  源: pet/presence/ │  L0 Presence FSM           │
  tray/设置/用户 ──►│  L1 Capabilities           │
                    │  L2 Policies*              │──► 已裁决动作
                    └────────────┬──────────────┘     (inject/TTS/motion/…)
                                 │ busy/turn 回压           │
                                 ▼                          ▼
                            sidecar 执行面              Live2D / 系统 TTS
                            followup · tools
```

---

## 3. L0 存在感状态图（HSM）

L0 是**层级状态机（HSM）**：父子相位、明确迁移、进入/退出动作；不用「多维切片」糊平层级。
时间阈值不靠定时器迁移：超时由 `EVAL` / 调用点在 `now` 上判定后补发显式事件（如 `QUIET_ELAPSED`）。

### 3.1 状态树

```text
Companion
├── Off                            # disabled
└── On
    ├── Booting
    └── Live                       # 超态
        ├── Resting                # 超态：regime 压制
        │   └── Passive            # 叶：被动应答，不主动
        ├── Attending              # 超态：用户焦点
        │   ├── Ambient            # 超态：在场未入对话
        │   │   ├── Observing      # 叶：感知（默认）
        │   │   └── Receptive      # 叶：可主动 / 可 dream
        │   └── Conversation       # 超态：对话回合
        │       ├── Listening      # 叶
        │       ├── Thinking       # 叶：working
        │       └── Delivering     # 叶：TTS/动作输出
        └── Solitary               # 超态：自我后台
            ├── Dreaming           # 叶：记忆巩固（向内）
            └── Exploring          # 叶：记忆取词 → 互联网探索（向外）
```

对外 `phase()` = **叶子**名：`off` · `booting` · `passive` · `observing` · `receptive` · `listening` · `thinking` · `delivering` · `dreaming` · **`exploring`**。
超态名只用于迁移挂载与调试。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 420" font-family="-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif">
  <defs>
    <marker id="chev" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10" fill="none" stroke="#4a5568" stroke-width="1.2"/>
    </marker>
  </defs>
  <text x="40" y="24" font-size="14" font-weight="500" fill="#1a202c">L0 Companion · 层级状态图（HSM）</text>
  <rect x="250" y="40" width="180" height="36" rx="8" fill="#f7fafc" stroke="#4a5568" stroke-width="0.8"/>
  <text x="340" y="62" text-anchor="middle" font-size="12" fill="#2d3748">Companion</text>
  <rect x="80" y="100" width="140" height="32" rx="8" fill="#f7fafc" stroke="#a0aec0" stroke-width="0.5"/>
  <text x="150" y="120" text-anchor="middle" font-size="12" fill="#2d3748">Off</text>
  <rect x="300" y="100" width="300" height="280" rx="10" fill="#ebf8ff" stroke="#3182ce" stroke-width="0.8"/>
  <text x="320" y="120" font-size="12" fill="#2c5282">On</text>
  <rect x="320" y="130" width="100" height="28" rx="6" fill="#fff" stroke="#a0aec0" stroke-width="0.5"/>
  <text x="370" y="148" text-anchor="middle" font-size="11" fill="#2d3748">Booting</text>
  <rect x="320" y="175" width="260" height="190" rx="8" fill="#f0fff4" stroke="#38a169" stroke-width="0.8"/>
  <text x="336" y="194" font-size="12" fill="#276749">Live</text>
  <rect x="332" y="205" width="236" height="44" rx="6" fill="#fffaf0" stroke="#dd6b20" stroke-width="0.5"/>
  <text x="344" y="222" font-size="11" fill="#c05621">Resting → Passive</text>
  <rect x="332" y="258" width="150" height="96" rx="6" fill="#fff" stroke="#3182ce" stroke-width="0.5"/>
  <text x="344" y="274" font-size="11" fill="#2c5282">Attending</text>
  <rect x="340" y="282" width="130" height="36" rx="4" fill="#ebf8ff" stroke="#3182ce" stroke-width="0.4"/>
  <text x="348" y="294" font-size="10" fill="#2c5282">Ambient</text>
  <text x="348" y="308" font-size="9" fill="#4a5568">Observing / Receptive</text>
  <rect x="340" y="324" width="130" height="24" rx="4" fill="#ebf8ff" stroke="#3182ce" stroke-width="0.4"/>
  <text x="348" y="340" font-size="9" fill="#4a5568">Listen / Think / Deliver</text>
  <rect x="492" y="258" width="76" height="96" rx="6" fill="#faf5ff" stroke="#805ad5" stroke-width="0.5"/>
  <text x="500" y="274" font-size="11" fill="#553c9a">Solitary</text>
  <rect x="500" y="286" width="60" height="22" rx="4" fill="#fff" stroke="#805ad5" stroke-width="0.4"/>
  <text x="500" y="300" text-anchor="middle" font-size="10" fill="#553c9a">Dream / Explore</text>
  <text x="40" y="405" font-size="11" fill="#2d3748">迁移挂超态=全体子态可触发；冲突时内层优先。∥ Regime 正交区见 3.4。</text>
</svg>
```

### 3.2 超态不变式与进出动作

| 超态 | 子态共享保证 | 进入 | 退出 |
|---|---|---|---|
| `On` | `enabled` | 订阅 sidecar 状态 | 取消 dream/输出 |
| `Live` | 已过 boot 缓冲 | 允许策略 tick | — |
| `Resting` | `proactive_inject=否` | 记 `enteredRestingAt` | — |
| `Attending` | 用户优先；dream 让路 | 取消/暂停 dream | — |
| `Ambient` | 未入对话 | — | — |
| `Conversation` | 前台回合 | `engagement=chatting` | `lastTurnEndAt=now` |
| `Solitary` | 不 TTS、不搭话 | 标记 dream 会话 | `DREAM_END` 侧效 |

### 3.3 初始与历史

| 伪状态 | 含义 |
|---|---|
| 根初始 | 按 `enabled` → `Off` 或 `On/Booting` |
| `Live` 初始 | → `Attending` |
| `Attending` 初始 | → `Ambient` |
| `Ambient` 初始 | → `Observing`；`STILL_ELAPSED` → `Receptive` |
| `Conversation` 初始 | → `Listening` |
| `Live` 深历史 `H*` | 从 `Resting`/`Solitary` 回来时回 `Ambient` 子叶，**不**回 `Conversation` |

### 3.4 正交区 Regime（∥ 第二区）

```text
Regime ∥ = Normal | Dnd | QuietHours | Focus | Sleep
```

| 变化 | 主区响应 |
|---|---|
| → rest 系（Dnd/QuietHours/Focus） | `Live` 且非 `Conversation` 叶 → `Resting/Passive` |
| → `Sleep` | 同上，且 `DreamPolicy` 可进/保持 `Solitary/Dreaming` |
| → `Normal` | `Resting` → `Live` 深历史 |

`Conversation` 不被 regime 掐断；本轮 `turn_end` 后再进 `Resting`。

### 3.5 迁移表

源 = **挂载节点**（超态下所有叶皆可触发）。时间类先由 `EVAL` 补发事件。

| ID | 源 | 事件 | 守卫 | 目标 | 动作 |
|---|---|---|---|---|---|
| T01 | `Companion` | `ENABLED(false)` | | `Off` | 取消 dream/探索/输出 |
| T02 | `Off` | `ENABLED(true)` | | `On/Booting` | `bootedAt=now` |
| T03 | `Booting` | `QUIET_ELAPSED` | | `Live/Attending/Ambient/Observing` | |
| T04 | `Live`（非 Conversation） | `REGIME`→rest | | `Resting/Passive` | |
| T05 | `Resting` | `REGIME`→`Normal` | | `Live` 深历史 | |
| T06 | `Live` | `USER_CHAT` | | `Attending/Conversation/Listening` | 取消 dream/explore job |
| T07 | `Conversation/Listening` | `BUSY(true)` | | `Conversation/Thinking` | |
| T08 | `Conversation/Thinking` | `BUSY(false)` | 无待播 | `Conversation/Delivering` 或 `Ambient/Observing` | |
| T09 | `Conversation/Thinking` | `DELIVERING_START` | | `Conversation/Delivering` | |
| T10 | `Conversation/Delivering` | `DELIVERING_END` | 用户仍输入 | `Conversation/Listening` | |
| T11 | `Conversation/Delivering` | `DELIVERING_END` | 否则 | `Ambient/Observing` | `lastTurnEndAt=now` |
| T12 | `Live`（Ambient/Resting） | `DREAM_START` | L1+L2 放行 | `Solitary/Dreaming` | |
| T13 | `Solitary/*` | `USER_CHAT` | | `Conversation/Listening` | 取消 job |
| T14 | `Solitary/*` | `DREAM_END` / `EXPLORE_END` | | `Live` 深历史 | |
| T15 | `Ambient/Observing` | `STILL_ELAPSED` | | `Ambient/Receptive` | |
| T16 | `Ambient/Receptive` | `USER_INPUT_START` | | `Ambient/Observing` | |
| T17 | `Attending/Ambient` | `PET_GESTURE` | | *内部* | 不迁叶；L2.react |
| T18 | `Conversation/*` | `USER_CHAT` | | `Conversation/Listening` | 续写/插话 |
| T19 | `On` | `SHUTDOWN` | | `Off` | |
| T20 | `Live`（Ambient/Resting） | `EXPLORE_START` | L1+L2；**互斥** DREAM | `Solitary/Exploring` | 同刻仅一个 Solitary 叶 |
| T21 | `Solitary/Dreaming` | `EXPLORE_START` | | —（忽略或排队） | dream 优先占道 |

**挂载原则**：能写在 `Live` 的不写到叶；叶只留互斥差异。

### 3.6 冲突优先级

1. **内层优先**（叶 > 子超态 > 父超态）
2. 同层按迁移表注册顺序（T01 最高）
3. Regime 只触发父层跃迁（T04/T05），不改叶
4. 时间用 `EVAL` 补发事件，禁止 `setTimeout` 迁态

### 3.7 叶子 ↔ 旧名映射

| 叶子 | 旧切片名 | 备注 |
|---|---|---|
| `off` | `disabled` | |
| `booting` | `booting` | |
| `passive` | `resting` | |
| `observing` | `observing` | |
| `receptive` | `receptive` | 主动 + dream |
| `listening` | `engaged` | |
| `thinking` | `working` | |
| `delivering` | `delivering` | |
| `dreaming` | `dreaming` | 可打断 |
| `exploring` | （新） | 记忆取词探索，可打断 |

---

## 4. L1 能力矩阵（首版）

行 = 相位，列 = 能力。`●` 允许，`○` 默认否（策略可例外），`—` 无意义。

| 相位 \ 能力 | `accept_user_input` | `accept_steer` | `proactive_inject` | `auto_tts` | **`memory_dream`** | **`web_explore`** | `idle_motion` | `react_to_pet` |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `off` | — | — | — | — | — | — | — |
| `booting` | ○ | — | — | — | — | ○ | ○ |
| `passive` | ● | ○ | — | ○ | **●** | **●** | ● | ○ |
| `observing` | ● | ○ | ○ | ● | **●** | **●** | ● | ● |
| `receptive` | ● | ○ | **●** | ● | **●** | **●** | ● | ● |
| `listening` | ● | ● | — | ● | — | — | ● | ● |
| `thinking` | ●（steer） | ● | — | ○ | — | — | ○ | ○ |
| `delivering` | ● | ● | — | — | — | — | ○ | ● |
| `dreaming` | ●（打断） | ●（让路） | — | — | — | — | ○ | ○ |
| `exploring` | ●（打断） | ●（让路） | — | — | — | **●** | ○ | ○ |

说明：

- **`proactive_inject` 仅 `receptive`**（策略可对 `observing` 破例）。
- **`memory_dream` / `web_explore`**：`receptive` / `observing` / `passive`（Solitary 叶为进行中）。
- `dreaming` / `exploring` 均可被 `USER_CHAT` 打断（T13 同类）。
- 新能力只加列 + 表行，不改 HSM 迁移骨架。

---

## 5. 上下文（Context，L0 真源）

| 字段 | 谁改写 | 说明 |
|---|---|---|
| `enabled` | 设置 | 全局开 |
| `bootedAt` | `BOOT` | |
| `activity` | `BUSY` / `DELIVERING_START/END`（TTS、强制动作） | |
| `engagement` | `USER_INPUT_START/END`、`USER_CHAT`、`CHAT_ACTIVITY` | |
| `regime` | 设置 / 系统勿扰 / 专注模式 | 可扩展键值 |
| `lastUserChatAt` 等 | **不下沉到 L0 通用字段** | 节流时间戳归 **L2 策略私有上下文** |

> 职责拓展后，L0 保持小；`quietMs/cooldownMs/maxTriggers` 是 ProactiveSpeak 的，不进 Presence 通用上下文。

---

## 6. 事件（L0）

| 事件 | 来源 | 维度动作 |
|---|---|---|
| `BOOT` / `SHUTDOWN` | 壳生命周期 | boot |
| `ENABLED(b)` | 设置 | enabled |
| `REGIME(name, on\|off)` | 设置/系统 | regime |
| `BUSY(b)` | sidecar 回压 | activity: working/idle |
| `DELIVERING_START/END` | TTS / 桌宠关键动作 | activity: delivering |
| `DREAM_START/END` | 记忆巩固回合 | activity: dreaming/idle |
| `USER_CHAT` | 真人消息 | engagement: chatting；**打断 dreaming**；通知 L2 |
| `CHAT_ACTIVITY` | assistant/turn/主动注入 | 通知 L2；engagement 视情况 |
| `USER_INPUT_START/END` | 输入框焦点/键入 | engagement: observing/chatting |
| `PET_GESTURE(kind)` | 桌宠手势 | 通知 L2（是否升为 inject 由策略定） |
| `EVAL` | 任意查询 | 只读 |

L2 策略各自订阅同一事件总线（或包装回调），**不**反写 L0 相位，除非策略需要拉 `regime`（如 DND）。

---

## 7. L2 策略接口

```ts
interface PresencePolicy {
  readonly id: string
  /** 在 L0 能力已允许时再收紧；返回 null 表示放行。 */
  veto(ctx: PresenceView, intent: Intent, now: number): null | { reason: string }
  /** 可选：策略私有上下文随事件演进。 */
  onEvent?(ev: PresenceEvent, now: number): void
}

type Intent =
  | { kind: 'proactive_inject'; source: SourceId; text: string }
  | { kind: 'memory_dream'; reason: 'long_idle' | 'quiet_hours' | 'manual'; hint?: string }
  | { kind: 'web_explore'; term: string; reason: 'curiosity' | 'long_idle' | 'sleep'; fromMemoryId?: string }
  | { kind: 'auto_tts'; messageId: string }
  | { kind: 'idle_motion' }
  | { kind: 'react_to_pet'; gesture: string }
```

### 7.1 ProactiveSpeak（首版策略 = 原 Idle Gate）

私有上下文：`lastUserChatAt` / `lastChatAt` / `lastProactiveAt` / `windowTriggers` + cfg。

`veto(intent='proactive_inject')`：

```text
若 L0 不允许 proactive_inject（相位非 receptive/observing）→ 由 L1 拦，不到 L2
booting/quiet/cooldown/quota/source_disabled → veto
否则放行并 CLAIM 记账（成功才 inject）
```

原相位名映射（兼容旧稿）：

| 旧 Proactive Phase | 新模型位置 |
|---|---|
| `disabled` | L0 `disabled` 或 `sourcePolicy` |
| `booting` / `cooling` / `throttled` / `quota_exhausted` | **ProactiveSpeak 私有节流态**（不必是 L0 相位） |
| `busy` | L0 `working` |
| `ready` | L0 `receptive`/`observing` **且** ProactiveSpeak 放行 |

### 7.2 其它策略（占位，不阻塞首版）

| 策略 | 职责 |
|---|---|
| `PresenceSchedule` | 日程到点产生 Intent |
| `DndPolicy` | `regime` 同步 + veto 全部主动 |
| `PetReactionPolicy` | 手势 → 是否记入对话上下文 |
| `IntimacyPolicy`（未来） | 亲密度/频率个性化 |

### 7.3 DreamPolicy（记忆巩固 · 首个外延样例）

对标常见记忆插件的 **dream / offline consolidation**：用户长闲或夜间把短期对话沉淀为长期记忆（去重、抽事实、合并主题），**不必开口**。

| 项 | 设计 |
|---|---|
| 能力 | `memory_dream` |
| Intent | `{ kind: 'memory_dream', reason: 'long_idle' \| 'quiet_hours' \| 'manual' }` |
| 私有上下文 | `lastDreamAt`、`pendingSince`、`budget`（每日上限）、`lastDreamSummary` |
| 启动条件 | L1 允许；距真人聊天 ≥ `dreamIdleMs`（15–30min）；budget 未尽；距上次 dream ≥ 冷却 |
| 夜间增强 | `regime=sleep` / `quiet_hours` 放宽 budget，允许更长回合 |
| 执行 | `request` 通过 → `DREAM_START` → sidecar 跑巩固 → `DREAM_END` |
| 让路 | `USER_CHAT` 取消/暂停 dream，优先对话 |
| 与 ProactiveSpeak | dream **不**占 `windowTriggers`；默认**不** `noteChat`（避免巩固完锁进 cooling） |

**sidecar 执行接口（草案，无门控）：**

```http
POST /api/memory/dream
{ "reason": "long_idle", "hint": "consolidate last 24h" }
→ 202 { "jobId" }
// SSE: dream/start · dream/end · dream/error
// 用户消息：POST /api/memory/dream/:id/cancel
```

记忆插件只暴露 `dream()` 能力；**何时做梦由壳策略裁决**——插件在执行面，时机在控制面。

### 7.4 ExplorePolicy（记忆取词 · 互联网探索 · 与 Dream 对称）

从**过往记忆**里挑一个「词 / 概念」，用互联网向外探索（搜索、摘要、可选读页），把外部视角写回记忆或待说素材。**向内巩固（Dream） vs 向外好奇（Explore）** 同属 `Solitary`，互斥占道。

| 项 | 设计 |
|---|---|
| 能力 | `web_explore` |
| Intent | `{ kind: 'web_explore', term, reason: 'curiosity'\|'long_idle'\|'sleep', fromMemoryId? }` |
| 私有上下文 | `lastExploreAt`、`exploredTerms`（防重复）、`budget`、`pendingTerm` |
| **词从哪来** | 壳策略向 memory **只读检索**：高频实体 / 最近反复出现未解释的词 / 标记为 `to_explore` 的记忆；**不在探索路径上写记忆**（写回在 L3 任务结束时由 memory 插件做） |
| 启动条件 | L1 `web_explore`；与 dream **互斥**（同刻仅一个 `Solitary` 叶）；`exploredTerms` 未含该词（或超过冷却）；budget 未尽；长闲 / `Sleep` 时更积极 |
| 执行 | `EXPLORE_START` → sidecar `POST /api/memory/explore` → 联网检索 + 摘要 → `EXPLORE_END` |
| 让路 | `USER_CHAT` 打断（T13）；结果可转为后续 `proactive_inject` 素材（**另计** ProactiveSpeak 预算） |
| 输出 | 写回 memory（关联 `fromMemoryId`）+ 可选「探索笔记」；默认**不**立刻开口 |

**与 Dream 对比：**

| | Dream | Explore |
|---|---|---|
| 方向 | 向内（沉淀已有对话） | 向外（补外部世界） |
| 输入 | 近期会话/碎片 | 记忆中的一个 term |
| 动作 | 合并、去重、抽事实 | 搜索、摘要、辨析该词 |
| 写回 | 巩固后的长期记忆 | term 的外部卡片 + 链到原记忆 |
| 典型触发 | Sleep / 长闲 | 好奇心、长闲、Sleep 的另一 budget |

**sidecar 执行接口（草案，无门控）：**

```http
POST /api/memory/explore
{ "term": "MXene", "reason": "curiosity", "fromMemoryId": "…", "hint": "…" }
→ 202 { "jobId" }
// SSE: explore/start · explore/end · explore/error
// 打断：POST /api/memory/explore/:id/cancel
```

同样：**何时 explore、探索哪个词由壳策略裁决**；memory 插件提供 `pickTerms()` + `explore(term)`，web 检索工具住在执行面。

### 7.5 PendingInquiry（待问箱 · 与 ask_user 分工）

后台活（Explore / Dream）碰到「只有用户能答」时：**不立刻 `ask_user`、不打断**，把问题 `parked` 进待问箱；用户回到可搭话相位后，由 **ProactiveSpeak 出口**取出提问。

| 项 | 设计 |
|---|---|
| 层级 | L2 小策略 + 一张表（**不是** L0 新相位） |
| 生产者 | `ExplorePolicy` / `DreamPolicy`（及未来后台活）在任务内 `pushInquiry` |
| 消费者 | `ProactiveSpeak` 触发时优先合箱内 `ready` 条目（≤1–2 个/次），再走普通搭话 |
| 状态 | `parked` →（用户离开 Focus/Sleep 等）→ `ready` → `asked` / `expired` / `dismissed` |
| 字段 | `id, source, question, options?, context, createdAt, expiresAt, priority, state` |
| 箱规则 | 同类合并 · 过期丢弃 · 拒答/忽略 → `dismissed` 不再重复 · 探索结果可补 `context` |
| 答案回流 | `asked` 的回答关联回 `fromMemoryId` / explore job，供写回记忆 |

**与同步 `ask_user` 的分工：**

| | `ask_user` 工具 | PendingInquiry |
|---|---|---|
| 时机 | 已在 `Conversation`，用户明显在场 | 后台 `Solitary` / 用户在 `Resting`·Focus·Sleep |
| 形态 | 当回合内立即提问 | 入箱延后，经 ProactiveSpeak 问出 |
| 打断 | 仅在对话流内 | **绝不**为提问打断 dream/explore 用户专注 |

Intent 可扩：`{ kind: 'proactive_inquiry'; inquiryId }` 由 ProactiveSpeak 代理发出；L1 仍看 `proactive_inject` 能力位。

---

## 8. 裁决 API（壳内）

```ts
interface CompanionPresence {
  phase(now?: number): Phase
  can(cap: Capability, now?: number): boolean          // L1
  /** L1 + 全部 L2；成功则策略记账。 */
  request(intent: Intent, now?: number):
    | { ok: true }
    | { ok: false; layer: 'L0' | 'L1' | 'L2'; policy?: string; reason: string }
  snapshot(now?: number): PresenceSnapshot              // 含各策略私有调试块
}
```

执行顺序：

```text
request(intent):
  p ← phase()
  if not L1.can(p, intent.cap) → reject L1/L0
  for pol in policies:
    if v := pol.veto(p, intent): return reject L2
  apply side-effects（策略记账）
  dispatch L3（inject / tts / motion）
```

**原子性**：`request` 同步裁决 + 记账；L3 网络调用可在之后 await，失败记日志、不双 claim。

---

## 9. 与 sidecar 的协议

| 方向 | 内容 |
|---|---|
| 壳 → sidecar | `POST /api/inject`（已裁决）；用户消息仍 `/api/chat` |
| sidecar → 壳 | SSE `busy` / `turn/*` / `message`（回压 L0 activity、L2 记账） |
| 禁止 | sidecar 自跑 quiet/cooldown/DND；旁路 `followup` |

sidecar **重启不重置** L0（除 `activity` 由回压纠正）与 L2 节流——产品运行时在壳。

---

## 10. 源接线

| 源 | 进入 | 裁决 |
|---|---|---|
| 桌宠手势 | `PET_GESTURE` → PetReaction / ProactiveSpeak | `react_to_pet` / `proactive_inject` |
| presence 日程 | `PresenceSchedule` 产出 Intent | `proactive_inject` |
| **记忆 Dream / Explore** | DreamPolicy / ExplorePolicy 产出 Intent | **`memory_dream` / `web_explore`** |
| 用户输入 | `USER_*` | 改 engagement + L2；打断 dreaming |
| TTS 播报 | `DELIVERING_*` | 改 activity；`auto_tts` 能力 |
| 未来 tray/专注/勿扰 | `REGIME` / 新策略 | 能力位 + veto |

---

## 11. 落地顺序（切片）

| 切片 | 交付 | 依赖 |
|---|---|---|
| **0** | L0 壳内纯逻辑 + 事件 + `phase()`；ProactiveSpeak 策略（原 Idle Gate 语义）；`request(proactive_inject)`；sidecar `POST /api/inject` | 无 |
| 1 | busy/turn 回压；pet 手势 → claim → inject；presence 调度迁壳 | 0 |
| 2 | 能力矩阵表驱动 + `auto_tts` / `idle_motion` 接入 | 0 |
| 3 | `regime`（DND/quiet_hours）+ 设置 UI 相位/能力调试 | 0–2 |
| **4** | **Dream / Explore / PendingInquiry + memory `dream()`/`pickTerms()`/`explore()` + `/api/memory/dream|explore`** | 0–2 |
| 5 | 新策略/新能力（亲密度、listen、banner…） | 3–4 |

**兼容**：backend `idle-gate.ts` + `/api/event` **已删除**（全面迁壳）；主动开口唯一入口为壳 `request(proactive_inject)` → `POST /api/inject`。

---

## 12. 测试矩阵（骨架）

### L0

| # | 场景 | 期望 phase |
|---|---|---|
| 1 | BOOT | `booting` → 到时 `receptive` |
| 2 | BUSY on/off | `working` / 回落 |
| 3 | TTS 播报中 | `delivering` |
| 4 | 真人聊着 | `engaged` |
| 5 | regime=dnd | `resting` |
| 6 | enabled=false | `disabled` |
| 7 | 组合：working+dnd | `resting` 优先于 `working`（按 §3 优先级） |

### L1

| # | 场景 | 期望 |
|---|---|---|
| 8 | `receptive` 查 `proactive_inject` | true |
| 9 | `working` 查 `proactive_inject` | false |
| 10 | `resting` 查 `auto_tts` | 可配置（默认 false） |

### L2 ProactiveSpeak

| # | 场景 | 期望 |
|---|---|---|
| 11–20 | 原 Idle Gate 10 条（boot/quiet/cooldown/quota/user_chat/双源…） | 语义等价迁移 |
| 21 | L0 已拒 | 不到 L2 |
| 22 | L2 veto 后无 inject | 无 followup |
| 23 | sidecar 重启 | L2 记账保留 |
| 24 | 主窗关闭 | presence 仍可 request |

### 拓展回归

| # | 场景 | 期望 |
|---|---|---|
| 27 | 短闲 tick | 不发起 dream |
| 28 | 长闲 ≥ dreamIdleMs | 放行，进入 `dreaming` |
| 29 | dream 中用户说话 | 打断 → `engaged` |
| 30 | budget 尽 | veto |
| 31 | 夜间 quiet_hours | 可触发且可更长 |
| 32 | dream 结束 | 回闲相；默认不写 `lastChatAt` |
| 33 | 记忆含未解释词 + 长闲 | Explore 发起，进入 `exploring` |
| 34 | dream 进行中来了 explore | 忽略/排队（T21） |
| 35 | explore 中用户说话 | 打断 → `listening` |
| 36 | 同一 term 已 explore | 防重复 veto |
| 37 | explore 中生成问题 | 入箱 `parked`，不 ask_user |
| 38 | 用户回到 Ambient 且可搭话 | 出箱 1–2 条发出 |
| 39 | 过期 / 拒答 | `expired` / `dismissed`，不重复 |

| # | 场景 | 期望 |
|---|---|---|
| 25 | 新增能力位不影响旧能力 | 矩阵快照测试 |
| 26 | 新策略 veto 顺序稳定 | 策略列表顺序单测 |

---

## 13. 非目标

- sidecar 内 FSM / 策略
- 定时器驱动 L0 迁移
- 一上来做完整 HSM/正交区库
- 情绪/性格引擎（可另机；最多经事件影响策略）

---

## 14. 设计备忘

1. **加功能先问**：新能力位、新策略，还是新维度？优先能力位 → 策略 → 维度 → 相位。**Dream = 能力位 + DreamPolicy + `activity=dreaming`，标准外延路径**。
2. **L0 保持小**；节流/预算/日程永远放 L2。
3. **phase 名稳定对外**。
4. **大脑类后台活（dream / explore / 批处理）** 一律 Intent 进壳裁决，sidecar 不自启；Solitary 叶互斥。
5. 与 [channels.md](channels.md)：壳面裁决，inject/dream 命令走既有通道。
