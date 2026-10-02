//! TTS 播放队列 command：挂载播放器 / 入队朗读 / 停止 / 播完回报。

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::config::tts::{load_config, TtsVoiceOverride};
use crate::core::tts::{PlayerKind, TtsPlayer, TtsPlayerEvent};

/// 挂载播放端（pet 优先，main 兜底）。重复 attach 覆盖旧 Channel。
#[tauri::command]
pub fn tts_attach_player(
    player: State<'_, TtsPlayer>,
    kind: String,
    on_event: Channel<TtsPlayerEvent>,
) -> Result<(), String> {
    let kind = PlayerKind::parse(&kind).ok_or_else(|| "kind 必须是 pet|main".to_string())?;
    player.attach(kind, on_event);
    Ok(())
}

#[tauri::command]
pub fn tts_detach_player(player: State<'_, TtsPlayer>, kind: String) -> Result<(), String> {
    let kind = PlayerKind::parse(&kind).ok_or_else(|| "kind 必须是 pet|main".to_string())?;
    player.detach(kind);
    Ok(())
}

/// 入队朗读（后端队列 latest-wins；force 打断当前）。`tts` = 每实例音色覆盖。
/// `message_id` = 来源消息 id，自动朗读跨窗口去重键（force / 手动朗读不去重）。
#[tauri::command]
pub async fn tts_speak(
    app: AppHandle,
    player: State<'_, TtsPlayer>,
    text: String,
    voice: Option<String>,
    force: Option<bool>,
    tts: Option<TtsVoiceOverride>,
    message_id: Option<String>,
) -> Result<(), String> {
    let cfg = load_config(&app);
    player.speak(cfg, text, voice, tts, force.unwrap_or(false), message_id)
}

#[tauri::command]
pub fn tts_stop(player: State<'_, TtsPlayer>) {
    player.stop();
}

/// 前端播完一句后回报，队列再继续。
#[tauri::command]
pub fn tts_report_end(player: State<'_, TtsPlayer>, request_id: String) {
    player.report_end(&request_id);
}
