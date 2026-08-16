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

    /// 窗口加载的 UI 地址：dev 为 Vite 开发服务器，release 为 sidecar 自带的 UI。
    pub fn url(&self) -> String {
        let base = crate::base::sidecar::SidecarManager::global().ui_url();
        match self {
            WindowType::Main => base,
            WindowType::Pet => {
                // dev：Vite 按源码相对路径提供页面；release：构建产物 dist/pet.html
                #[cfg(debug_assertions)]
                {
                    format!("{}/src/pet/pet.html", base)
                }
                #[cfg(not(debug_assertions))]
                {
                    format!("{}/pet.html", base)
                }
            }
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
