//! 全局快捷键管理（热插拔：运行时注册/注销，无需重启）。
//!
//! 架构：
//! - 底层用 `tauri-plugin-global-shortcut`，其 `Builder::with_handler` 提供一个
//!   **全局 handler**，任何已注册快捷键触发时都会回调；
//! - [ShortcutManager] 维护 `HotKeyId → (绑定 id, 动作)` 运行时映射，全局 handler
//!   按 `shortcut.id()` 查表分发到窗口/桌宠动作；
//! - 持久化绑定在 `config/shortcuts.rs`（`shortcuts.json`）；**热插拔** =
//!   写配置 + 调用插件运行时 `register` / `unregister`，不重启应用。
//!
//! 快捷键作用域占位（P1-3）：**桌宠窗口不注册全局快捷键**（交互走窗口本身，
//! 多桌宠唤起策略随 P2-3 另行设计）；主窗口只占一个绑定（`is_main` 单槽校验）。
//! 注册冲突（外部程序先占）时**跳过并提示**（先注册者得，OS 仲裁），
//! 不阻断其余绑定注册。
//!
//! 触发动作只在 `Pressed`（按下）时执行一次，`Released` 忽略。
//!
//! 分层：manager.rs 热插拔注册/配置同步 | action.rs 触发动作分发与冲突提示。

mod action;
mod manager;

pub use manager::ShortcutManager;
