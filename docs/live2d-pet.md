# Live2D 桌宠

启动后屏幕右下角常驻的 **Live2D 桌宠**（「小潜」的桌面形象），与主窗口并存、
共用同一会话与记忆。

## 渲染

- **栈**：`pixi-live2d-display@0.4` + `pixi.js@7` + Live2D Cubism 4 官方 Core
- **模型**：Live2D 官方示例「Hiyori」（`public/pet/models/Hiyori/`，4.7MB，含 10 个动作）
  - 仓库不提交模型文件；首次使用前执行 `pnpm pet:fetch`（或 `node scripts/pet-fetch.mjs`）拉取官方示例包
- 依赖已 pin：`pixi.js@7` / `pixi-live2d-display@0.4` / `live2dcubismcore`

## 交互

| 交互 | 行为 |
|---|---|
| 点按桌宠 | 随机播放 TapBody 动作 |
| 底部气泡面板 | 直接对话（轻量 SSE 聊天，最近 8 条） |
| 助手回复 | 自动 TTS 朗读 + **口型同步**（`ParamMouthOpenY` 正弦驱动，按文本时长估算） |
| 顶部手柄 | 拖拽移动（`data-tauri-drag-region`） |

## 窗口技术

- Vite 多页构建：`index.html`（主窗口）+ `pet.html`（桌宠，`src/pet/`）
- Rust `WindowType::Pet`：透明 / `decorations: false` / 置顶 / `skip_taskbar` /
  不抢焦点，右下角贴靠定位（`base/window/` 统一管理）
- 常驻：主窗口关闭（隐藏到托盘）不影响桌宠；轻量模式下两者都持续运行

## 会话共享

桌宠与主窗口**共用同一会话/记忆**：两边同时连 sidecar SSE（`usePetChat.ts` vs
`useChat.ts`），消息互通；桌宠面板的对话也会出现在主窗口历史里。

## 代码位置

- `src/pet/`：`PetApp.vue`（气泡面板 + 动作）、`live2d.ts`（pixi 渲染 + 口型同步）、
  `usePetChat.ts`（SSE 连接）、`pet.html`（入口）
- `src-tauri/src/base/window/`：Pet 窗口的创建/定位/状态管理
- `src-tauri/capabilities/pet.json`：桌宠窗口的权限声明
