# 桌宠互动事件 → Agent（设计草稿）

> 目标：用户对桌宠的拖动等交互，在**闲时**选择性上行给 agent，制造「它有在看」的惊喜感。
> 前提：壳端能**主动**把消息发给 agent（不只是用户在聊天框打字）。
> 状态：讨论稿，未实现。相关：[live2d-pet.md](live2d-pet.md) · [channels.md](channels.md) · [architecture.md](architecture.md)

---

## 1. 问题与原则

现状：桌宠拖动 / 点按 / 切屏都只在壳内处理（窗口移动、Tap 动作），agent 一无所知。
聊天上行目前只有 `POST /api/chat`（用户消息 → `user.followup` / busy 时 `user.steer`）。

要做的是：把**有语义的离散交互**在合适时机变成 agent 可感知的上下文，而不是把原始指针流灌进模型。

**原则：**

1. **闲时才触发** —— agent 输出中或刚聊过 → 丢弃/合并，不打断、不排队挤进当前回合。
2. **语义事件，不是原始输入** —— 上报「拖到另一块屏幕了」「拖着很久没松手」，不上报每帧坐标。
3. **懒丰富** —— 门控通过后才采集上下文（窗口列表 → 可选截图），采集失败不影响事件本身。
4. **用户可选** —— 「互动感知」分档开关；默认轻量，富上下文（截图）显式打开。
5. **可惊喜，不可吵** —— 一次闲时窗口内限量触发；重复同类事件合并。

---

## 2. 「互动感知」模式（用户可选）

| 档位 | 行为 | 默认 |
|---|---|---|
| **关** | 事件不上行，桌宠行为与现在一致 | — |
| **仅事件** | 只上行事件元信息（类型、屏幕 id、时长等） | ✅ 建议默认 |
| **带上下文** | 事件 + 目标屏幕窗口标题摘要；截图 opt-in 再开一档或子开关 | 显式开启 |

设置落点：主窗口设置 → 系统 → 桌宠（与现有「桌宠形象 / 大小」同组），或桌宠 `⋯` 菜单快捷切换。

隐私边界：

- 截图**永不默认**；开启时需二次确认文案说明用途（只给当前会话、不落盘明文图，除非将来显式做「截图进记忆」）。
- 窗口标题可能含敏感信息：默认只报**应用名 + 窗口数**；完整标题列表归在「带上下文」。

---

## 3. 事件白名单（候选）

只收**离散、有情绪/情境含义**的交互。原始拖动轨迹、悬停、普通单击不进候选。

| 事件 id | 触发 | 基础字段 | 可选丰富（带上下文） |
|---|---|---|---|
| `pet.drag.screen_changed` | 拖动过程中桌宠所在显示器 id 变化 | `fromScreen`, `toScreen`, 拖动是否仍进行 | 目标屏分辨率/主屏与否、窗口标题摘要 |
| `pet.drag.long_hold` | 按下拖动超过阈值仍未松手（如 ≥3s） | `holdMs`（到采样时刻） | 当前屏窗口摘要 |
| `pet.drag.shake` | 短时间内往复大幅位移后松手（可选，V2） | `amplitude`, `durationMs` | — |
| `pet.drag.dropped_edge` | 松手时贴近屏幕边缘 / 工作区外再夹回 | `edge`（left/right/top/bottom） | — |
| `pet.tap.burst` | 短时间连点（如 5s 内 ≥4 次） | `count`, `spanMs` | — |
| `pet.long_idle_greet` | 桌宠闲置很久后被碰（可选，V2） | `idleMs` | — |

**明确不进白名单：** 单次点按（已有 Tap 动作即可）、普通拖到同屏另一位置、鼠标移入移出、聊天框输入。

同一物理手势只报**一个**主事件（优先级：`screen_changed` > `long_hold` > `dropped_edge` > 其它），避免「切屏 + 长拖」双报。

---

## 4. 闲时门控（Idle Gate）

事件进入候选队列后，**同时**满足才触发上行：

```text
idle :=  (agent 当前回合未在流式输出)
     AND (距上一条 user/assistant 消息静默 ≥ quietMs)
     AND (距上次互动事件触发 ≥ cooldownMs)
     AND (本闲时窗口内已触发次数 < maxTriggers)
```

建议初值（可进设置或常量，先写死做实验）：

| 参数 | 初值 | 含义 |
|---|---|---|
| `quietMs` | 8–15s | 「最近刚对话过」的冷却，避免刚聊完就搭话 |
| `cooldownMs` | 30–60s | 两次互动触发最小间隔 |
| `maxTriggers` / 闲时窗口 | 1 | 一段静默期最多主动搭话一次；窗口定义 = 自上次触发或上次对话以来 |

门控结果：

| 情况 | 处理 |
|---|---|
| 未过门控 | **丢弃**（不进历史、不排队）。可选：壳内合并进「最近一次同类事件」等下一次门开 |
| 过门控 | 懒丰富 → 组装 system 痕迹 → 注入会话 → **触发一次 agent 回合**（搭话） |
| 注入后 agent 流式中又来事件 | 丢弃；不 `steer` |

与 `/api/chat` 的关键差异：互动事件**禁止**走 busy 时的 `agent.steer` 排队——聊天消息可以插队，搭话不行。

---

## 5. 懒丰富（Enrichment）

仅在门控通过后执行；整体超时（如 500ms）失败则降级为「仅事件」内容。

| 步骤 | 来源 | 内容 | 失败降级 |
|---|---|---|---|
| 1. 屏幕元信息 | 壳已有 `list_monitors` / 转移接口 | 分辨率、是否主屏、工作区 | 省略 |
| 2. 窗口摘要 | Rust 侧新枚举（Win32 `EnumWindows` 等） | 应用名 + 窗口数；「带上下文」时附标题截断列表 | 省略窗口段 |
| 3. 截图（opt-in） | Rust 截目标显示器 | JPEG/PNG 传给 backend，作为多模态附件或描述占位 | 整段省略，不阻塞搭话 |

截图生命周期：默认**不写会话持久化明文**；若模型不支持图，则降级为「（用户开启了截图但当前模型无法读图）」或跳过。

---

## 6. 协议形状：`POST /api/event`

挂在 `@diver/backend`（通道 A，`DIVER_PORT`），与 `/api/chat` 并列。**不是**用户聊天，故不复用 `content` 盲塞。

### 请求

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
  "enrich": "none"          // none | windows | screenshot
}
```

| 字段 | 说明 |
|---|---|
| `type` | 白名单事件 id；未知 type → 400 |
| `ts` | 壳端采集时刻（ms），用于合并/去重 |
| `source` | 预留（`pet` / 未来 `tray`…） |
| `payload` | 事件私有字段（见 §3） |
| `enrich` | 壳端告知 backend 可用的丰富档；backend 也可按自身设置再收紧 |

### 响应

```json
// 门控未过（或模式=关）——正常情况，200 而非错误
{ "accepted": false, "reason": "busy" | "recent_chat" | "cooldown" | "disabled" | "deduped" }

// 已注入并触发搭话
{ "accepted": true, "messageId": "…", "triggered": true }

// 已注入痕迹但按策略未开新回合（若将来要「只记不聊」）
{ "accepted": true, "messageId": "…", "triggered": false }
```

### 注入形态（agent 侧）

优先做**system 痕迹 + 一次 followup**，避免伪装成用户原话：

```text
[system] pet.interaction
  type: pet.drag.screen_changed
  user dragged the pet from screen 0 to screen 1 while not chatting
  context: screen 1 is 2560x1440 secondary; windows: 3×Chrome, 1×Code, …
```

- 进会话历史（便于后续「刚才你把我拖到副屏了」连续上下文）。
- 可见性：主窗口/桌宠气泡**默认不展示**这条 system 行（或折叠为「（互动）」），agent 回复正常展示——惊喜来自搭话本身，而不是暴露探针。
- 与 SSE 关系：沿用现有 `session/*` 广播即可；若需要 UI 折叠，加 `meta: { interaction: true }`。

### 壳端 → backend 数据流

```text
桌宠窗口 (PetApp)
  pointer/手势识别 → 语义事件（去抖、主事件择一）
       │
       ▼
  本地模式开关（关 → 不发）
       │
       ▼
  POST /api/event  ──►  backend Idle Gate
                          │ 不过 → accepted:false（丢弃）
                          │ 过
                          ▼
                       懒丰富（windows / screenshot）
                          │
                          ▼
                       system 痕迹入库 → agent.followup（仅闲时）
                          │
                          ▼
                       SSE 正常流 → 桌宠气泡 / TTS / 情绪动作
```

丰富能力若住在 Rust（窗口枚举、截图）：backend 经现有 `/rpc` 或窄接口向壳要，**不要**为截图再开第三条产品通道（见 [channels.md](channels.md)）。

---

## 7. 与现有机制的边界

| 已有 | 关系 |
|---|---|
| `POST /api/chat` | 仍专供用户消息；互动事件走 `/api/event`，语义分流 |
| 拖动手柄 / `set_pet_dragging` | 继续管窗口几何；事件识别可挂在同一 pointer 流上，互不影响 |
| 情绪 → Live2D 动作 | 方向相反（agent 说 → 桌宠动）；本设计补的是（桌宠被玩 → agent 知） |
| presence / 日程提醒 | 同属「主动开口」，共享闲时门控参数更合理，避免双源抢话 |
| TTS 认领（`tts.ts`） | 搭话回复走同一认领，主窗口/桌宠只读一次 |

---

## 8. 非目标（本稿不做）

- 原始指针/轨迹数据集采集或「操作画像」
- 事件触发工具调用（截图进记忆、写文件等）——若做，另开「互动记忆」设计
- 多桌宠 / 多 agent 抢同一闲时窗口的仲裁（先单实例）
- 移动端或非 Tauri 壳

---

## 9. 待定

1. `quietMs` / `cooldownMs` 初值与是否暴露到设置（建议先常量实验）。
2. system 痕迹在 UI 的折叠样式（完全隐藏 vs 一行「（互动）」）。
3. 截图通道：多模态直传 vs 壳端先跑 OCR/描述再进文本（成本与模型能力）。
4. `long_hold` 是否在 hold 过程中就采样一次（拖着不放时「你在发呆吗」），还是只在松手/超时后报。
5. 与 presence 提醒是否共用同一个 Idle Gate 实例。

---

## 10. 建议落地顺序（若做）

1. `/api/event` + Idle Gate + 仅 `pet.drag.screen_changed` / `pet.drag.long_hold`，模式固定「仅事件」。
2. 设置三档开关 + 事件白名单常量表。
3. 窗口摘要丰富（`enrich: windows`）。
4. 截图 opt-in 与隐私文案。
5. V2 事件（shake / burst / idle_greet）与 presence 门控合并。
