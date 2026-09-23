use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result};
use delay_timer::timer::task::TaskBuilder;
use tauri::{AppHandle, Listener};

use crate::core::timer::Timer;
use crate::shell::window::{
    manager::Manager as WM,
    schema::WindowType
};
const LIGHT_WEIGHT_TASK_ID: u64 = 0;

/// 标记轻量级定时器任务是否已被注册到 delay_timer 中
/// 避免在未注册时调用 remove_task 触发 delay_timer 内部的 ERROR 日志
static LIGHTWEIGHT_TIMER_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 轻量模式窗口监听记账（壳内共享；app/state 聚合同一份）。
#[derive(Clone)]
pub struct LightWeightState {
    pub close_listeners: Vec<u32>,
    pub focus_listeners: Vec<u32>,
    pub listened_windows: HashSet<String>,
}

impl LightWeightState {
    pub fn new() -> Self {
        Self {
            close_listeners: Vec::new(),
            focus_listeners: Vec::new(),
            listened_windows: HashSet::new(),
        }
    }
}

impl Default for LightWeightState {
    fn default() -> Self {
        Self::new()
    }
}

/// 进程内共享的轻量模式状态（shell 自持，不依赖 app::state）。
pub fn shared_state() -> Arc<parking_lot::Mutex<LightWeightState>> {
    static STATE: OnceLock<Arc<parking_lot::Mutex<LightWeightState>>> = OnceLock::new();
    STATE
        .get_or_init(|| Arc::new(parking_lot::Mutex::new(LightWeightState::new())))
        .clone()
}

/// 当前未启用：轻量模式触发逻辑待真机验证后再接入。
/// 若后续要启用，需先确认 `are_all_windows_closed()` 与主窗口 prevent-close 的行为。
pub fn setup_window_close_listener(app: &AppHandle) {
    let window_labels = WindowType::all_exclude_float()
        .iter()
        .map(|wt| wt.label().to_string())
        .collect::<Vec<String>>();

    // 使用动态监听机制为所有已存在的窗口添加监听器
    for window_label in &window_labels {
        if let Some(wt) = WindowType::from_label(window_label) {
            add_window_listeners(app, wt);
        }
    }
}

/// 为单个窗口添加监听器（动态添加）。
///
/// `app` 由调用方注入（shell 不依赖 app::handle）；托盘菜单更新走
/// [WM::set_main_visible_listener] 注册的回调。
pub fn add_window_listeners(app: &AppHandle, wt: WindowType) {
    let lightweight = shared_state();
    let listened = {
        lightweight
            .lock()
            .listened_windows
            .contains(wt.label())
    };
    if listened {
        return;
    }
    if let Some(window) = WM::global().get_window(wt) {
        let close_handler = window.listen("tauri://close-requested", move |_event| {
            // 检查是否所有窗口都已关闭
            if WM::global().are_all_windows_closed() {
                let _ = setup_light_weight_timer();
            }
        });
        {
            lightweight
                .lock()
                .close_listeners
                .push(close_handler);
        }

        let focus_handler = window.listen("tauri://focus", move |_event| {
            // 取消轻量级模式的定时器
            let _ = cancel_light_weight_timer();
        });
        {
            lightweight
                .lock()
                .focus_listeners
                .push(focus_handler);
        }

        lightweight
            .lock()
            .listened_windows
            .insert(wt.label().to_string());
    }
    let _ = app; // app 保留给未来 per-window 状态扩展
}

fn setup_light_weight_timer() -> Result<()> {
    // 如果已经有定时器在运行，先清理
    let _ = cancel_light_weight_timer();

    Timer::global().init()?;

    // 创建任务
    let task = TaskBuilder::default()
        .set_task_id(LIGHT_WEIGHT_TASK_ID)
        .set_maximum_parallel_runnable_num(1)
        .set_frequency_once_by_minutes(10)
        .spawn_async_routine(move || async move {
            entry_lightweight_mode();
        })
        .context("failed to create timer task")?;

    // 添加任务到定时器
    // 由于会定时刷新，所以这里需要添加一个不被刷新的容器
    {
        let delay_timer = Timer::global().delay_timer.write();
        delay_timer
            .add_task(task)
            .context("failed to add timer task")?;
    }

    LIGHTWEIGHT_TIMER_ACTIVE.store(true, Ordering::Release);

    Ok(())
}

pub fn entry_lightweight_mode() {
    let _ = WM::global().close_window(WindowType::Main);
    // 销毁所有窗口

    // 获取所有窗口类型并销毁它们
    for window_type in &WindowType::all() {
        WM::global().destroy_window(*window_type);
    }

    let _ = cancel_light_weight_timer();

    // 更新托盘显示（回调由 app 层注入到 Manager）
    WM::global().set_main_window_menu_visible(false);
}

fn cancel_light_weight_timer() -> Result<()> {
    // 只在任务已注册时执行移除，避免 delay_timer 内部报 "No task-mark found" 错误
    if !LIGHTWEIGHT_TIMER_ACTIVE.load(Ordering::Acquire) {
        return Ok(());
    }

    let delay_timer = Timer::global().delay_timer.write();
    let _ = delay_timer.remove_task(LIGHT_WEIGHT_TASK_ID);

    LIGHTWEIGHT_TIMER_ACTIVE.store(false, Ordering::Release);
    Ok(())
}
