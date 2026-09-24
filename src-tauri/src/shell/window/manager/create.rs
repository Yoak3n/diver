//! 窗口创建（含 WebView2 幽灵窗口探测与桌宠尺寸）。

use tauri::{Emitter, Error, Manager as TauriManager, WebviewWindow, WebviewWindowBuilder, Wry};

use super::Manager;
use crate::shell::lightweight::add_window_listeners;
use crate::shell::window::schema::{WindowState, WindowType};

impl Manager {
    pub(super) fn create_window_inner(
        &self,
        window_type: WindowType,
        url_with_args: Option<&str>,
    ) -> Result<WebviewWindow<Wry>, Error> {
        let app_handle = self
            .app_handle()
            .ok_or(Error::FailedToReceiveMessage)?;
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
        .disable_drag_drop_handler();
        if config.center {
            builder = builder.center();
        }
        if config.float {
            let (x, y) = super::super::position::adjust_float_window_position(&app_handle, config);
            builder = builder.position(x, y);
        }
        // 桌宠：尺寸按持久化缩放配置推导（创建后由 pet::restore 决定最终位置）
        if window_type == WindowType::Pet {
            let (w, h) = super::super::pet::logical_size(&app_handle);
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

            // WebView2：原生可拖区域 + 对齐 DSH 的触摸/滚动特性集。
            // autoplay：TTS 自动朗读无用户手势，AudioContext / <audio> 会被默认策略静音。
            #[allow(unused_mut)]
            let mut args = String::from(
                "--enable-features=msWebView2EnableDraggableRegions \
                 --disable-features=OverscrollHistoryNavigation,msExperimentalScrolling,ElasticOverscroll \
                 --autoplay-policy=no-user-gesture-required",
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
        // 立即探测一次：幽灵窗口则清理注册表并报错，让上层走重建/失败路径。
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
            super::super::pet::restore_or_default_position(&window);
        } else {
            window.set_focus()?;
        }
        add_window_listeners(&app_handle, window_type);
        Ok(window)
    }
}
