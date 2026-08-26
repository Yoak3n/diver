# Live2D 桌宠

启动后屏幕右下角常驻的 **Live2D 桌宠**（陪伴形象的桌面化身），与主窗口并存、
共用同一会话与记忆。

## 渲染

- **栈**：`pixi-live2d-display@0.4` + `pixi.js@7` + Live2D Cubism 4 官方 Core
- **模型**：Live2D 官方示例「Hiyori」（`public/pet/models/Hiyori/`，4.7MB，含 10 个官方动作）
  - 仓库不提交模型文件；首次使用前执行 `pnpm pet:fetch`（或 `node scripts/pet-fetch.mjs`）拉取官方示例包
  - `pet:fetch` 拉取后自动运行 `scripts/gen-motions.mjs` + `scripts/patch-model3.mjs`，
    为模型追加 **7 个情绪动作组**（Happy/Sad/Angry/Surprised/Shy/Nod/Wave）与对应动作文件
- 依赖已 pin：`pixi.js@7` / `pixi-live2d-display@0.4` / `live2dcubismcore`

## 交互

| 交互 | 行为 |
|---|---|
| 点按桌宠 | 随机播放 TapBody 动作（force 优先级，可打断情绪动作） |
| 底部气泡面板 | 直接对话（轻量 SSE 聊天，最近 8 条） |
| 助手回复 | 自动 TTS 朗读 + **口型同步**（`ParamMouthOpenY` 正弦驱动，按文本时长估算） |
| 顶部手柄 | 拖拽移动（`data-tauri-drag-region`） |

## 情绪驱动动作（聊天内容 → Live2D 动作）

桌宠会根据聊天内容自动做出相应动作（借鉴 N.E.K.O 的情绪→动作机制）：

- **推断**：`src/pet/emotion.ts` 对聊天气泡文本做纯前端启发式情绪推断
  （`inferEmotion`），支持中/英/日等多语言关键词表（`public/pet/emotion-map.json`），
  处理否定词（"不开心"）、转折连词（"但/但是/不过"）与程度副词（"非常/有点"）加权
- **触发**：`PetApp.vue` 在用户消息与助手回复到达时调用 `reactToText()` →
  `pet.playEmotion(group)`，按情绪随机播放对应动作组：
  - happy/excited → `Happy`/`Nod`/`Wave`
  - sad → `Sad`/`Nod`；angry → `Angry`；surprised → `Surprised`/`Shy`
  - shy/love → `Shy`/`Happy`；grateful → `Nod`/`Happy`
  - greeting → `Wave`/`Happy`；farewell → `Wave`/`Sad`；agree → `Nod`
- **LLM 输出配合**（`cos-plugins/voice`，`diver:voice` 提示词节）：系统提示词
  引导陪伴 agent 的输出**口语化、短句、情绪色彩明确**（"哈哈太棒了"、"哇真的假的"），
  让前端情绪推断有更可靠的信号——LLM 表达越自然，桌宠动作越生动
- **节流与优先级**（`live2d.ts` `playEmotion`）：
  - 情绪动作以 `MotionPriority.NORMAL(2)` 播放，可抢占 IDLE(1) 随机动作
  - 两次情绪动作间隔 ≥ 2.2s（冷却），避免连续消息触发过密
  - 朗读（口型）期间不触发大动作；点击互动用 `FORCE(3)` 可随时打断
- **动作文件**：`scripts/gen-motions.mjs` 按 Cubism motion3 格式生成
  （段/点计数自动计算，与 pixi-live2d-display 解析器一致），一次性播放后自动回 Idle

## 窗口技术

- Vite 多页构建：`index.html`（主窗口）+ `pet.html`（桌宠，`src/pet/`）
- Rust `WindowType::Pet`：透明 / `decorations: false` / 置顶 / `skip_taskbar` /
  不抢焦点，右下角贴靠定位（`base/window/` 统一管理）
- 常驻：主窗口关闭（隐藏到托盘）不影响桌宠；轻量模式下两者都持续运行

## 会话共享

桌宠与主窗口**共用同一会话/记忆**：两边同时连 sidecar SSE（`usePetChat.ts` vs
`useChat.ts`），消息互通；桌宠面板的对话也会出现在主窗口历史里。

## 代码位置

- `src/pet/`：`PetApp.vue`（气泡面板 + 情绪动作触发）、`live2d.ts`（pixi 渲染 + 口型同步 +
  情绪动作播放控制）、`emotion.ts`（情绪推断）、`usePetChat.ts`（SSE 连接）、`pet.html`（入口）
- `public/pet/emotion-map.json`：情绪 → 关键词 → 动作组映射（可编辑调参）
- `scripts/gen-motions.mjs`：生成情绪动作文件；`scripts/patch-model3.mjs`：动作组声明补丁
- `src-tauri/src/base/window/`：Pet 窗口的创建/定位/状态管理
- `src-tauri/capabilities/pet.json`：桌宠窗口的权限声明
