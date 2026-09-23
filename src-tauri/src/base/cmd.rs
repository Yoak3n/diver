// Tauri command handlers — Diver 应用命令。

use tauri::AppHandle;

use crate::base::sidecar::{SidecarManager, SidecarStatus};
use crate::base::tts;
use crate::base::window::pet as pet_win;
use crate::config::pet_window::PetWindowConfig;
use crate::plugins::PluginInfo;

/// 查询 sidecar 状态。
#[tauri::command]
pub fn get_sidecar_status() -> SidecarStatus {
    SidecarManager::global().status()
}

/// 列出 companion 插件。
#[tauri::command]
pub fn list_plugins(app: AppHandle) -> Vec<PluginInfo> {
    crate::plugins::list_plugins(&app)
}

/// 启停插件（写 profile 补丁，不重启）。
#[tauri::command]
pub fn set_plugin_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Vec<PluginInfo>, String> {
    crate::plugins::set_plugin_enabled(&app, &id, enabled)
}

/// 启停插件并重启 sidecar。
#[tauri::command]
pub fn toggle_plugin(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Vec<PluginInfo>, String> {
    crate::plugins::toggle_plugin(&app, &id, enabled)
}

/// 插件布局诊断路径。
#[tauri::command]
pub fn get_plugin_paths(app: AppHandle) -> serde_json::Value {
    crate::plugins::plugin_paths_json(&app)
}

/// 当前激活 profile（companion / safe）。
#[tauri::command]
pub fn get_active_profile(app: AppHandle) -> String {
    crate::plugins::active_profile(&app)
}

/// 启动预检（布局 + profile 补丁）。
#[tauri::command]
pub fn preflight_plugins(app: AppHandle) -> crate::plugins::PreflightReport {
    crate::plugins::ensure_profile(&app);
    crate::plugins::preflight(&app)
}

/// 切换 profile（companion / safe）并重启 sidecar。
#[tauri::command]
pub fn switch_profile(
    app: AppHandle,
    profile: String,
) -> Result<crate::plugins::PreflightReport, String> {
    crate::plugins::switch_profile_and_restart(&app, &profile)
}

/// 安装 profile 插件（pnpm add + 登记），可选重启。
#[tauri::command]
pub fn install_profile_plugin(
    app: AppHandle,
    spec: String,
    restart: Option<bool>,
) -> Result<Vec<PluginInfo>, String> {
    crate::plugins::install::install_profile_plugin(&app, &spec, restart.unwrap_or(true))
}

/// 卸载 profile 插件（internal 拒绝）。
#[tauri::command]
pub fn uninstall_profile_plugin(
    app: AppHandle,
    id: String,
    restart: Option<bool>,
) -> Result<Vec<PluginInfo>, String> {
    crate::plugins::install::uninstall_profile_plugin(&app, &id, restart.unwrap_or(true))
}

/// 重启 sidecar（停止后重新拉起）。
#[tauri::command]
pub fn restart_sidecar(app: AppHandle) -> bool {
    SidecarManager::global().restart(&app)
}

/// 列出全局快捷键绑定（含启用状态）。
#[tauri::command]
pub fn list_shortcuts(app: AppHandle) -> Vec<crate::config::shortcuts::ShortcutBinding> {
    crate::config::shortcuts::load_config(&app).bindings
}

/// 热插拔：新增/更新单个快捷键绑定（写配置 + 运行时注册/注销）。
#[tauri::command]
pub fn set_shortcut(
    app: AppHandle,
    binding: crate::config::shortcuts::ShortcutBinding,
) -> Result<Vec<crate::config::shortcuts::ShortcutBinding>, String> {
    crate::base::shortcut::ShortcutManager::global().set_binding(&app, binding)
}

/// 热插拔：移除快捷键绑定（写配置 + 运行时注销）。
#[tauri::command]
pub fn remove_shortcut(
    app: AppHandle,
    id: String,
) -> Result<Vec<crate::config::shortcuts::ShortcutBinding>, String> {
    crate::base::shortcut::ShortcutManager::global().remove_binding(&app, id)
}

/// 录制组合键前调用：挂起全部全局热键，避免 OS 吞掉 keydown。
#[tauri::command]
pub fn suspend_shortcuts(app: AppHandle) -> Result<(), String> {
    crate::base::shortcut::ShortcutManager::global().suspend(&app)
}

/// 录制组合键结束后调用：按配置恢复全局热键。
#[tauri::command]
pub fn resume_shortcuts(app: AppHandle) -> Result<(), String> {
    crate::base::shortcut::ShortcutManager::global().resume(&app)
}

/// 获取 sidecar 的 API 根地址（供前端展示/调试）。
#[tauri::command]
pub fn get_sidecar_url() -> String {
    SidecarManager::global().api_base_url()
}

/// 读取在线 TTS 配置（secret 只回 has_* 布尔）。
#[tauri::command]
pub fn get_tts_config(app: AppHandle) -> crate::config::tts::TtsConfigView {
    crate::config::tts::load_config(&app).to_view()
}

/// 保存在线 TTS 配置（secret 空串 = 留空不改）。
#[tauri::command]
pub fn set_tts_config(
    app: AppHandle,
    config: crate::config::tts::TtsConfigPatch,
) -> Result<crate::config::tts::TtsConfigView, String> {
    let mut cfg = crate::config::tts::load_config(&app);
    cfg.merge_from(&config);
    if !crate::config::tts::save_config(&app, &cfg) {
        return Err("写入 TTS 配置失败".into());
    }
    Ok(cfg.to_view())
}

/// 列出当前服务商的声线（内置预设 + 自定义）。
#[tauri::command]
pub fn tts_list_voices(
    app: AppHandle,
    provider: Option<String>,
) -> Vec<crate::config::tts::TtsVoice> {
    let mut cfg = crate::config::tts::load_config(&app);
    if let Some(p) = provider {
        cfg.provider = crate::config::tts::TtsProvider::parse(&p);
    }
    tts::list_voices(&cfg)
}

/// 列出当前服务商可选模型（advisory）。
#[tauri::command]
pub fn tts_list_models(provider: String) -> Vec<String> {
    tts::list_models(crate::config::tts::TtsProvider::parse(&provider))
}

/// 桌宠窗口是否在线（朗读路由分流：在线时只允许桌宠播放，防双窗口叠音）。
#[tauri::command]
pub fn is_pet_window_open(app: AppHandle) -> bool {
    use tauri::Manager as _;
    app.get_webview_window(crate::base::window::pet::PET_WINDOW_LABEL)
        .map(|w| w.is_visible().unwrap_or(true))
        .unwrap_or(false)
}

/// 在线合成语音（返回 base64 音频）。`voice` 可覆盖配置中的声线。
#[tauri::command]
pub async fn tts_synthesize(
    app: AppHandle,
    text: String,
    voice: Option<String>,
) -> Result<crate::config::tts::TtsAudio, String> {
    tts::synthesize_from_config(&app, &text, voice.as_deref()).await
}

/// 弹出原生通知（托盘通知；前端可直接调用，Node 侧经 /rpc notify::show）。
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    crate::base::notify::show(&app, &title, &body);
}

/// 存在感相位（叶子名）。调用点会按 now 补发时间事件。
#[tauri::command]
pub fn presence_phase() -> String {
    crate::base::presence::PresenceHandle::global().phase().as_str().to_string()
}

/// 存在感调试快照（相位 + ProactiveSpeak 私有记账）。
#[tauri::command]
pub fn presence_snapshot() -> serde_json::Value {
    serde_json::to_value(crate::base::presence::PresenceHandle::global().snapshot())
        .unwrap_or(serde_json::Value::Null)
}

/// 驱动 L0 事件（手势 / 设置 / 回压统一入口）。
#[tauri::command]
pub fn presence_event(event: String, regime: Option<String>, enabled: Option<bool>) -> String {
    use diver_presence::{Event, Regime};
    let ev = match event.as_str() {
        "USER_CHAT" => Event::UserChat,
        "CHAT_ACTIVITY" => Event::ChatActivity,
        "USER_INPUT_START" => Event::UserInputStart,
        "USER_INPUT_END" => Event::UserInputEnd,
        "PET_GESTURE" => Event::PetGesture,
        "DELIVERING_START" => Event::DeliveringStart,
        "DELIVERING_END" => Event::DeliveringEnd,
        "DREAM_START" => Event::DreamStart,
        "DREAM_END" => Event::DreamEnd,
        "EXPLORE_START" => Event::ExploreStart,
        "EXPLORE_END" => Event::ExploreEnd,
        "BOOT" => Event::Boot,
        "SHUTDOWN" => Event::Shutdown,
        "BUSY_TRUE" => Event::Busy(true),
        "BUSY_FALSE" => Event::Busy(false),
        "REGIME" => {
            let r = match regime.as_deref() {
                Some("dnd") => Regime::Dnd,
                Some("quiet_hours") => Regime::QuietHours,
                Some("focus") => Regime::Focus,
                Some("sleep") => Regime::Sleep,
                _ => Regime::Normal,
            };
            Event::Regime(r)
        }
        "ENABLED" => Event::Enabled(enabled.unwrap_or(true)),
        other => return format!("unknown:{other}"),
    };
    crate::base::presence::PresenceHandle::global().handle_event(ev);
    crate::base::presence::PresenceHandle::global()
        .phase()
        .as_str()
        .to_string()
}

/// 裁决并下发主动注入（sidecar `POST /api/inject`，无门控执行）。
#[tauri::command]
pub async fn presence_request_inject(
    source: String,
    text: String,
) -> Result<serde_json::Value, String> {
    let base = SidecarManager::global().api_base_url();
    crate::base::presence::request_and_inject(&base, &source, &text).await
}

/// Explore 调试快照（L2 私有记账）。
#[tauri::command]
pub fn presence_explore_snapshot() -> serde_json::Value {
    crate::base::explore_policy::snapshot_json()
}

/// 手动触发一次探索（仍走 L1+L2 裁决）。
#[tauri::command]
pub async fn presence_explore_trigger(
    term: String,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::base::explore_policy::trigger_manual(&term, reason.as_deref().unwrap_or("manual")).await
}

/// 取消当前探索 job。
#[tauri::command]
pub fn presence_explore_cancel() -> serde_json::Value {
    crate::base::explore_policy::cancel_active_job();
    serde_json::json!({ "ok": true })
}

/// 读取桌宠互动感知设置（壳为真源；与 diver-settings.petInteraction 同步）。
#[tauri::command]
pub fn get_pet_interaction_config() -> crate::base::pet_interaction::PetInteractionConfig {
    crate::base::pet_interaction::load_config()
}

/// 保存桌宠互动设置并同步 ProactiveSpeak 节流参数。
#[tauri::command]
pub fn set_pet_interaction_config(
    config: crate::base::pet_interaction::PetInteractionConfig,
) -> Result<crate::base::pet_interaction::PetInteractionConfig, String> {
    crate::base::pet_interaction::save_config(&config).map_err(|e| e.to_string())?;
    crate::base::pet_interaction::apply_config(&config);
    Ok(config)
}

/// 桌宠手势语义事件：壳组文案 + Presence 裁决 + inject（唯一主动开口入口）。
#[tauri::command]
pub async fn pet_gesture_event(
    event: crate::base::pet_interaction::PetGestureEvent,
) -> Result<serde_json::Value, String> {
    Ok(crate::base::pet_interaction::handle_pet_gesture(event).await)
}

/// 读取启动窗口配置。
#[tauri::command]
pub fn get_window_startup_config(app: AppHandle) -> crate::config::window_startup::WindowStartupConfig {
    crate::config::window_startup::load_config(&app)
}

/// 保存启动窗口配置。
#[tauri::command]
pub fn set_window_startup_config(
    app: AppHandle,
    config: crate::config::window_startup::WindowStartupConfig,
) -> bool {
    crate::config::window_startup::save_config(&app, &config)
}

/// 读取 MCP 服务配置（设置面板「MCP 服务」页直接编辑的配置文件）。
#[tauri::command]
pub fn get_mcp_config(app: AppHandle) -> crate::config::mcp::McpConfig {
    crate::config::mcp::load_config(&app)
}

/// 保存 MCP 服务配置，返回是否成功。
#[tauri::command]
pub fn save_mcp_config(app: AppHandle, config: crate::config::mcp::McpConfig) -> bool {
    crate::config::mcp::save_config(&app, &config)
}

/// 读取桌宠窗口配置（位置 + 缩放百分比）。
#[tauri::command]
pub fn get_pet_window_config(app: AppHandle) -> PetWindowConfig {
    pet_win::get_config(&app)
}

/// 设置桌宠缩放百分比并立即应用到窗口。
#[tauri::command]
pub fn set_pet_size_percent(app: AppHandle, percent: f64) -> Result<PetWindowConfig, String> {
    pet_win::set_size_percent(&app, percent)
}

/// 显示桌宠窗口（async：create 必须离开主线程）。
#[tauri::command]
pub async fn show_pet_window(app: AppHandle) -> Result<(), String> {
    pet_win::set_visible(&app, true)
}

/// 收起桌宠窗口 = 销毁实例（async：destroy 禁止在主线程）。
#[tauri::command]
pub async fn hide_pet_window(app: AppHandle) -> Result<(), String> {
    pet_win::set_visible(&app, false)
}

/// 切换桌宠显隐，返回切换后是否可见。
#[tauri::command]
pub async fn toggle_pet_window(app: AppHandle) -> Result<bool, String> {
    pet_win::toggle(&app)
}

/// 桌宠软限位：夹到最近可见显示器工作区（拖动结束后调用，不在 Moved 里跑）。
#[tauri::command]
pub fn clamp_pet_window(app: AppHandle) {
    pet_win::ensure_visible(&app)
}

/// 按物理像素增量移动桌宠，并夹进最近显示器（对齐 DSH `move_pet_window`）。
/// `delta_x/y = 0` 时等价于软恢复；需要挪动时带 ease-out 过渡。
#[tauri::command]
pub fn move_pet_window(app: AppHandle, delta_x: i32, delta_y: i32) -> Result<(), String> {
    pet_win::move_by_delta(&app, delta_x, delta_y)
}

/// 取消进行中的桌宠位置过渡动画。
#[tauri::command]
pub fn cancel_pet_move_animation() {
    pet_win::cancel_position_animation()
}

/// 标记桌宠「系统拖动会话」开/关。
/// beginDrag 时 true（禁止归位动画）；Moved 停歇归位前 false（允许 ease-out 过渡）。
#[tauri::command]
pub fn set_pet_dragging(active: bool) {
    pet_win::set_dragging(active)
}

/// 查询全局鼠标在屏幕上的物理坐标（穿透判定兜底；主路径走 device-mouse-move 事件）。
#[tauri::command]
pub fn get_cursor_screen_point() -> Option<(i32, i32)> {
    use mouse_position::mouse_position::Mouse;
    match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Some((x, y)),
        Mouse::Error => None,
    }
}

/// 列出所有显示器（物理像素，相对虚拟屏幕原点）。
#[tauri::command]
pub fn list_monitors(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let p = *m.position();
            let s = *m.size();
            serde_json::json!({
                "name": m.name().cloned().unwrap_or_default(),
                "x": p.x,
                "y": p.y,
                "width": s.width,
                "height": s.height,
            })
        })
        .collect()
}

/// 把桌宠窗口转移到指定显示器（贴其工作区右下角，并持久化位置）。
#[tauri::command]
pub fn move_pet_to_monitor(app: tauri::AppHandle, index: usize) -> bool {
    pet_win::move_to_monitor(&app, index).is_ok()
}

/// 启动/重绑桌宠全局鼠标流（点击穿透恢复）。
#[tauri::command]
pub fn start_pet_mouse_stream(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::base::state::AppState>,
) {
    state.pet_mouse.start(window);
}
