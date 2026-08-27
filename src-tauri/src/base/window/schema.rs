#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WindowState {
    /// 窗口可见且有焦点
    VisibleFocused,
    /// 窗口可见但无焦点
    // VisibleUnfocused,
    /// 窗口最小化
    Minimized,
    /// 窗口隐藏
    Hidden,
    /// 窗口不存在
    NotExist,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WindowType {
    /// 主聊天窗口
    Main,
    /// Live2D 桌宠窗口（透明/置顶/无边框，常驻桌面）
    Pet,
}

impl WindowType {
    /// 获取所有窗口类型
    pub fn all() -> [Self; 2] {
        [WindowType::Main, WindowType::Pet]
    }

    pub fn all_exclude_float() -> [Self; 2] {
        [WindowType::Main, WindowType::Pet]
    }

    pub fn from_label(label: &str) -> Option<Self> {
        match label {
            "main" => Some(WindowType::Main),
            "pet" => Some(WindowType::Pet),
            _ => None,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            WindowType::Main => "main",
            WindowType::Pet => "pet",
        }
    }

    /// 窗口加载的 UI 地址：Tauri 内置静态托管（dev 为 Vite dev server，
    /// release 为打包的 frontendDist）。vue-router hash 模式：主界面 /、
    /// 桌宠 /#/pet。UI 不再依赖 sidecar 的 HTTP 端口（sidecar 只提供 /api）。
    pub fn url(&self) -> String {
        match self {
            WindowType::Main => "/".to_string(),
            WindowType::Pet => "/#/pet".to_string(),
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            WindowType::Main => "Diver",
            WindowType::Pet => "Diver 桌宠",
        }
    }
}


impl From<WindowType> for String {
    fn from(window_type: WindowType) -> Self {
        window_type.label().to_string()
    } 
}


#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WindowOperationResult {
    /// 窗口已显示并获得焦点
    Shown,
    /// 窗口已隐藏
    Hidden,
    /// 创建了新窗口
    Created,
    /// 操作失败
    Failed,
    /// 无需操作
    NoAction,
}
