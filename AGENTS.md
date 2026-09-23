# Agent / 维护者约定

本文固化 Rust 侧代码组织与可维护性约束。改代码前先读；新增功能按此落地，禁止再堆「杂物间」模块。

业务架构见 [docs/architecture.md](docs/architecture.md)，目录与运行见 [docs/development.md](docs/development.md)。

## 硬性规范

### 1. 文件长度

- 软限 **300 行**，硬限 **500 行**（含测试）。
- 超过软限就按职责拆文件；不允许「再忍一版」。
- `mod.rs` 只做模块声明与稳定 re-export，不写业务逻辑（`config::load_at` 这类极薄工具除外）。

### 2. 一文件一职责

同一文件禁止混放下列多类内容（除非整体极短）：

| 内容 | 放哪 |
|------|------|
| 领域类型 / 枚举 / 常量 | `types.rs` / `model.rs` |
| 纯逻辑（无 IO、无 Tauri） | 独立纯函数模块，优先可单测 |
| 文件 / 进程 / 网络 IO | `io` / `store` / `process` 等 |
| `#[tauri::command]` | `commands/` 下按领域一个文件 |
| 单元测试 | 同模块 `#[cfg(test)]`，或 `tests_*.rs` 子模块 |

### 3. Command 只做适配

`#[tauri::command]` 函数只允许：

1. 参数 / 类型转换
2. 从 `AppHandle` 取路径、配置、状态
3. 调用 core 逻辑并把结果转成 IPC 类型

禁止在 command 里写业务分支、文件格式细节、进程管理。

### 4. 依赖方向（单向）

```
commands/  →  app/ shell/ core/  →  config/  services/  crates/*
```

- `config/` 不得依赖 `app/` `shell/` `core/` `commands/`
- `crates/*` 不得依赖 `src-tauri`、Tauri、HTTP、进程
- core 逻辑不直接摸全局单例；需要的东西用参数 / `State` 注入
- 需要路径时优先 `&Path` / `PathBuf`，不要为测试逼着构造 `AppHandle`（参考 `config::load_at` / `save_at`）

### 5. 可单测（Rust 端优先）

- 纯函数：几何、解析、prompt 构造、校验、衰减/策略 —— 必须能 `cargo test`，不碰 Tauri。
- IO：拆出「算什么」和「读写什么」；读写用 `Path` 注入，临时目录做测试。
- 避免新增 `static` / `OnceLock` 全局；优先 `tauri::State` 或显式传入的 manager。
- 新 core 模块合入时附带关键路径单测；重构旧模块时顺手补测试，不欠新债。

## 目标模块图（`src-tauri`）

```
src-tauri/src/
├── lib.rs / main.rs     # 入口，保持极薄
├── commands/            # Tauri IPC 薄适配，按领域拆分
│   ├── plugins.rs  tts.rs  pet.rs  presence.rs
│   ├── shortcuts.rs  mcp.rs  system.rs  …
├── app/                 # 组装与生命周期（setup / events / tray / 快捷键绑定）
├── shell/               # 窗口与桌面集成（window / pet 几何动画 / lightweight）
├── core/                # 可单测业务（sidecar / node_runtime / tts / plugins / …）
├── config/              # 持久化配置（保持现有边界）
└── services/            # 本地 axum RPC（供 sidecar 调用）

crates/
├── diver-memory/        # SQLite 记忆（禁网络/进程）
├── diver-presence/      # 陪伴状态机
└── diver-search/        # 搜索引擎
```

历史模块 `base/` 已拆迁完毕（Phase2）：禁止再引入 `base`，新代码只进 `app/` `shell/` `core/` `commands/` 等上表分层。

## 拆分与命名

- 一个 crate / 模块名表达领域，不表达「杂项」「base」「utils」。
- 同领域多文件用目录：`core/sidecar/{mod,process,paths,job_object}.rs`。
- 公共类型放领域内 `types`；跨层 DTO 放靠近 producer 的 `types`，command 层再映射。
- 命名用具体动词/名词（`extract_archive`、`parse_major`），避免 `handle_xxx` / `do_xxx` / `misc`。

## 重构节奏

1. **拆超长文件**（行为不变）：超 500 行的文件按职责拆开。
2. **拆 `base/`**：迁到 `app/` `shell/` `core/`，`mod.rs` 稳定 re-export，编译通过即可合。
3. **去 `AppHandle` 耦合**：command 取数，core 收 `Path` / 配置 / trait。
4. **补关键单测**：优先 pure 逻辑与解析/校验路径。

每步要求：`cargo test` 全绿；能跑则 `pnpm tauri dev` 冒烟主流程（启动 sidecar、聊天、桌宠、设置读写）。

禁止一次性大爆炸重写；每个 PR 只做一层/一组文件，可独立回滚。

## 提交与检查

- 提交信息：`refactor(rust): …` / `test(rust): …` / `docs: …`（与仓库现有风格一致，scope 可按模块细化）。
- 动 Rust 后至少：`cargo test --workspace`（在仓库根）。
- 动 `src-tauri` 模块路径后：更新 [docs/development.md](docs/development.md) 目录结构一节，避免文档漂移。
