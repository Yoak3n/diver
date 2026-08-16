use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;


use anyhow::{Context, Result};
use delay_timer::timer::task::TaskBuilder;
use tauri::{Listener, Manager};

use super::{
    handle,state::AppState,
    timer::Timer,
    window::{
        manager::Manager as WM, 
        schema::WindowType
    }
};
const LIGHT_WEIGHT_TASK_ID: u64 = 0;

/// 标记轻量级定时器任务是否已被注册到 delay_timer 中
/// 避免在未注册时调用 remove_task 触发 delay_timer 内部的 ERROR 日志
static LIGHTWEIGHT_TIMER_ACTIVE: AtomicBool = AtomicBool::new(false);



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
        static INSTANCE: OnceLock<LightWeightState> = OnceLock::new();
        INSTANCE.get_or_init(LightWeightState::new).clone()
    }
}

pub fn setup_window_close_listener() {
    let window_labels = WindowType::all_exclude_float()
        .iter()
        .map(|wt| wt.label().to_string())
        .collect::<Vec<String>>();

    // 使用动态监听机制为所有已存在的窗口添加监听器
    for window_label in &window_labels {
        if let Some(wt) = WindowType::from_label(window_label) {
            add_window_listeners(wt);
        }
    }
}

/// 为单个窗口添加监听器（动态添加）
pub fn add_window_listeners(wt: WindowType) {
    if let Some(app_handle) = handle::Handle::global().app_handle() {
        let listened = {
            app_handle
                .state::<AppState>()
                .lightweight
                .lock()
                .listened_windows
                .contains(wt.label())
        };
        if !listened {
            if let Some(window) = WM::global().get_window(wt) {
                let close_handler = window.listen("tauri://close-requested", move |_event| {
                    // 检查是否所有窗口都已关闭
                    if WM::global().are_all_windows_closed() {
                        let _ = setup_light_weight_timer();
                    }
                });
                {
                    app_handle
                    .state::<AppState>()
                    .lightweight
                    .lock()
                    .close_listeners
                    .push(close_handler);
                }


                let focus_handler = window.listen("tauri://focus", move |_event| {
                    // 取消轻量级模式的定时器
                    let _ = cancel_light_weight_timer();
                });
                {
                    app_handle
                    .state::<AppState>()
                    .lightweight
                    .lock()
                    .focus_listeners
                    .push(focus_handler);
                }

                app_handle
                    .state::<AppState>()
                    .lightweight
                    .lock()
                    .listened_windows
                    .insert(wt.label().to_string());
            }
        }
    }
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

    // 更新托盘显示
    crate::base::tray::update_menu_visible(false);
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