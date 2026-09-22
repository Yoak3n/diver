# Live2D 桌宠

启动后屏幕右下角常驻的 **Live2D 桌宠**（陪伴形象的桌面化身），与主窗口并存、
共用同一会话与记忆。

## 渲染

- **栈**：`pixi-live2d-display@0.4` + `pixi.js@7` + Live2D Cubism Core（`public/pet/live2dcubismcore.min.js`，须支持 **moc3 v5** / `MocVersion_50`）
  - YUI 等 Cubism 5 导出模型是 moc3 v5；旧 Core 最高 v4 会在 `reviveMoc` 失败，库只报 `Unknown error`
  - `live2d.ts` 加载前会探测 moc 版本，不匹配时给出可读错误
- **模型目录**：`src/pet/model-catalog.json`（入库）+ `public/pet/models/`（模型本体，不入库）
  - 默认 **Hiyori**（Live2D 官方示例，约 4.7MB，含 10 个官方动作）
  - 可选 **YUI · Lolita / Origin**（来自 [N.E.K.O](https://github.com/Project-N-E-K-O/N.E.K.O)，学习评估用）
  - 拉取：`pnpm pet:fetch`（Hiyori）/ `pnpm pet:models`（Hiyori 缺省时补齐 + YUI 两套）
  - YUI 原包漏声明 `shy` 动作组，安装脚本会按 `shy*.motion3.json` 自动补进 `model3.json`
  - **YUI 角色版权归 Project N.E.K.O.**，仅本地学习/表现力评估，勿打进对外发行包
- **切换模型（页面入口两处）**：
  1. **主窗口设置 → 系统 → 桌宠形象**：完整卡片列表（与桌宠同一套 `PetModelPicker`）
  2. **桌宠聊天面板 → `⋯` → 切换模型**：居中浮层面板，选完即热切换
  - 选择写入 `localStorage`（`diver.pet.modelId`），并广播 `pet://model-changed`（Tauri event + CustomEvent），设置页与桌宠窗口互相热同步
  - 各模型的逻辑动作组（Happy/Sad/TapBody…）经 `groupAliases` 映射到真实组名（YUI 为小写 `happy`…）
  - YUI 额外叠加 `exp3` 表情（`expressionMap`），情绪触发时动作 + 表情同时生效
- `pet:fetch` 拉取 Hiyori 后自动运行 `scripts/gen-motions.mjs` + `scripts/patch-model3.mjs`，
  为 Hiyori 追加 **7 个情绪动作组**（Happy/Sad/Angry/Surprised/Shy/Nod/Wave）与对应动作文件
- 依赖已 pin：`pixi.js@7` / `pixi-live2d-display@0.4` / `live2dcubismcore`

## 交互

| 交互 | 行为 |
|---|---|
| 点按桌宠 | 随机播放 TapBody 动作（force 优先级，可打断情绪动作） |
| 底部气泡面板 | 直接对话（轻量 SSE 聊天，最近 8 条） |
| 助手回复 | 自动 TTS 朗读 + **口型同步**（见下） |
| 顶部手柄 | 拖拽移动（`data-tauri-drag-region`） |

## 口型同步（TTS → Live2D）

- **参数**：`ParamMouthOpenY`（开合）+ `ParamMouthForm`（口型变形）
- **写入时机**：挂在 `internalModel` 的 **`beforeModelUpdate` 事件**（expression/physics 之后、
  `model.update()` 烘焙顶点之前）。`Cubism4InternalModel.update()` 末尾会 `loadParameters()`
  把参数恢复成 motion 快照 —— 在烘焙后或 `setInterval` 里写口型都会被冲掉（嘴几乎不动）
- **响度来源**：`src/tts.ts` 用 `AnalyserNode` 读播放中的 RMS（`getSpeechLevel()`）；无分析器时退回多频正弦
- **参数**：`ParamMouthOpenY` + `ParamMouthForm` +（YUI）`Param71` 齿口
- **YUI 注意**：原包 `Groups.LipSync.Ids` 为空，`pnpm pet:models` 会自动补上标准嘴部参数

## 情绪驱动动作（聊天内容 → Live2D 动作）

桌宠会根据聊天内容自动做出相应动作（借鉴 N.E.K.O 的情绪→动作机制）：

- **推断**：`src/pet/emotion.ts` 对聊天气泡文本做纯前端启发式情绪推断
  （`inferEmotion`），支持中/英/日等多语言关键词表（`public/pet/emotion-map.json`），
  处理否定词（"不开心"）、转折连词（"但/但是/不过"）与程度副词（"非常/有点"）加权
- **触发**：`PetApp.vue` 在用户消息与助手回复到达时调用 `reactToText()` →
  `pet.playEmotion(group)`，按情绪随机播放对应动作组。逻辑组名再经**当前模型**
  的 `groupAliases` 解析（Hiyori：`Happy`；YUI：`happy` 等）：
  - happy/excited → `Happy`/`Nod`/`Wave`
  - sad → `Sad`/`Nod`；angry → `Angry`；surprised → `Surprised`/`Shy`
  - shy/love → `Shy`/`Happy`；grateful → `Nod`/`Happy`
  - greeting → `Wave`/`Happy`；farewell → `Wave`/`Sad`；agree → `Nod`
- **表情叠加（YUI）**：`expressionMap` 把情绪映射到 `exp3` 表情，约 2.8s 后清除，
  与身体动作同时生效，面部更生动
- **LLM 输出配合**（`cos-plugins/voice`，`diver:voice` 提示词节）：系统提示词
  引导陪伴 agent 的输出**口语化、短句、情绪色彩明确**（"哈哈太棒了"、"哇真的假的"），
  让前端情绪推断有更可靠的信号——LLM 表达越自然，桌宠动作越生动
- **节流与优先级**（`live2d.ts` `playEmotion`）：
  - 情绪动作以 `MotionPriority.NORMAL(2)` 播放，可抢占 IDLE(1) 随机动作
  - 两次情绪动作间隔 ≥ 2.2s（冷却），避免连续消息触发过密
  - 朗读（口型）期间不触发大动作；点击互动用 `FORCE(3)` 可随时打断
- **动作文件**：Hiyori 由 `scripts/gen-motions.mjs` 按 Cubism motion3 格式生成
  （段/点计数自动计算，与 pixi-live2d-display 解析器一致），一次性播放后自动回 Idle；
  YUI 使用原包成套动作（每情绪多变体，表现力显著更强）

## 窗口技术

- **入口**：Vite 单页 SPA + hash 路由 `/#/pet`（`src/router.ts`），窗口 URL 为
  `WindowType::Pet.url()`；`public/pet/` 下 Live2D 静态资源仍打包到 `dist/pet/`
- **窗口特性**：Rust `WindowType::Pet` — 透明 / `decorations: false` / 置顶 /
  `skip_taskbar` / 不抢焦点（`base/window/` 统一管理）
- **尺寸**：基准 600×560，支持 50%–200% 缩放（设置 → 系统 → 桌宠大小）。
  常量双端同源：`base/window/pet_geom.rs` ↔ `src/pet/constants.ts`
- **位置**：拖动后持久化到 `pet-window.json`；重启时校验是否落在可见显示器内，
  无效则回退主屏工作区右下角
- **跨窗口/跨屏拖动**（对齐 DSH）：系统 `startDragging` 负责移动；`Moved` 事件
  **只落盘、不 set_position**（拖动中 clamp 会与原生拖动抢位置，导致跨屏闪动）。
  拖动结束后前端调用 `move_pet_window(0,0)` 做软限位（按窗口中心选最近显示器），
  位置调整带 **ease-out 过渡（约 200ms）**，避免归位瞬间跳变。
  **结束判定**：Windows 拖动中鼠标仍按住时 Moved 会持续触发（正常）；
  以「Moved 停歇约 1.5s」为拖动结束（webview 收不到 pointerup），再软限位并
  恢复指针。再次拖动会取消过渡。WebView 层 `disable_drag_drop_handler`。
- **显隐**：**收起 = 销毁窗口实例**（释放 WebView/Canvas，避免后台空转）。
  创建/销毁必须走 async command（`show_pet_window` / `hide_pet_window`），
  禁止主线程同步调用 build/destroy
- **常驻**：主窗口关闭（隐藏到托盘）不影响桌宠

## 点击穿透

- 窗口默认 `setIgnoreCursorEvents(true)` + CSS `pointer-events` 双保险
- **交互范围 = 角色包围盒**：`live2d.ts` 用可见图元顶点 bbox 计算模型真实尺寸，
  生成 `.model-hitbox`（略外扩 8%/5% 以覆盖动作）；PIXI 画布铺满窗口但
  `pointer-events: none`，桌宠两侧/头顶透明空白可穿透鼠标
- **鼠标流**：Rust 独立线程轮询全局光标，16ms 节流 emit `device-mouse-move`；
  前端只对命中框与气泡/面板/提问卡片解除穿透
- 相关代码：`src-tauri/src/base/pet_mouse.rs`、`PetApp.vue` 穿透段、`live2d.ts` hitbox

## 会话共享

桌宠与主窗口**共用同一会话/记忆**：两边同时连 sidecar SSE（`usePetChat.ts` vs
`useChat.ts`），消息互通；桌宠面板的对话也会出现在主窗口历史里。

## 代码位置

- `src/pet/`：`PetApp.vue`（气泡面板 + 情绪动作 + 穿透）、`constants.ts`（几何常量）、
  `live2d.ts`、`emotion.ts`、`usePetChat.ts`
- `src-tauri/src/base/window/pet.rs`：桌宠生命周期 / 位置恢复 / 缩放 / 多屏
- `src-tauri/src/base/window/pet_geom.rs`：尺寸公式（与前端 constants 同源）
- `src-tauri/src/base/pet_mouse.rs`：全局鼠标流
- `src-tauri/src/config/pet_window.rs`：`pet-window.json` 持久化
- `src-tauri/capabilities/pet.json`：桌宠窗口权限

