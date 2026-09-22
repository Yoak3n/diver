# 桌宠互动事件 → Agent（设计草稿）

> 目标：用户对桌宠的拖动等交互，在**闲时**选择性上行给 agent，制造「它有在看」的惊喜感。
> 前提：壳端能**主动**把消息发给 agent（不只是用户在聊天框打字）。
> 状态：**MVP 已在 `feat/pet-interaction-events` 落地**（`/api/event`、Idle Gate、切屏/长拖识别、三档设置、UI「（互动）」）。截图工具与 V2 事件未做。相关：[live2d-pet.md](live2d-pet.md) · [channels.md](channels.md) · [architecture.md](architecture.md)

---

## 1. 问题与原则

现状：桌宠拖动 / 点按 / 切屏都只在壳内处理（窗口移动、Tap 动作），agent 一无所知。
聊天上行目前只有 `POST /api/chat`（用户消息 → `user.followup` / busy 时 `user.steer`）。

要做的是：把**有语义的离散交互**在合适时机变成 agent 可感知的上下文，而不是把原始指针流灌进模型。

**原则：**

1. **闲时才触发** —— agent 输出中或刚聊过 → 丢弃，不打断、不 `steer` 挤进当前回合。
2. **语义事件，不是原始输入** —— 上报「拖到另一块屏幕了」「拖着很久没松手」，不上报每帧坐标。
3. **壳给粗略，模型自取精** —— 壳端随事件附轻量上下文（屏幕 id、分辨率、窗口应用名摘要）；文案里**明确提醒**模型可调用截屏工具亲自查看，且**必须截对屏幕**。
4. **用户可选** —— 「互动感知」分档开关；默认轻量。
5. **可惊喜，不可吵** —— 一次闲时窗口限量触发；重复同类合并；手势必须「有意」。

---

## 2. 「互动感知」模式（用户可选）

| 档位 | 行为 | 默认 |
|---|---|---|
| **关** | 事件不上行，桌宠行为与现在一致 | — |
| **仅事件** | 上行事件元信息 + 壳端粗略上下文（屏幕/窗口应用摘要） | ✅ 建议默认 |
| **带上下文** | 上述 + 更完整窗口标题列表；并允许模型走截屏工具深挖 | 显式开启 |

设置落点：主窗口设置 → 系统 → 桌宠（与「桌宠形象 / 大小」同组），桌宠 `⋯` 可快捷切换档位。

**调试参数（先暴露，方便调手感）**——同一设置组下的折叠区「互动调试」：

| 参数 | 初值 | 说明 |
|---|---|---|
| `quietMs` | 10000 | 距上一条对话静默多久算「闲」 |
| `cooldownMs` | 45000 | 两次互动触发最小间隔 |
| `maxTriggers` | 1 | 一段闲时窗口内最多主动搭话次数 |
| `longHoldMs` | 3000 | 长拖未松手的有意阈值 |

先常量可改（设置面板写入 diver-settings），不单独做「高级 JSON」。

隐私边界：

- 壳端默认只报**应用名 + 窗口数**；完整标题列表归「带上下文」。
- **壳端不主动截屏塞进消息**；截屏由模型按需调用工具（见 §5.3），屏幕参数写进提醒文案，避免截错显示器。
- 将来若做「截图进记忆」，另开设计，不在本稿。

---

## 3. 事件白名单（候选）

只收**离散、有情绪/情境含义**的交互。原始拖动轨迹、悬停、普通单击不进候选。

| 事件 id | 触发 | 基础字段 | 壳端粗略上下文 |
|---|---|---|---|
| `pet.drag.screen_changed` | 拖动过程中桌宠所在显示器 id 变化 | `fromScreen`, `toScreen`, `dragging` | 目标屏分辨率/是否主屏、应用名摘要 |
| `pet.drag.long_hold` | **拖动过程中**按住超过 `longHoldMs` 仍未松手（边拖边报，符合直觉） | `holdMs`（到采样时刻）, `dragging: true` | 当前屏应用名摘要 |
| `pet.drag.dropped_edge` | 松手时贴近屏幕边缘 / 被夹回工作区 | `edge`: left/right/top/bottom | — |
| `pet.tap.burst` | 短时间连点（如 5s 内 ≥4 次） | `count`, `spanMs` | — |
| `pet.drag.shake` | 短时间往复大幅位移后松手（V2） | `amplitude`, `durationMs` | — |
| `pet.long_idle_greet` | 闲置很久后被碰（V2） | `idleMs` | — |

**「有意」判定（防误触）：**

- `long_hold`：必须进入**拖动会话**（已 `set_pet_dragging` / 位移超过死区）且持续 ≥ `longHoldMs`（默认 3s），静止悬停不算。
- `screen_changed`：显示器 id 变化本身即离散；同一拖动会话只报一次（首次跨屏）。
- `dropped_edge` / `shake` / `burst`：各自带幅度或次数阈值，宁漏报不误报。
- 同一物理手势只报**一个**主事件（优先级：`screen_changed` > `long_hold` > `dropped_edge` > 其它）。`long_hold` 在 hold 中触发后，同一会话不再重复报。

**明确不进白名单：** 单次点按、普通拖到同屏另一位置、鼠标移入移出、聊天框输入、拖动过程中的连续坐标。

---

## 4. 闲时门控（消费方约定）

**状态机本体：[companion-presence-fsm.md](companion-presence-fsm.md)**（陪伴运行时存在感总控，壳端全局）。
主动开口是其 **L2 策略 `ProactiveSpeak`** + 能力位 `proactive_inject`；sidecar 只执行 `POST /api/inject`。

| 约定 | 说明 |
|---|---|
| 控制面 | 壳内 `CompanionPresence`；手势经 `invoke` 报 `PET_GESTURE` |
| 唯一入口 | `request({ kind:'proactive_inject', source:'pet-interaction', … })` 通过后才 inject |
| 未过裁决 | **丢弃**（L0/L1/L2 任一 veto）。壳内可合并同类手势等下次 |
| 过裁决 | 壳组文案 → `POST /api/inject`（sidecar 无门控 `followup`） |
| 与用户消息 | 互动不占用 `/api/chat` 的 `steer` |
| 产品档位 | 互动 `mode` 只影响文案丰富度 |
| 与 presence | 同一 L0/L2；`maxTriggers` 在 ProactiveSpeak 内管**总**搭话频率 |

> 过渡：backend `idle-gate.ts` + `/api/event` 门控为脚手架，目标见 FSM §11 切片 0。

### 4.1 目标与边界

| 要解决 | 不在本机内 |
|---|---|
| 「现在能不能主动开口」有唯一权威答案 | 具体说什么（interaction / presence 各自组文案） |
| 拒绝原因可枚举、可打日志、可对齐 UI | 事件白名单与手势识别（壳端） |
| 多源（互动 / presence）原子占坑 | agent 回合内部步骤调度 |
| 时间阈值可调、可单测 | 截图等工具可用性 |

### 4.2 设计取向

**相位（派生） + 上下文（事件改写） + 纯函数求值**，不用定时器驱动迁移：

- 所有「过了 X 毫秒」都是 **时间戳差**，由 `phase(now)` / `tryClaim(now)` 在调用点求值。
- 事件只改写上下文；**不** `setTimeout` 改状态。
- 好处：无定时器泄漏/漂移、测试可控（注入 `now`）、多源并发下同步 claim 即原子。
- 代价：没有「到点自动变 ready」的推送——但门控的消费者本来就是事件/30s tick，不需要推送。

不引入 XState / 状态机库；迁移表用普通 `switch` + 单测锁住。

### 4.3 上下文（Context）

| 字段 | 类型 | 谁改写 | 含义 |
|---|---|---|---|
| `mode` | `'off' \| 'events' \| 'context'` | 设置读写 | 产品档位；`off` 时相位锁死 `disabled` |
| `busy` | `boolean` | SSE `agent/status` / `WebState.busy` | 回合进行中 |
| `bootedAt` | `ts` | 创建时 | 防启动瞬间误触发（见 4.7） |
| `lastUserChatAt` | `ts \| 0` | 真人 `user/message`（非 presence/互动） | 闲时窗口锚点 |
| `lastChatAt` | `ts` | 任意 user/assistant 消息、`turn/end` | 静默计时锚点（含主动搭话） |
| `lastProactiveAt` | `ts \| 0` | claim 成功 | 冷却计时锚点 |
| `windowTriggers` | `int ≥ 0` | claim 成功 +1；`noteUserChat` 清零 | 本闲时窗口已搭话次数 |

`getConfig()` 热读：`quietMs` / `cooldownMs` / `maxTriggers`（另有壳端 `longHoldMs`，不进本机）。

### 4.4 相位（派生）与显式状态

**显式状态**只有上下文；**相位**永远是 `phase(ctx, now, cfg)` 的纯函数：

```text
Phase :=
  disabled          // mode = off
| booting           // now - bootedAt < quietMs
| busy              // busy = true          （强制占用，优先于冷却/静默）
| cooling           // 距 lastChatAt < quietMs
| throttled         // 距 lastProactiveAt < cooldownMs
| quota_exhausted   // windowTriggers ≥ maxTriggers
| ready             // 以上皆否 → 可 claim
```

求值优先级（先命中先返回，即拒绝原因优先级）：

```text
disabled → booting → busy → cooling → throttled → quota_exhausted → ready
```

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 320" font-family="-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif">
  <defs>
    <marker id="chev" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10" fill="none" stroke="#4a5568" stroke-width="1.2"/>
    </marker>
  </defs>
  <text x="40" y="28" font-size="14" font-weight="500" fill="#1a202c">Idle Gate 相位（派生）与事件改写</text>
  <rect x="40" y="50" width="90" height="36" rx="8" fill="#f7fafc" stroke="#a0aec0" stroke-width="0.5"/>
  <text x="85" y="72" text-anchor="middle" font-size="12" fill="#2d3748">disabled</text>
  <rect x="160" y="50" width="90" height="36" rx="8" fill="#f7fafc" stroke="#a0aec0" stroke-width="0.5"/>
  <text x="205" y="72" text-anchor="middle" font-size="12" fill="#2d3748">booting</text>
  <rect x="280" y="50" width="80" height="36" rx="8" fill="#fff5f5" stroke="#e53e3e" stroke-width="0.5"/>
  <text x="320" y="72" text-anchor="middle" font-size="12" fill="#c53030">busy</text>
  <rect x="390" y="50" width="90" height="36" rx="8" fill="#fffaf0" stroke="#dd6b20" stroke-width="0.5"/>
  <text x="435" y="72" text-anchor="middle" font-size="12" fill="#c05621">cooling</text>
  <rect x="510" y="50" width="100" height="36" rx="8" fill="#fffaf0" stroke="#dd6b20" stroke-width="0.5"/>
  <text x="560" y="72" text-anchor="middle" font-size="11" fill="#c05621">throttled</text>
  <rect x="40" y="120" width="130" height="36" rx="8" fill="#fffaf0" stroke="#dd6b20" stroke-width="0.5"/>
  <text x="105" y="142" text-anchor="middle" font-size="11" fill="#c05621">quota_exhausted</text>
  <rect x="210" y="120" width="90" height="36" rx="8" fill="#f0fff4" stroke="#38a169" stroke-width="0.5"/>
  <text x="255" y="142" text-anchor="middle" font-size="12" fill="#276749">ready</text>
  <text x="40" y="195" font-size="11" fill="#2d3748">事件改写上下文（非定时迁移）：</text>
  <text x="40" y="216" font-size="11" fill="#718096">USER_CHAT → lastUserChatAt=now, windowTriggers=0, lastChatAt=now</text>
  <text x="40" y="234" font-size="11" fill="#718096">CHAT_ACTIVITY → lastChatAt=now（assistant / turn/end / 主动注入）</text>
  <text x="40" y="252" font-size="11" fill="#718096">BUSY on/off → busy；CLAIM → lastProactiveAt=now, windowTriggers+=1</text>
  <text x="40" y="270" font-size="11" fill="#718096">MODE off/on → mode；BOOT 时 lastChatAt=bootedAt=now（堵住启动秒触发）</text>
  <text x="40" y="298" font-size="11" fill="#718096">ready --tryClaim 成功--&gt; 立刻落入 throttled 或 quota_exhausted（maxTriggers=1 时）</text>
</svg>
```

> 注：图中相位是 **互斥优先级切片**，不是运行时对象图；同时满足 cooling+throttled 时只显示 `cooling`。

### 4.5 事件表

| 事件 | 来源 | 上下文动作 |
|---|---|---|
| `BOOT` | `createIdleGate()` | `bootedAt = now`，`lastChatAt = now`，`lastUserChatAt = 0`，`lastProactiveAt = 0`，`windowTriggers = 0` |
| `MODE(m)` | 设置保存 / 读取热更 | `mode = m` |
| `BUSY(b)` | SSE `agent/status` → `WebState.busy` | `busy = b` |
| `USER_CHAT` | SSE `user/message` 且 `source.kind==='human'` 且非 `[presence]` 前缀 | `noteUserChat(now)` |
| `CHAT_ACTIVITY` | SSE `user/message`（互动/presence）、`assistant/message`、`turn/end` | `noteChat(now)` |
| `CLAIM` | `tryClaim()` 内部成功时 | `lastProactiveAt = now`，`windowTriggers += 1` |
| `EVAL` | 任意 `phase`/`tryClaim`/`snapshot` | **只读**，不改上下文 |

### 4.6 迁移表（上下文改写；相位自动派生）

| 当前相位（调用时） | 事件 | 守卫 | 上下文动作 | 之后相位（典型） |
|---|---|---|---|---|
| any | `MODE(off)` | — | `mode=off` | `disabled` |
| `disabled` | `MODE(events\|context)` | — | `mode=m` | `cooling` 或 `booting` |
| any | `BUSY(true)` | — | `busy=true` | `busy` |
| `busy` | `BUSY(false)` | — | `busy=false` | `cooling`（`lastChatAt` 通常仍新） |
| any | `USER_CHAT` | — | 见事件表 | `cooling`（`windowTriggers` 已清零） |
| any | `CHAT_ACTIVITY` | — | `lastChatAt=now` | `cooling` / `throttled`… |
| `ready` | `CLAIM`（`tryClaim`） | 通过 4.7 全部检查 | `lastProactiveAt=now`，`windowTriggers+=1` | `throttled`；若已达 `maxTriggers` → `quota_exhausted` |
| 非 `ready` | `CLAIM` | — | **不改写** | 不变，返回拒绝原因 |
| any | `EVAL` | — | 无 | `phase(now)` |

**claim 成功后的落地相位**（无定时器，下次 `phase(now)` 自见）：

- `windowTriggers < maxTriggers` → 因 `lastProactiveAt` 刚写入 → `throttled`，直到 `cooldownMs` 到且仍满足静默/非 busy → 回到 `ready`（再 claim 一次）。
- `windowTriggers ≥ maxTriggers`（默认 1）→ `quota_exhausted`，直到下一次 `USER_CHAT` 清零窗口。

### 4.7 `tryClaim(now)` 算法（唯一写入口）

```text
tryClaim(now):
  cfg ← getConfig()
  p   ← phase(ctx, now, cfg)
  if p ≠ ready: return { ok:false, reason: reasonOf(p) }
  // 再次读上下文防 TOCTOU（同 tick 双源）：同步函数内无 await 则天然原子
  ctx.lastProactiveAt ← now
  ctx.windowTriggers  ← ctx.windowTriggers + 1
  return { ok:true }
```

`phase` 伪代码（优先级即短路顺序）：

```text
phase(ctx, now, cfg):
  if ctx.mode = off            → disabled
  if now - ctx.bootedAt < cfg.quietMs → booting
  if ctx.busy                  → busy
  if now - ctx.lastChatAt < cfg.quietMs → cooling
  if ctx.lastProactiveAt > 0
     and now - ctx.lastProactiveAt < cfg.cooldownMs → throttled
  if ctx.windowTriggers ≥ cfg.maxTriggers → quota_exhausted
  return ready
```

**启动语义（必须修的坑）**：`lastChatAt` 不得用 `0`。`BOOT` 时写 `bootedAt = lastChatAt = now`，否则真实 `Date.now()` 下 `now - 0 ≫ quietMs`，进程一启动就能 claim。`booting` 相位与 `cooling` 共用 `quietMs` 语义（「先安静一会儿」）。

### 4.8 拒绝原因 ↔ 相位

| Phase | `reason` | 产品语义 |
|---|---|---|
| `disabled` | `disabled` | 互动感知关 |
| `booting` | `recent_chat` | 刚启动，先别搭话（也可单独 `booting`，建议单独，便于调试） |
| `busy` | `busy` | 正在输出 |
| `cooling` | `recent_chat` | 最近刚对话过 |
| `throttled` | `cooldown` | 上次搭话冷却中 |
| `quota_exhausted` | `max_triggers` | 本闲时窗口次数用尽 |
| — | `deduped` | **不在状态机内**：壳端/调用方合并重复手势时使用 |
| — | `bad_type` / `bad_body` | **不在状态机内**：协议校验 |

建议把 `booting` 从 `recent_chat` 拆成独立 `reason: 'booting'`（协议可加），日志更干净。

### 4.9 接线

| 接线点 | 调用 |
|---|---|
| `createIdleGate()` | `BOOT` |
| 设置 POST `petInteraction` | `MODE(m)` + 热更新 `getConfig` |
| SSE `agent/status` | `BUSY(!!state.busy)` |
| SSE `user/message` 真人 | `USER_CHAT` |
| SSE `user/message` 互动/presence、`assistant/message`、`turn/end` | `CHAT_ACTIVITY` |
| `POST /api/event` | 校验 → `tryClaim` → 成功则组文案 `followup` + `CHAT_ACTIVITY` |
| presence tick | 点火前 `tryClaim`；失败则本 tick 放弃（**不**写入 `fired`，下轮可重试） |
| `/api/chat` | 真人路径走 SSE 自然 `USER_CHAT`，**不**直接碰状态机。互动/presence **禁止**走 busy 时 `agent.steer` |

`tryClaim` 与 `followup` 之间**禁止** `await`（`ensureAgent` 应先就绪或 claim 后再 await 时用「claim 即记 `lastProactiveAt`」语义——宁可多丢一次事件，不可双开回合）。实现顺序建议：

```text
ensureAgent()          // await 可接受
tryClaim()             // 同步，成功才继续
build + followup()     // 禁止再 await 后二次 claim
```

### 4.10 可观测性

- `snapshot(now)` → `{ phase, mode, busy, lastUserChatAt, lastChatAt, lastProactiveAt, windowTriggers, bootingForMs }`
- 每次 `tryClaim` 拒绝时 `console.debug('[idle-gate]', reason, phase)`（或可开关）。
- 可选调试端点 `GET /api/event/debug`（仅 dev）：返回 snapshot，设置页「互动调试」可显示当前相位——**比猜「为何没搭话」省事**。

### 4.11 测试矩阵（单测锁表）

| # | 场景 | 期望 |
|---|---|---|
| 1 | BOOT 后立刻 `tryClaim(now=bootedAt+1)` | `booting` / `recent_chat` |
| 2 | BOOT 后 `now ≥ bootedAt+quietMs` | `ready` → claim 成功 |
| 3 | `USER_CHAT` 后立刻 claim | `cooling` |
| 4 | 静默 ≥ `quietMs` claim | 成功 |
| 5 | claim 成功后立刻再 claim | `throttled`（`cooldown`） |
| 6 | `cooldownMs` 后、`maxTriggers=2` 再 claim | 成功（第 2 次） |
| 7 | 第 2 次后再 claim | `quota_exhausted` |
| 8 | 上一步后 `USER_CHAT` 再等 quiet | 成功（窗口重置） |
| 9 | `BUSY(true)` 时 claim | `busy` |
| 10 | `BUSY(false)` 但仍在 quiet 内 | `cooling` |
| 11 | `MODE(off)` claim | `disabled` |
| 12 | `MODE(off)`→`on` 后 | 按 quiet/冷却正常 |
| 13 | 同步双 `tryClaim`（模拟互动+presence） | 恰一次 `ok:true` |
| 14 | `CHAT_ACTIVITY`（非用户）后 claim | 受 `quietMs` 约束，**不**清 `windowTriggers` |
| 15 | 动态改小 `quietMs` 立刻 claim | 按新 cfg 求值 |

现有 `scripts/smoke-idle-gate.ts` 应升级为上表（或拆 `idle-gate.test.ts`）；实现改写时 **行为兼容**：对外仍导出 `tryClaim` / `noteChat` / `noteUserChat`，内部换相位机。

### 4.12 非目标

- 不用定时器/`setTimeout` 驱动相位迁移
- 不做持久化（进程重启即 BOOT，可接受）
- 不做多 agent / 多窗口仲裁
- 不做「事件队列等门开」（门未开直接丢弃；队列是 V2）

---

### 旧布尔式（被 4.x 取代，仅存档）

```text
idle :=  (agent 当前回合未在流式输出)
     AND (距上一条 user/assistant 消息静默 ≥ quietMs)
     AND (距上次「主动开口」≥ cooldownMs)
     AND (本闲时窗口内已触发次数 < maxTriggers)
```

---

## 5. 消息组装与模型侧深挖

### 5.1 注入形态

复用 presence 的「前缀 + `createUserMessage`」先例，但 `source.kind` 用 `plugin` + `detail`，避免和真人消息混淆（见 §7 SSE 过滤现状）：

```ts
createUserMessage(text, { kind: 'plugin', detail: 'pet-interaction' })
```

文案模板（`type` 决定短语，`payload` 填入粗略上下文）：

```text
[pet-interaction] The user was interacting with your desktop pet while you were idle.
event: pet.drag.screen_changed
detail: They dragged the pet from screen 0 to screen 1 and are still holding it.
context: screen 1 is 2560x1440 (not primary). Open apps on that screen: Chrome×3, Code×1, Explorer×2.
hint: If you want to see what is on that screen, take a screenshot of display 1 (not display 0). Prefer a brief, natural reaction over a report.
```

要点：

- 粗略上下文由**壳端**随事件采集，backend 原样嵌入，不二次猜。
- **hint 固定提醒截对屏幕**（写明 `display N`）；模型若无需看图可以不调工具。
- 语气约束写在 hint：要像搭话，不要像传感器汇报。

### 5.2 会话与 UI 可见性

- 消息进会话历史（支撑「你刚才把我拖到副屏了」的连续上下文）。
- UI：折叠为一行 **「（互动）」**（完整文案可点开展开，调试时有用）。
- agent 的回复正常展示 + TTS + 情绪动作；惊喜来自搭话本身。

### 5.3 模型侧截屏（依赖，尚未有）

现状：仓库内**没有** agent 可调用的截屏工具（`basic-tools` 只有 fs/sh/grep 等；Rust 侧也无屏幕捕获命令）。要做「模型亲自查看」需补：

| 能力 | 建议形态 | 说明 |
|---|---|---|
| 列屏 | 工具 `list_displays` 或复用壳已有 monitor 列表 | 返回 id、分辨率、是否主屏、工作区 |
| 截屏 | 工具 `screenshot`，参数 **必须** `display: number` | 经通道 C `/rpc`（或 backend 代理 invoke）调 Rust 捕获；返回图给多模态，或失败时降级为描述/OCR |
| 窗口列表 | 工具 `list_windows`（可选） | `EnumWindows` → 应用名/标题 |

通道约束（[channels.md](channels.md)）：截图/枚举窗口住在 Rust 时走内部 `/rpc`，**不**给 UI 再开产品 API。工具注册进 `basic-tools` 或独立 `desktop-tools` 插件。

若当前模型不支持图：hint 改为「无法读图则基于粗略上下文简短反应即可」，不硬调截图。

---

## 6. 完整链路：`POST /api/event` → agent

### 6.1 时序（闲时触发成功路径）

```text
┌─────────┐     ┌──────────────┐     ┌──────────────────┐     ┌─────────────┐     ┌──────────┐
│ PetApp  │     │ Tauri / 壳    │     │ @diver/backend   │     │ agent-loop  │     │ LLM / UI │
│ (桌宠窗) │     │ (几何/输入)   │     │ (DIVER_PORT)     │     │ (harness)   │     │          │
└────┬────┘     └──────┬───────┘     └────────┬─────────┘     └──────┬──────┘     └────┬─────┘
     │ pointer 会话     │                      │                      │                 │
     │─────────────────►│ set_pet_dragging     │                      │                 │
     │                  │─────────────────────►│ (仅几何，不进本链路)  │                 │
     │ 语义事件识别      │                      │                      │                 │
     │ (跨屏/长拖…)     │                      │                      │                 │
     │                  │                      │                      │                 │
     │ 本地档位开关+手势阈值                    │                      │                 │
     │                  │                      │                      │                 │
     │  粗略上下文采集（屏幕信息、应用名摘要）   │                      │                 │
     │                  │                      │                      │                 │
     │ POST /api/event ─┼─────────────────────►│                      │                 │
     │                  │                      │ Idle Gate            │                 │
     │                  │                      │  busy? quiet? cool?  │                 │
     │                  │                      │  tryClaimProactive() │                 │
     │                  │                      │                      │                 │
     │                  │                      │ 组装 [pet-interaction]│                │
     │                  │                      │ + detail + context   │                 │
     │                  │                      │ + hint(截对屏)       │                 │
     │                  │                      │                      │                 │
     │                  │                      │ createUserMessage(   │                 │
     │                  │                      │   kind:'plugin',     │                 │
     │                  │                      │   detail:'pet-…')    │                 │
     │                  │                      │ agent.followup(msg) ─┼────────────────►│
     │                  │                      │                      │ wakeDriver      │
     │                  │                      │                      │ turn()          │
     │                  │                      │                      │ preStep.claim   │
     │                  │                      │                      │ session.append  │
     │                  │                      │                      │  ('user/message')│
     │                  │                      │                      │ step() → LLM ───┼────────►
     │                  │                      │                      │                 │  (可选调
     │                  │                      │                      │                 │   screenshot)
     │                  │                      │◄─ session/event ─────┼─────────────────┤
     │                  │                      │ SSE broadcast        │                 │
     │◄─ SSE ───────────┼──────────────────────┤  user/message        │                 │
     │  「（互动）」折叠  │                      │  assistant/chunk…    │                 │
     │  assistant 气泡   │                      │  turn/end            │                 │
     │  TTS / 情绪动作   │                      │                      │                 │
     │◄─ POST 200 ──────┼──────────────────────┤ {accepted:true,      │                 │
     │  {accepted:true,  │                      │  triggered:true}     │                 │
     │   triggered:true} │                      │                      │                 │
```

### 6.2 代码路径对照（对齐现状命名）

| 步骤 | 位置 | 做什么 |
|---|---|---|
| 1. 手势/语义识别 | **PetApp 前端发起**（`src/pet/` pointer/hitbox；拖动会话已有 `set_pet_dragging`） | 去抖、阈值、主事件择一；**不**上报坐标流。理由：语义在手势层，且仅桌宠存活时存在交互。跨屏判定若不稳，可后续下沉 Rust 辅助，事件源仍在前端 |
| 2. 粗略上下文 | `src/tauri.ts` 已有 `list_monitors`；窗口应用摘要需 Rust 新命令 | 只取事件需要的最小字段 |
| 3. HTTP 上行 | 新 `src/api.ts` → `POST /api/event` | 与 `/api/chat` 并列；失败静默（可 debug 日志） |
| 4. 路由 | `cos-plugins/backend/src/handlers.ts` 新增 `/api/event` 分支 | 校验 type/payload；读档位设置 |
| 5. Idle Gate | 新 `idle-gate.ts`；状态更新挂在 `sse.ts` 的 session 监听上 | 不过则 `{accepted:false, reason}` |
| 6. 组消息 | 对齐 `agent.ts` 的 `userMessage` / presence 的 `[presence]` 模式 | `createUserMessage(..., { kind:'plugin', detail:'pet-interaction' })` |
| 7. 注入 | `agent.followup(msg)` → `Agent.send(..., 'next-turn', true)` | **只用 followup**；不用 `steer` / `inject` |
| 8. 开回合 | `agent-loop` `wakeDriver` → `turn` → `preStep.claim` → `session.append('user/message')` → `step` | 与真人消息同一条模型可见路径 |
| 9. 模型可选深挖 | `screenshot` / `list_windows` 工具（待建）→ `/rpc` → Rust | hint 要求截 `display N` |
| 10. 回放 UI | `sse.ts`：`user/message` → `assistant/chunk` / `message` / `tool/*` / `turn/end` | 前端把互动 user 行折叠为「（互动）」；回复照常 TTS/动作 |

### 6.3 `/api/event` 协议

```http
POST /api/event
Content-Type: application/json

{
  "type": "pet.drag.screen_changed",
  "ts": 1730000000123,
  "source": "pet",
  "payload": {
    "fromScreen": 0,
    "toScreen": 1,
    "dragging": true
  },
  "context": {
    "display": { "id": 1, "width": 2560, "height": 1440, "primary": false },
    "apps": ["Chrome×3", "Code×1", "Explorer×2"]
  }
}
```

| 字段 | 说明 |
|---|---|
| `type` | 白名单事件 id；未知 → 400 |
| `ts` | 壳端采集时刻（ms），合并/去重用 |
| `source` | 预留（`pet` / 未来 `tray`…） |
| `payload` | 事件私有字段（§3） |
| `context` | 壳端粗略上下文；缺省则文案里省略 context 行 |

`enrich` 字段取消：丰富策略固定为「壳粗略 + 模型自取精」，避免协议多一档要对齐。

响应：

```json
// 门控未过 / 模式关 —— 200，不是错误
{ "accepted": false, "reason": "busy" | "recent_chat" | "cooldown" | "disabled" | "deduped" | "max_triggers" }

// 已 followup 并唤醒回合
{ "accepted": true, "messageId": "…", "triggered": true }
```

---

## 7. 与现有机制的边界

| 已有 | 关系 |
|---|---|
| `POST /api/chat` | 仍专供用户消息（busy → `steer`）；互动走 `/api/event`，**只 followup** |
| `createUserMessage` `source.kind` | 现有 `'human' \| 'plugin' \| 'goal'`。互动用 `plugin` + `detail: 'pet-interaction'` |
| `sse.ts` 过滤 | 现状：`source.kind !== 'human'` **直接 break，不广播**。需为 `detail === 'pet-interaction'` 开例外，广播 `{ kind:'system', origin:'interaction', content:'（互动）', …}` 或带 `meta.interaction` 让前端折叠 |
| presence | 共用 Idle Gate + `tryClaimProactive()`；文案前缀 `[presence]` vs `[pet-interaction]`；SSE 已有 `origin: 'presence'` 先例 |
| 拖动手柄 / `set_pet_dragging` | 继续只管窗口几何；语义识别挂在同一 pointer 流，互不阻塞 |
| 情绪 → Live2D | 方向相反（agent 说 → 桌宠动）；本设计补（桌宠被玩 → agent 知） |
| TTS 认领 | 搭话回复走同一认领，主窗口/桌宠只读一次 |

---

## 8. 非目标（本稿不做）

- 原始指针/轨迹采集或「操作画像」
- 事件自动写记忆 / 触发任意工具（模型**按需**调截图是另一回事）
- 多桌宠 / 多 agent 闲时仲裁（先单实例）
- 壳端预截屏塞进消息（改由模型自取精）
- 移动端或非 Tauri 壳

---

## 9. 已决（原待定）

| # | 结论 |
|---|---|
| 1 | `quietMs` / `cooldownMs` 等**先暴露到设置**，方便调试手感 |
| 2 | UI 折叠为一行 **「（互动）」** |
| 3 | 壳端只给粗略信息；文案提醒模型可截屏亲自查看，**必须截对屏幕** |
| 4 | `long_hold` 在**拖动过程中**报；阈值偏保守，保证「用户有意」 |
| 5 | Idle Gate **尽量与 presence 复用** |

---

## 10. 建议落地顺序（若做）

1. backend：Idle Gate + `/api/event` + 仅 `screen_changed` / `long_hold`；模式先写死「仅事件」。
2. SSE：互动消息例外广播 + 前端折叠「（互动）」。
3. 设置：三档模式 + 调试参数（§2）。
4. 壳端：事件识别、粗略上下文、`POST /api/event`。
5. `screenshot` / `list_displays`（及可选 `list_windows`）工具 + hint 调通。
6. presence 接入共用门控；V2 事件（shake / burst / idle_greet）。
