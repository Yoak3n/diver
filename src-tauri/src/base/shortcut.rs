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
    /// 录制组合键时挂起：注销全部全局热键，避免 OS 吞掉 keydown。
    suspended: Mutex<bool>,
}

impl ShortcutManager {
    fn new() -> Self {
        Self {
            registered: Mutex::new(HashMap::new()),
            suspended: Mutex::new(false),
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
        if *self.suspended.lock().unwrap() {
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

    /// 录制组合键前调用：注销全部全局热键，让按键事件进入 WebView。
    ///
    /// Windows `RegisterHotKey` 会吞掉已注册组合的 keydown；录制时必须先放开。
    pub fn suspend(&self, app: &AppHandle) -> Result<(), String> {
        let gs = app.global_shortcut();
        gs.unregister_all()
            .map_err(|e| format!("挂起（注销全部快捷键）失败: {e}"))?;
        self.registered.lock().unwrap().clear();
        *self.suspended.lock().unwrap() = true;
        Ok(())
    }

    /// 录制结束后调用：按配置恢复注册。
    pub fn resume(&self, app: &AppHandle) -> Result<(), String> {
        *self.suspended.lock().unwrap() = false;
        let config = load_config(app);
        self.sync(app, &config)
    }

    /// 尽力注销；「本来就没注册」不视为错误（录制挂起后再次注销是正常路径）。
    fn unregister_quiet(&self, app: &AppHandle, accelerator: &str) {
        if let Err(e) = app.global_shortcut().unregister(accelerator) {
            log::debug!("[shortcut] 注销 {accelerator}（可忽略）: {e}");
        }
        self.forget_accelerator(accelerator);
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
    /// 校验全部通过后才改运行时；任一后续步骤失败会回滚，避免
    /// 「OS 已注销但配置文件仍是旧值」的不一致。
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
        let accelerator = binding.accelerator.trim().to_string();

        // 1) 语法校验（失败不触碰运行时）。
        accelerator
            .parse::<Shortcut>()
            .map_err(|e| format!("快捷键语法错误 ({accelerator}): {e}"))?;

        // 2) 冲突检测：同一 accelerator 已被其它启用绑定占用（虚拟移除同 id 旧绑定）。
        if binding.enabled
            && config.bindings.iter().any(|b| {
                b.enabled
                    && b.id != binding.id
                    && b.accelerator.eq_ignore_ascii_case(&binding.accelerator)
            })
        {
            return Err(format!(
                "快捷键 {} 已被其它绑定占用",
                binding.accelerator
            ));
        }

        let old = config.bindings.iter().find(|b| b.id == binding.id).cloned();

        // 3) 运行时切换：先注销旧，再注册新；失败则回滚到旧绑定。
        //    注销失败不阻断（录制挂起时旧键可能已不在 OS 注册表里）。
        if let Some(old) = &old {
            if old.enabled {
                self.unregister_quiet(app, &old.accelerator);
            }
        }
        if binding.enabled {
            if let Err(e) = self.register_one(app, &binding) {
                if let Some(old) = &old {
                    if old.enabled {
                        let _ = self.register_one(app, old);
                    }
                }
                return Err(e);
            }
        }
        // 4) 持久化；失败则回滚运行时到旧绑定。原地更新，保持列表顺序稳定。
        if let Some(slot) = config.bindings.iter_mut().find(|b| b.id == binding.id) {
            *slot = binding.clone();
        } else {
            config.bindings.push(binding.clone());
        }
        if !save_config(app, &config) {
            if binding.enabled {
                self.unregister_quiet(app, &binding.accelerator);
            }
            if let Some(old) = &old {
                if old.enabled {
                    let _ = self.register_one(app, old);
                }
            }
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
        let Some(old) = config.bindings.iter().find(|b| b.id == id).cloned() else {
            return Err(format!("未找到绑定: {id}"));
        };
        if old.enabled {
            self.unregister_quiet(app, &old.accelerator);
        }
        config.bindings.retain(|b| b.id != id);
        if !save_config(app, &config) {
            return Err("保存快捷键配置失败".into());
        }
        Ok(config.bindings)
    }

    /// 从运行时映射移除某 accelerator 对应的 HotKeyId。
    fn forget_accelerator(&self, accelerator: &str) {
        if let Ok(shortcut) = accelerator.parse::<Shortcut>() {
            self.registered.lock().unwrap().remove(&shortcut.id());
        }
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
