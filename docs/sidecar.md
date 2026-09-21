# Node sidecar 与 cos harness 接入

agent 大脑是一个**常驻 Node 进程**，运行仓库内自研 **cos harness**（`harness/`，`@cos/*`）。
陪伴插件 `@diver/*` 源码在 `cos-plugins/`（dev）或安装包 `plugins/`（release），
以**统一 loader 契约**挂载；启停状态由壳写在 profile 补丁层。

> **插件组合、启停、壳端管理、深水区分期的权威文档见 [plugins.md](plugins.md)。**
> 本页只保留 sidecar 进程生命周期与 harness 能力接入摘要。

## 角色与生命周期

- sidecar 由 Rust `base/sidecar.rs` 启动，**dev / release 同一契约**：

  | 参数 | dev | release |
  |---|---|---|
  | 入口 | `companion.ts` | `companion-bundle.ts` |
  | Node | 系统 `node` + `tsx` | 随包 `resources/sidecar/node.exe` + tsx loader |
  | `--profile` | `companion` | `companion` |
  | `--plugin-root` | `<repo>/cos-plugins` | `resources/sidecar/plugins` |
  | `--bundles` | `cos-plugins/bundle-companion` | `resources/sidecar/bundles/bundle-companion` |
  | `--harness` | `<repo>/harness` | `resources/sidecar/harness` |
  | `COS_HOME` | `harness/.cos-home` | `%APPDATA%/com.diver.companion/cos` |

- 环境变量：`DIVER_PORT`（默认 53620）、`DIVER_MEMORY_PORT`、`DIVER_SHUTDOWN_TOKEN`、
  `DIVER_UI_DIST`、`DIVER_MCP_CONFIG_FILE`
- stdout 检测 `DIVER_READY` → 状态 Running；主窗口隐藏不影响 sidecar
- 退出：`POST /api/shutdown` → `Child::kill` → Windows Job Object 三级兜底

## 模块解析（摘要）

```text
@cos/*     pluginPaths → harness/packages/<pkg>/src/index.ts
@diver/*   pluginRoot  → <pluginsRoot>/<name>
bundle     --bundles   → cordis.patch.yml insert（mount 真相）
启停        --profile   → $COS_HOME/profiles/companion/cordis.patch.yml
```

共享实现：`harness/packages/sidecar/src/companion-boot.ts`。  
**SEA 已退出 release 路径**（随包 Node + 开放插件目录）。

## dsh 只取框架、不搬交互层

| dsh / cos 能力 | Diver 用法 |
|---|---|
| agent loop（turn/step、流式、工具闭环） | 使用 `@cos/agent-loop` |
| SessionEvent 日志 + JSONL | `@cos/persistence`（通用事件流） |
| tools / systemPrompt / credentials / llm | `@cos/*` 核心行 |
| persona / 传输层 | `@diver/*` 插件（voice / backend） |
| Web UI 交互层 | **不用**，自研 Vue + `@diver/backend` HTTP/SSE |
| profile / bundle / patch | companion profile + `@diver/bundle-companion` |

## Profile 组成

```text
$COS_HOME/profiles/companion/
  package.json          # dsh.profile.bundles（diver 默认空，bundle 经 CLI 显式传入）
  cordis.patch.yml      # 壳管理的 disabled 覆盖（plugins.md §3）
```

组合顺序：`base cordis.yml → bundle insert（boot 过滤 disabled）→ profile patch → …`

## 会话持久化与压缩

- 会话：单会话 `diver-companion` JSONL（`$COS_HOME/sessions/`，明文事件流）
- 压缩：`compaction-basic` 阈值摘要；`compaction/summary` 事件由 `@diver/memory` 内化

## 相关文档

- [plugins.md](plugins.md) — 插件契约与生命周期
- [architecture.md](architecture.md) — 三层架构与启动时序
- [development.md](development.md) — 独立调试 sidecar
- [distribution.md](distribution.md) — 随包 Node 布局
- harness 侧：[../harness/docs/plugins.md](../harness/docs/plugins.md)
