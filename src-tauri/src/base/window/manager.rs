use once_cell::sync::OnceCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{
    Emitter, Error, Manager as TauriManager, WebviewWindow, WebviewWindowBuilder, Wry,
};

use super::{
    config::WindowConfig,
    schema::{WindowState, WindowType, WindowOperationResult},
    position::adjust_float_window_position,
};

use crate::base::lightweight::add_window_listeners;
use crate::base::{handle,tray::update_menu_visible};

pub struct Manager {
    configs: HashMap<WindowType, WindowConfig>,
    states: Arc<Mutex<HashMap<WindowType, WindowState>>>,
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
            configs: WindowConfig::default_config(),
            states: Arc::new(Mutex::new(default_states())),
        }
    }

    pub fn global() -> &'static Self {
        static INSTANCE: OnceCell<Manager> = OnceCell::new();
        INSTANCE.get_or_init(Self::new)
    }

    // 获取窗口实例
    pub fn get_window(&self, window_type: WindowType) -> Option<WebviewWindow<Wry>> {
        handle::Handle::global()
            .app_handle()
            .and_then(|app| app.get_webview_window(window_type.label()))
    }

    /// 判断窗口是否为「幽灵窗口」：tauri 的 `builder.build()` 是先返回后创建，
    /// 若 WebView2 环境/控制器在事件循环中创建失败（如 HRESULT 0x8007139F），
    /// 错误只被 tauri-runtime-wry 内部 log，应用级注册表里仍残留一个不存在的窗口。
    /// 此后对该窗口的 getter 全部返回 Err——用一次轻量探测即可识别。
    fn is_phantom_window(window: &WebviewWindow<Wry>) -> bool {
        window.is_visible().is_err() && window.is_minimized().is_err()
    }

    /// 清理「幽灵窗口」：从 tauri 注册表移除残留的 window/webview 条目并同步缓存状态。
    /// tauri 公开 API 没有移除入口，这里通过 `destroy()` 走内部 Destroyed 事件链，
    /// 由 tauri 的 `on_window_close` 清掉注册表；Destroyed 事件不会为幽灵窗口产生，
    /// 因此兜底直接置 NotExist（后续 get_window 返回 None，走正常重建路径）。
    fn purge_phantom_window(&self, window_type: WindowType) {
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

    fn create_window_inner(
        &self,
        window_type: WindowType,
        url_with_args: Option<&str>,
    ) -> Result<WebviewWindow<Wry>, Error> {
        let app_handle = handle::Handle::global().app_handle().unwrap();
        let config = self
            .configs
            .get(&window_type)
            .ok_or_else(|| Error::FailedToReceiveMessage)?;

        // 检查是否已存在窗口（幽灵窗口视为不存在，先清理再重建）
        if let Some(existing_window) = self.get_real_window(window_type) {
            if let Some(u) = url_with_args {
                if let Ok(current_url) = existing_window.url() {
                    let path = current_url.path();
                    let parsed_url = {
                        if let Some(q) = current_url.query() {
                            format!("{}?{}", path, q)
                        } else {
                            path.to_string()
                        }
                    };
                    if parsed_url != u {
                        // 不同运行环境下url并不一致，tauri自带的naviate又需要传完整的url解析结果，所以这里使用redirect事件，让窗口自行跳转
                        let _ = existing_window.emit_to(window_type.label(), "redirect", u);
                    }
                }
            }

            if existing_window.is_minimized().unwrap_or(false) {
                let _ = existing_window.unminimize();
            }
            let _ = existing_window.show();
            let _ = existing_window.set_focus();

            // 更新缓存状态为可见且有焦点
            self.update_window_state(window_type, WindowState::VisibleFocused);

            return Ok(existing_window);
        }

        // 解析目标 URL：http(s) 开头视为外部地址（sidecar / Vite dev server），
        // 否则为打包内应用路由。
        let url_str = url_with_args
            .map(|u| u.to_string())
            .unwrap_or_else(|| window_type.url());
        let webview_url = if url_str.starts_with("http://") || url_str.starts_with("https://") {
            tauri::WebviewUrl::External(
                url_str
                    .parse()
                    .unwrap_or_else(|_| tauri::Url::parse("about:blank").unwrap()),
            )
        } else {
            tauri::WebviewUrl::App(url_str.clone().into())
        };

        let mut builder = WebviewWindowBuilder::new(
            &app_handle,
            window_type.label().to_string(),
            webview_url,
        )
        .title(config.window_type.title())
        .inner_size(config.inner_size.0, config.inner_size.1)
        .min_inner_size(config.min_inner_size.0, config.min_inner_size.1)
        .decorations(config.decorations)
        .focused(config.focused)
        .skip_taskbar(config.skip_taskbar)
        .always_on_top(config.always_on_top)
        .maximizable(config.maximizable)
        .transparent(config.transparent)
        .shadow(config.shadow)
        // 对齐 DSH builder：关掉 wry 的 drag_drop_handler，恢复 WebView 内
        // HTML5 拖拽（Tauri 默认接管后 iframe/页面内拖动、跨窗口拖放会失效）。
        // 注意不能用 .drag_and_drop(false)：那只影响 tao 窗口层，webview 层依旧禁用。
        // 代价：AllowExternalDrop 防护一并关闭；页面内文本拖放异常时再补
        // WebView2 SetAllowExternalDrop(false)（见 DSH desktop/window.rs）。
        .disable_drag_drop_handler();
        if config.center {
            builder = builder.center();
        }
        if config.float {
            let (x, y) = adjust_float_window_position(&app_handle, config);
            builder = builder.position(x, y);  
        }
        // 桌宠：尺寸按持久化缩放配置推导（创建后由 pet::restore 决定最终位置）
        if window_type == WindowType::Pet {
            let (w, h) = super::pet::logical_size(&app_handle);
            builder = builder.inner_size(w, h).min_inner_size(w, h);
        }

        #[cfg(target_os = "windows")]
        {
            // WebView2 环境创建失败（HRESULT 0x8007139F）的已知诱因之一是多窗口/多环境
            // 共用同一个 user-data 目录时发生竞争（见 tauri#8196）。
            // 每个窗口使用独立的 data_directory 子目录，规避共享环境竞争与残留锁。
            if let Ok(local_dir) = app_handle.path().app_local_data_dir() {
                let data_dir = local_dir.join(format!("EBWebView-{}", window_type.label()));
                builder = builder.data_directory(data_dir);
            }

            // WebView2：原生可拖区域 + 对齐 DSH 的触摸/滚动特性集
            // （ElasticOverscroll 会抢触摸手势，与 msWebView2EnableDraggableRegions 配套）。
            #[allow(unused_mut)]
            let mut args = String::from(
                "--enable-features=msWebView2EnableDraggableRegions \
                 --disable-features=OverscrollHistoryNavigation,msExperimentalScrolling,ElasticOverscroll",
            );
            #[cfg(debug_assertions)]
            if window_type == WindowType::Pet {
                args.push_str(" --remote-debugging-port=9223");
            }
            builder = builder.additional_browser_args(&args);
        }

        log::info!(
            "[window] creating {:?} at url={} size={}x{} transparent={} aot={}",
            window_type,
            url_str.clone(),
            config.inner_size.0,
            config.inner_size.1,
            config.transparent,
            config.always_on_top
        );
        let window = builder.build()?;
        log::info!("[window] {:?} built ok", window_type);
        // 构建返回 Ok 不代表 webview 创建成功（tauri 先返回后创建）。
        // 立即探测一次：幽灵窗口则清理注册表并报错，让上层走重建/失败路径，
        // 避免残留一个永远打不开的"主窗口"。
        if Self::is_phantom_window(&window) {
            log::error!(
                "[window] {:?} build 返回成功但 webview 创建失败（幽灵窗口），清理",
                window_type
            );
            self.purge_phantom_window(window_type);
            return Err(Error::FailedToReceiveMessage);
        }
        if window_type == WindowType::Pet {
            // 桌宠：恢复持久化位置（无效则默认右下角），且不抢焦点。
            super::pet::restore_or_default_position(&window);
        } else {
            window.set_focus()?;
        }
        add_window_listeners(window_type);
        Ok(window)
    }

    fn activate_window(
        &self,
        window: &WebviewWindow<Wry>,
        window_type: WindowType,
    ) -> WindowOperationResult {

        let mut operations_successful = true;

        // 1. 如果窗口最小化，先取消最小化
        if window.is_minimized().unwrap_or(false) {
            if let Err(e) = window.unminimize() {
                println!("取消最小化窗口失败: {:?}", e);
                operations_successful = false;
            }
        }

        // 2. 显示窗口
        if let Err(e) = window.show() {
            println!("显示窗口失败: {:?}", e);
            operations_successful = false;
        }

        // 3. 设置焦点
        if let Err(e) = window.set_focus() {
            println!("设置窗口焦点失败: {:?}", e);
            operations_successful = false;
        }

        // 4. 平台特定的激活策略
        #[cfg(target_os = "windows")]
        {
            // Windows 尝试额外的激活方法
            if let Err(e) = window.set_always_on_top(true) {
                println!("设置窗口置顶失败: {:?}", e);
                operations_successful = false;
            }
            // 立即取消置顶
            if let Err(e) = window.set_always_on_top(false) {
                println!("取消置顶窗口失败: {:?}", e);
                operations_successful = false;
            }
        }

        

        // 更新缓存状态
        if operations_successful {
            self.update_window_state(window_type, WindowState::VisibleFocused);
        }

        if operations_successful {
            WindowOperationResult::Shown
        } else {
            WindowOperationResult::Failed
        }
    }


    pub fn show_window(&self, window_type: WindowType, url: Option<&str>) -> WindowOperationResult {
        // TODO 添加防抖

        let current_state = self.get_cached_window_state(window_type);
                let result = match current_state {
            WindowState::NotExist => {
                match self.create_window_inner(window_type, url) {
                    Ok(_) => {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        WindowOperationResult::Created
                    }
                    Err(e) => {
                        log::error!("[window] 创建 {:?} 失败: {:?}", window_type, e);
                        println!("创建窗口失败: {:?}", e);
                        WindowOperationResult::Failed
                    }
                }
            }
            WindowState::VisibleFocused => {
                // 缓存状态可能过期（X 关闭/任务栏最小化等路径未同步缓存）：
                // 以真实窗口为准——实际隐藏/最小化时自愈激活，避免"点开主窗口没反应"。
                // 幽灵窗口/窗口已不存在：清理后按不存在处理，直接重建。
                if let Some(window) = self.get_real_window(window_type) {
                    let visible = window.is_visible().unwrap_or(true);
                    let minimized = window.is_minimized().unwrap_or(false);
                    if visible && !minimized {
                        let _ = window.set_focus();
                        WindowOperationResult::NoAction
                    } else {
                        self.activate_window(&window, window_type);
                        self.update_window_state(window_type, WindowState::VisibleFocused);
                        WindowOperationResult::Shown
                    }
                } else {
                    match self.create_window_inner(window_type, url) {
                        Ok(_) => WindowOperationResult::Created,
                        Err(e) => {
                            log::error!("[window] 重建 {:?} 失败: {:?}", window_type, e);
                            WindowOperationResult::Failed
                        }
                    }
                }
            }
            WindowState::Minimized | WindowState::Hidden => {
                if let Some(window) = self.get_real_window(window_type) {
                    self.activate_window(&window, window_type);
                    WindowOperationResult::Shown
                } else {
                    // 缓存为隐藏但窗口已不存在：按不存在处理，重建。
                    match self.create_window_inner(window_type, url) {
                        Ok(_) => WindowOperationResult::Created,
                        Err(e) => {
                            println!("创建窗口失败: {:?}", e);
                            WindowOperationResult::Failed
                        }
                    }
                }
            }
        };

                // 更新缓存状态
        if matches!(
            result,
            WindowOperationResult::Created | WindowOperationResult::Shown
        ) {
            self.update_window_state(window_type, WindowState::VisibleFocused);
        }
        result
    }



    pub fn close_window(&self, window_type: WindowType) -> WindowOperationResult {
        let result = match self.get_real_window(window_type) {
            Some(window) => {
                let operation = window.close();
                match operation {
                    Ok(_) => {
                        println!("窗口已隐藏");
                        WindowOperationResult::Hidden
                    }
                    Err(e) => {
                        println!("隐藏窗口失败: {:?}", e);
                        WindowOperationResult::Failed
                    }
                }
            }
            None => {
                println!("窗口不存在，无需隐藏");
                WindowOperationResult::NoAction
            }
        };

        // 更新缓存状态
        self.update_window_state(window_type, WindowState::Hidden);

        result
    }

    pub fn destroy_window(&self, window_type: WindowType) -> bool {
        match self.get_real_window(window_type) {
            Some(window) => {
                if let Err(e) = window.destroy() {
                    println!("窗口销毁失败: {:?}", e);
                    return false;
                }
                self.update_window_state(window_type, WindowState::NotExist);
                true
            }
            None => {
                self.update_window_state(window_type, WindowState::NotExist);
                true
            }
        }
    }

    /// 切换窗口显示状态
    pub fn toggle_window(&self, window_type: WindowType) -> WindowOperationResult {
        // TODO 添加防抖


        let current_state = self.get_cached_window_state(window_type);
        // 更新托盘菜单状态
        let update_tray = |visible: bool| {
            if matches!(window_type, WindowType::Main) {
                update_menu_visible(visible);
                // tray::Tray::global().update_menu_visible(visible);
            }
        };

        let result = match current_state {
            WindowState::NotExist => {
                println!("窗口不存在，将创建新窗口");
                match self.create_window_inner(window_type, None) {
                    Ok(_) => {
                        update_tray(true);
                        WindowOperationResult::Created
                    }
                    Err(_) => WindowOperationResult::Failed,
                }
            }
            WindowState::VisibleFocused => {
                // 幽灵窗口/窗口已不存在（WebView2 创建失败残留）：清理后直接重建显示。
                if self.get_real_window(window_type).is_some() {
                    println!("窗口可见，将隐藏窗口");
                    update_tray(false);
                    self.close_window(window_type)
                } else {
                    println!("窗口为幽灵窗口，重建");
                    match self.create_window_inner(window_type, None) {
                        Ok(_) => {
                            update_tray(true);
                            WindowOperationResult::Created
                        }
                        Err(_) => WindowOperationResult::Failed,
                    }
                }
            }
            WindowState::Minimized | WindowState::Hidden => {
                if let Some(window) = self.get_real_window(window_type) {
                    println!("窗口存在但被隐藏或最小化，将激活窗口");
                    update_tray(true);
                    self.activate_window(&window, window_type)
                } else {
                    // 幽灵窗口/已销毁：按不存在处理，重建。
                    println!("窗口不存在，将创建新窗口");
                    match self.create_window_inner(window_type, None) {
                        Ok(_) => {
                            update_tray(true);
                            WindowOperationResult::Created
                        }
                        Err(_) => {
                            println!("无法获取窗口实例");
                            WindowOperationResult::Failed
                        }
                    }
                }
            }
        };

        // 更新缓存状态（注意：hide_window已经处理了隐藏状态的更新）
        match result {
            WindowOperationResult::Created => {
                self.update_window_state(window_type, WindowState::VisibleFocused);
            }
            WindowOperationResult::Shown => {
                self.update_window_state(window_type, WindowState::VisibleFocused);
            }
            // Hidden状态已在hide_window中处理
            _ => {}
        }

        result
    }

    pub fn minimized_window(&self, window_type: WindowType) -> bool {
        match self.get_real_window(window_type) {
            Some(window) => {
                if window.is_minimized().unwrap_or(false) {
                    return true;
                } else {
                    if let Err(e) = window.minimize() {
                        println!("窗口最小化失败: {:?}", e);
                        return false;
                    }
                    self.update_window_state(window_type, WindowState::Minimized);
                    return true;
                }
            }
            None => return false,
        }
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