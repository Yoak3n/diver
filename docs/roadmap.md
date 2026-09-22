# 打包与路线图

## 当前状态

- 版本 0.1.0，`pnpm tauri dev` 全链路可用（sidecar + 本地服务 + 主窗口 + 桌宠）
- Windows 分发：`pnpm bundle:release` 产出 NSIS 安装包
  （**随包 Node + 开放 plugins/**，非 SEA；详见 [分发](distribution.md)、
  插件契约 [plugins.md](plugins.md)）

## 已知限制 / 后续方向

- [x] **打包分发**：随包 Node 方案（node.exe + 引擎/插件全源码，已落地）
      - 安装包含 node.exe + npm + harness 引擎源码（@cos/*）+ plugins 插件源码
      - **完全开放**：引擎与插件都是磁盘 TS 源码；设置页可启停插件
      - release 启动链：随包 node + `companion-bundle.ts`
        （`--profile companion --bundles --plugin-root --harness`）
      - **已放弃 SEA 烘焙**（无 postject、无签名损坏）
- [x] **插件深水区 P1–P5**（契约见 [plugins.md](plugins.md)）
      - P1 类型边界（`@cos/plugin-api`）✅
      - P3 safe profile + preflight + 自动降级 ✅
      - P4 profile 安装/卸载（internal 不可卸）✅
      - P5 `@diver/native-bridge` 原生 RPC 收口 ✅
- [ ] **代码签名**：安装包与 `Diver.exe` 未签名，Windows SmartScreen 会提示；
      分发前建议用 EV 证书签名（或接受提示）。
- [ ] **原生通知**：agent 主动消息到达时托盘通知（`tauri-plugin-notification`）
- [x] **全局快捷键**唤起窗口（`tauri-plugin-global-shortcut`，热插拔：运行时注册/注销，
      设置页「快捷键」Tab 编辑，保存立即生效，无需重启）
- [x] **原生通知**：agent 主动消息/日程提醒到达时托盘通知（`tauri-plugin-notification`；
      Node 侧经 `/rpc notify::show` 触发，前端亦可 invoke `notify`）
- [x] **日程提醒的持久化配置界面**：presence 调度并入 `@diver/backend`（`src/presence.ts`），
      配置存 `$COS_HOME/presence-schedule.json`（不再硬编码 patch）；设置页「日程」Tab
      编辑，30s tick 热生效；到点注入 `[presence]` 主动问候 + 原生通知
- [ ] **语音输入**（麦克风，STT）
- [ ] **日程提醒的持久化配置界面**（presence schedule 目前硬编码在 patch 里）
- [ ] **模型供应商扩展**：自定义 base URL / 自定义 provider
- [x] **模型供应商扩展（自定义 base URL）**：deepseek-official / commandcode 适配器新增
      `baseUrl` 设置字段（`store: 'settings'`，设置面板动态渲染），运行时时读取
      `$COS_HOME/diver-settings.json` 的 `<provider>.baseUrl`，热生效无需重启
      （引擎侧 `LlmAdapter.settingsValue()` helper）
- [ ] **自动更新**：NSIS 安装器可接 tauri-plugin-updater（需先解决签名）

## 技术债 / 注意事项

- 插件 mount 双清单：bundle `cordis.patch.yml` + `plugins.json` catalog（见 plugins.md）
- include 同批 insert 的 disable 依赖 boot 过滤（plugins.md §2.5），改 patch 引擎需回归
- persona / 工具策略 / schedule 等配置在 bundle/profile patch，改动后需重启 sidecar
- 记忆存储在 SQLite；禁用记忆插件不删除数据文件
