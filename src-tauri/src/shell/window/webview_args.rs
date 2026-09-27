// WebView2 `additional_browser_args` 构造（纯函数，无 IO）。
//
// additional_browser_args 会整体覆盖 wry 默认参数，漏掉 disable-features 末三项
// 会重新打开 SmartScreen 等每个导航联网做信誉检查的能力（首启慢的已知来源）。
// autoplay：TTS 自动朗读无用户手势，AudioContext / <audio> 会被默认策略静音。

/// 拼 WebView2 浏览器启动参数。
///
/// `label` 用于 debug 构建的 NetLog 文件名；`debug_port` 仅 debug 构建生效
/// （DevTools 口，release 不开）。多窗同口只首只绑定成功，其余仅失去调试能力。
pub fn webview_browser_args(label: &str, debug_port: Option<u16>) -> String {
    let mut args = String::from(
        "--enable-features=msWebView2EnableDraggableRegions \
         --disable-features=OverscrollHistoryNavigation,msExperimentalScrolling,ElasticOverscroll,msWebOOUI,msPdfOOUI,msSmartScreenProtection \
         --autoplay-policy=no-user-gesture-required",
    );
    #[cfg(debug_assertions)]
    {
        if let Some(port) = debug_port {
            args.push_str(&format!(" --remote-debugging-port={port}"));
        }
        // NetLog 取证：引擎内全部网络事件，进程退出时落盘（路径不带 ..）。
        let netlog_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("target").to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| "target".into());
        args.push_str(&format!(" --log-net-log={netlog_dir}/netlog-{label}.json"));
    }
    #[cfg(not(debug_assertions))]
    let _ = (label, debug_port);
    args
}

#[cfg(test)]
mod tests {
    use super::webview_browser_args;

    #[test]
    fn args_carry_drag_disable_features_and_autoplay() {
        let args = webview_browser_args("pet", None);
        assert!(args.contains("msWebView2EnableDraggableRegions"));
        assert!(args.contains("msSmartScreenProtection"));
        assert!(args.contains("--autoplay-policy=no-user-gesture-required"));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_port_and_netlog_only_in_debug() {
        let with_port = webview_browser_args("pet-beta", Some(9224));
        assert!(with_port.contains("--remote-debugging-port=9224"));
        assert!(with_port.contains("netlog-pet-beta.json"));
        let without = webview_browser_args("pet", None);
        assert!(!without.contains("--remote-debugging-port"));
        assert!(without.contains("netlog-pet.json"));
    }
}
