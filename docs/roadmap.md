# 打包与路线图

## 当前状态

- 版本 0.1.0，`pnpm tauri dev` 全链路可用（sidecar + 本地服务 + 主窗口 + 桌宠）
- 仅提交 3 个 commit（Initial commit → 记忆管线重构 → 压缩逻辑重构），
  处于早期快速迭代期

## 已知限制 / 后续方向

- [ ] **打包分发**：Node 运行时随包（sidecar 打包策略）
      - 现状：release 构建时 WebView 指向 sidecar 同源静态 UI
        （`DIVER_UI_DIST`），但 sidecar 依赖的 Node 运行时 + `@deepseek-ai/dsh`
        尚未纳入 Tauri bundle
      - 候选：`npx @tauri-apps/cli` 的 externalBin 打包 node.exe + 压缩 harness，
        或 node SEA（single executable application）
- [ ] **原生通知**：agent 主动消息到达时托盘通知（`tauri-plugin-notification`）
- [ ] **全局快捷键**唤起窗口
- [ ] **语音输入**（麦克风，STT）
- [ ] **日程提醒的持久化配置界面**（presence schedule 目前硬编码在 patch 里）
- [ ] **模型供应商扩展**：自定义 base URL / 自定义 provider

## 技术债 / 注意事项

- `crates/diver-memory` 的 `server.rs` 已迁移（HTTP 传输层在 `src-tauri/src/services`），
  仅保留注释说明
- 记忆存储已从 JSON 文件迁到 SQLite，旧的 `$DSH_HOME/memory/*.json` 布局文档已废弃
- persona / 工具策略 / schedule 等配置集中在 `cordis.patch.yml`，改动后需重启 sidecar
