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
//! 触发动作只在 `Pressed`（按下）时执行一次，`Released` 忽略。

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::OnceCell;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::base::window::manager::Manager as WM;
use crate::base::window::pet as pet_win;
use crate::base::window::schema::WindowType;
use crate::config::shortcuts::{
    ShortcutAction, ShortcutBinding, ShortcutsConfig, load_config, save_config,
};

/// 已注册快捷键的运行时映射：`shortcut.id()`（HotKeyId）→ 绑定动作。
struct RegisteredBinding {
    action: ShortcutAction,
}

pub struct ShortcutManager {
    registered: Mutex<HashMap<u32, RegisteredBinding>>,
}

impl ShortcutManager {
    fn new() -> Self {
        Self {
            registered: Mutex::new(HashMap::new()),
        }
    }

    pub fn global() -> &'static Self {
        static INSTANCE: OnceCell<ShortcutManager> = OnceCell::new();
        INSTANCE.get_or_init(Self::new)
    }

    /// 全局快捷键 handler（`Builder::with_handler` 注入）。
    ///
    /// 所有已注册快捷键触发时回调；只处理按下事件，按 `shortcut.id()` 分发动作。
    pub fn handle(&self, app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
        if event.state != ShortcutState::Pressed {
            return;
        }
        let action = {
            let guard = self.registered.lock().unwrap();
            guard.get(&shortcut.id()).map(|b| b.action)
        };
        if let Some(action) = action {
            dispatch_action(app, action);
        } else {
            log::warn!("[shortcut] 未注册的快捷键触发: {}", shortcut);
        }
    }

    /// 启动初始化：读配置，注册全部启用绑定（幂等）。
    pub fn init(&self, app: &AppHandle) {
        let config = load_config(app);
        if let Err(e) = self.sync(app, &config) {
            log::error!("[shortcut] 初始化注册失败: {e}");
        } else {
            let enabled = config.bindings.iter().filter(|b| b.enabled).count();
            log::info!("[shortcut] 已注册 {enabled} 个全局快捷键");
        }
    }

    /// 全量同步：注销全部 → 按配置注册启用项。
    ///
    /// 用于启动与批量变更；单条变更走 [set_binding] / [remove_binding]（热插拔）。
    pub fn sync(&self, app: &AppHandle, config: &ShortcutsConfig) -> Result<(), String> {
        let gs = app.global_shortcut();
        gs.unregister_all().map_err(|e| format!("注销全部快捷键失败: {e}"))?;
        self.registered.lock().unwrap().clear();

        for binding in config.bindings.iter().filter(|b| b.enabled) {
            self.register_one(app, binding)?;
        }
        Ok(())
    }

    /// 热插拔：注册/更新单个绑定（写配置 + 运行时注册）。
    ///
    /// 已存在的绑定（按 id 匹配）先注销旧快捷键，再按新值注册。
    pub fn set_binding(
        &self,
        app: &AppHandle,
        binding: ShortcutBinding,
    ) -> Result<Vec<ShortcutBinding>, String> {
        if binding.id.trim().is_empty() {
            return Err("绑定 id 不能为空".into());
        }
        if binding.accelerator.trim().is_empty() {
            return Err("快捷键不能为空".into());
        }

        let mut config = load_config(app);
        let gs = app.global_shortcut();

        // 先注销旧绑定（若同 id 已存在且 accelerator 不同）。
        if let Some(old) = config.bindings.iter().find(|b| b.id == binding.id) {
            if old.enabled {
                gs.unregister(old.accelerator.as_str())
                    .map_err(|e| format!("注销旧快捷键失败: {e}"))?;
            }
            config.bindings.retain(|b| b.id != binding.id);
        }
        // 冲突检测：同一 accelerator 已被其它启用绑定占用。
        if binding.enabled
            && config.bindings.iter().any(|b| {
                b.enabled
                    && b.id != binding.id
                    && b.accelerator.to_lowercase() == binding.accelerator.to_lowercase()
            })
        {
            return Err(format!(
                "快捷键 {} 已被其它绑定占用",
                binding.accelerator
            ));
        }

        if binding.enabled {
            self.register_one(app, &binding)?;
        }
        config.bindings.push(binding);
        if !save_config(app, &config) {
            return Err("保存快捷键配置失败".into());
        }
        Ok(config.bindings)
    }

    /// 热插拔：移除绑定（写配置 + 运行时注销）。
    pub fn remove_binding(
        &self,
        app: &AppHandle,
        id: String,
    ) -> Result<Vec<ShortcutBinding>, String> {
        let mut config = load_config(app);
        let Some(binding) = config.bindings.iter().find(|b| b.id == id) else {
            return Err(format!("未找到绑定: {id}"));
        };
        if binding.enabled {
            app.global_shortcut()
                .unregister(binding.accelerator.as_str())
                .map_err(|e| format!("注销快捷键失败: {e}"))?;
        }
        config.bindings.retain(|b| b.id != id);
        if !save_config(app, &config) {
            return Err("保存快捷键配置失败".into());
        }
        Ok(config.bindings)
    }

    /// 运行时注册单个绑定（不改配置；调用方负责持久化）。
    fn register_one(&self, app: &AppHandle, binding: &ShortcutBinding) -> Result<(), String> {
        let accelerator = binding.accelerator.trim();
        // 校验语法 + 归一化：先 parse 一次，失败返回可读错误。
        let shortcut: Shortcut = accelerator
            .parse()
            .map_err(|e| format!("快捷键语法错误 ({accelerator}): {e}"))?;
        app.global_shortcut()
            .register(accelerator)
            .map_err(|e| format!("注册 {accelerator} 失败: {e}"))?;
        self.registered.lock().unwrap().insert(
            shortcut.id(),
            RegisteredBinding {
                action: binding.action,
            },
        );
        Ok(())
    }
}

/// 按动作分发到窗口/桌宠（快捷键 handler 同步调用，使用壳内全局管理器）。
fn dispatch_action(app: &AppHandle, action: ShortcutAction) {
    match action {
        ShortcutAction::ShowMain => {
            let _ = WM::global().show_window(WindowType::Main, None);
        }
        ShortcutAction::ToggleMain => {
            let _ = WM::global().toggle_window(WindowType::Main);
        }
        ShortcutAction::TogglePet => {
            if let Err(e) = pet_win::toggle(app) {
                log::error!("[shortcut] toggle pet 失败: {e}");
            }
        }
        ShortcutAction::ShowPet => {
            if let Err(e) = pet_win::set_visible(app, true) {
                log::error!("[shortcut] show pet 失败: {e}");
            }
        }
        ShortcutAction::HidePet => {
            if let Err(e) = pet_win::set_visible(app, false) {
                log::error!("[shortcut] hide pet 失败: {e}");
            }
        }
    }
}
