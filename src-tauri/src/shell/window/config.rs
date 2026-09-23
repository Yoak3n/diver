use diver_geom::{pet_window_logical_size, PET_SIZE_DEFAULT_PERCENT, PET_SIZE_MIN_PERCENT};
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
                // 聊天主窗口默认尺寸（逻辑像素）：800×600 偏挤，放大到 1100×750
                inner_size: (1100.0, 750.0),
                min_inner_size: (480.0, 560.0),
                // 无系统标题栏：由前端自建 TitleBar（可拖动 + 最小化/最大化/关闭）
                decorations: false,
                transparent: false,
                skip_taskbar: false,
                // 无边框仍保留系统投影，Win11 观感更接近原生窗口
                shadow: true,
                always_on_top: false,
                maximizable: true,
                focused: true,
                center: true,
                float: false,
            },
            // Live2D 桌宠：透明、无边框、置顶、不占任务栏、不抢焦点。
            // 尺寸来自 pet_geom（基准 600×560，可随 size_percent 缩放）；
            // 创建时 manager 会再按持久化配置覆盖 actual size。
            WindowType::Pet => Self {
                window_type,
                inner_size: pet_window_logical_size(PET_SIZE_DEFAULT_PERCENT),
                min_inner_size: pet_window_logical_size(PET_SIZE_MIN_PERCENT),
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
