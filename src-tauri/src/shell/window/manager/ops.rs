//! 窗口显示 / 切换 / 关闭 / 激活。

use tauri::{WebviewWindow, Wry};

use super::Manager;
use crate::shell::window::schema::{WindowState, WindowType, WindowOperationResult};

impl Manager {
    pub(super) fn activate_window(
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
                self.set_main_window_menu_visible(visible);
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
}
