# 打包与路线图

## 当前状态

- 版本 0.1.0，`pnpm tauri dev` 全链路可用（sidecar + 本地服务 + 主窗口 + 桌宠）
- Windows 分发：`pnpm bundle:release` 产出 NSIS 安装包
  （SEA 单文件 sidecar + perUser 安装，详见 [分发](distribution.md)）

## 已知限制 / 后续方向

- [x] **打包分发**：随包 Node 方案（node.exe + 引擎/插件全源码，已落地）
      - 安装包含 node.exe + npm + harness 引擎源码（@cos/*）+ cos-plugins 插件源码
        （@diver/*）；`pnpm bundle:release` 一键产出 NSIS 安装包。
      - **完全开放**：引擎与插件都是磁盘 TS 源码，用户可改/删/加；随包 npm 支持
        `node install-deps.mjs` 一键装插件依赖、`node plugin-doctor.mjs` 诊断。
      - release 启动链：`Diver.exe` → 随包 node + tsx 跑 companion-bundle.ts
        （--bundles/--plugin-root/--harness），COS_HOME 指向用户数据目录。
      - 无 SEA 烘焙、无 postject、无签名损坏。
- [ ] **代码签名**：安装包与 `Diver.exe` 未签名，Windows SmartScreen 会提示；
      分发前建议用 EV 证书签名（或接受提示）。
- [ ] **原生通知**：agent 主动消息到达时托盘通知（`tauri-plugin-notification`）
- [ ] **全局快捷键**唤起窗口
- [ ] **语音输入**（麦克风，STT）
- [ ] **日程提醒的持久化配置界面**（presence schedule 目前硬编码在 patch 里）
- [ ] **模型供应商扩展**：自定义 base URL / 自定义 provider
- [ ] **自动更新**：NSIS 安装器可接 tauri-plugin-updater（需先解决签名）

## 技术债 / 注意事项

- `crates/diver-memory` 的 `server.rs` 已迁移（HTTP 传输层在 `src-tauri/src/services`），
  仅保留注释说明
- 记忆存储已从 JSON 文件迁到 SQLite，旧的 `$COS_HOME/memory/*.json` 布局文档已废弃
- persona / 工具策略 / schedule 等配置集中在 `cordis.patch.yml`，改动后需重启 sidecar
