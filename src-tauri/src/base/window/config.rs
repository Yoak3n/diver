use super::schema::WindowType;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct WindowConfig {
    // title should change with window type, so there is no need to set it in config
    pub window_type: WindowType,
    pub inner_size: (f64, f64),
    pub min_inner_size: (f64, f64),
    pub decorations: bool,
    pub transparent: bool,
    pub skip_taskbar: bool,
    pub shadow: bool,
    pub always_on_top: bool,
    pub maximizable: bool,
    pub focused: bool,
    pub center: bool,
    pub float: bool,
}

impl WindowConfig {
    pub fn new(window_type: WindowType) -> Self {
        match window_type {
            WindowType::Main => Self {
                window_type,
                inner_size: (800.0, 600.0),
                min_inner_size: (400.0, 80.0),
                decorations: true,
                transparent: false,
                skip_taskbar: false,
                shadow: false,
                always_on_top: false,
                maximizable: true,
                focused: true,
                center: true,
                float: false,
            },
            // Live2D 桌宠：透明、无边框、置顶、不占任务栏、不抢焦点。
            // 固定尺寸（600×560）：窗口紧凑，桌宠在屏幕上的移动范围大。
            // 模型高度比例 0.8（模型 ~448px，与之前 640×0.7 相同，不随窗口变小）。
            // 布局：模型（画布 ~330px 宽）+ 面板（画布宽×1.2 ≈ 400px）并排。
            WindowType::Pet => Self {
                window_type,
                inner_size: (600.0, 560.0),
                min_inner_size: (600.0, 560.0),
                decorations: false,
                transparent: true,
                skip_taskbar: true,
                shadow: false,
                always_on_top: true,
                maximizable: false,
                focused: false,
                center: false,
                float: false,
            },
        }
    }
    pub fn default_config() -> HashMap<WindowType, WindowConfig> {
        HashMap::from([
            (WindowType::Main, WindowConfig::new(WindowType::Main)),
            (WindowType::Pet, WindowConfig::new(WindowType::Pet)),
        ])
    }
}
