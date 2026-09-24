//! 窗口管理器：全局单例 + 状态缓存 + 生命周期入口。
//!
//! 创建细节见 `create`；显示/切换/关闭见 `ops`。AppHandle 与托盘回调由
//! app/setup 注入，本模块不依赖 `crate::app`。

use once_cell::sync::OnceCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager as TauriManager, WebviewWindow, Wry};

use super::super::schema::{WindowState, WindowType};

/// 主窗口显隐 → 托盘菜单文案/勾选（由 app 层注入，shell 不依赖 app::tray）。
type MainVisibleListener = Box<dyn Fn(bool) + Send + Sync>;

pub struct Manager {
    pub(super) configs: HashMap<WindowType, super::super::config::WindowConfig>,
    pub(super) states: Arc<Mutex<HashMap<WindowType, WindowState>>>,
    pub(super) app: OnceCell<AppHandle>,
    pub(super) on_main_visible: Mutex<Option<MainVisibleListener>>,
}

fn default_states() -> HashMap<WindowType, WindowState> {
    HashMap::from([
        (WindowType::Main, WindowState::NotExist),
        (WindowType::Pet, WindowState::NotExist),
    ])
}

impl Manager {
    fn new() -> Self {
        Self {
            configs: super::super::config::WindowConfig::default_config(),
            states: Arc::new(Mutex::new(default_states())),
            app: OnceCell::new(),
            on_main_visible: Mutex::new(None),
        }
    }

    pub fn global() -> &'static Self {
        static INSTANCE: OnceCell<Manager> = OnceCell::new();
        INSTANCE.get_or_init(Self::new)
    }

    /// 注入 AppHandle（app/setup 调用一次）。shell 不摸 app::handle 单例。
    pub fn init(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    /// 注入托盘菜单更新回调（app 层包一层 `tray::update_menu_visible`）。
    pub fn set_main_visible_listener(&self, f: impl Fn(bool) + Send + Sync + 'static) {
        *self.on_main_visible.lock().unwrap() = Some(Box::new(f));
    }

    /// 主窗口显隐变化时通知托盘（无回调则静默）。
    pub fn set_main_window_menu_visible(&self, visible: bool) {
        if let Some(cb) = self.on_main_visible.lock().unwrap().as_ref() {
            cb(visible);
        }
    }

    pub(super) fn app_handle(&self) -> Option<AppHandle> {
        self.app.get().cloned()
    }

    // 获取窗口实例
    pub fn get_window(&self, window_type: WindowType) -> Option<WebviewWindow<Wry>> {
        self.app_handle()
            .and_then(|app| app.get_webview_window(window_type.label()))
    }

    /// 判断窗口是否为「幽灵窗口」：tauri 的 `builder.build()` 是先返回后创建，
    /// 若 WebView2 环境/控制器在事件循环中创建失败（如 HRESULT 0x8007139F），
    /// 错误只被 tauri-runtime-wry 内部 log，应用级注册表里仍残留一个不存在的窗口。
    /// 此后对该窗口的 getter 全部返回 Err——用一次轻量探测即可识别。
    pub(super) fn is_phantom_window(window: &WebviewWindow<Wry>) -> bool {
        window.is_visible().is_err() && window.is_minimized().is_err()
    }

    /// 清理「幽灵窗口」：从 tauri 注册表移除残留的 window/webview 条目并同步缓存状态。
    pub(super) fn purge_phantom_window(&self, window_type: WindowType) {
        log::warn!("[window] 检测到 {:?} 幽灵窗口（WebView2 创建失败残留），清理并重建", window_type);
        if let Some(window) = self.get_window(window_type) {
            let _ = window.destroy();
        }
        self.update_window_state(window_type, WindowState::NotExist);
    }

    /// 获取真实窗口：幽灵窗口先清理，返回 None 让调用方走重建路径。
    pub fn get_real_window(&self, window_type: WindowType) -> Option<WebviewWindow<Wry>> {
        match self.get_window(window_type) {
            Some(window) if Self::is_phantom_window(&window) => {
                self.purge_phantom_window(window_type);
                None
            }
            other => other,
        }
    }

    pub fn update_window_state(&self, window_type: WindowType, state: WindowState) {
        self.states.lock().unwrap().insert(window_type, state);
    }

    pub fn get_cached_window_state(&self, window_type: WindowType) -> WindowState {
        self.states
            .lock()
            .unwrap()
            .get(&window_type)
            .copied()
            .unwrap_or(WindowState::NotExist)
    }

    /// 检查是否所有窗口都已关闭（隐藏或不存在）
    pub fn are_all_windows_closed(&self) -> bool {
        for window_type in &WindowType::all() {
            let state = self.get_cached_window_state(*window_type);
            match state {
                WindowState::VisibleFocused | WindowState::Minimized => {
                    return false; // 有窗口仍然可见或最小化
                }
                WindowState::Hidden | WindowState::NotExist => {
                    // 窗口已隐藏或不存在，继续检查下一个
                }
            }
        }
        true // 所有窗口都已关闭
    }
}
