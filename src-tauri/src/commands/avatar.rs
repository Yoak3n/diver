//! 助手头像 IPC（薄适配：base64 ↔ config::avatar，存储在 $COS_HOME）。

use base64::Engine as _;
use tauri::AppHandle;

use crate::config::avatar::{self, MAX_BYTES};

/// 头像视图。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarView {
    /// `data:image/png;base64,...`；无自定义头像时为 `None`。
    pub data_url: Option<String>,
    /// 当前/默认落盘路径（便于设置页展示、供 agent 写入）。
    pub path: String,
}

fn view_at(base: &std::path::Path) -> AvatarView {
    AvatarView {
        data_url: avatar::load_avatar_data_url_at(base),
        path: avatar::avatar_path_hint(base),
    }
}

fn base_of(app: &AppHandle) -> std::path::PathBuf {
    crate::config::cos_home(app)
}

/// 读取当前助手头像（每次从磁盘读，agent 改文件后可被拉到）。
#[tauri::command]
pub fn get_assistant_avatar(app: AppHandle) -> AvatarView {
    view_at(&base_of(&app))
}

/// 设置助手头像。`data` 为不带 `data:` 前缀的 base64。
#[tauri::command]
pub fn set_assistant_avatar(
    app: AppHandle,
    mime: String,
    data: String,
) -> Result<AvatarView, String> {
    if !avatar::is_allowed_mime(&mime) {
        return Err(format!("不支持的图片类型: {mime}"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("图片 base64 解码失败: {e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("头像过大（上限 {} KB）", MAX_BYTES / 1024));
    }
    let base = base_of(&app);
    if avatar::save_avatar_at(&base, &mime, &bytes).is_none() {
        return Err("保存头像失败".into());
    }
    Ok(view_at(&base))
}

/// 恢复默认头像（✦）。
#[tauri::command]
pub fn clear_assistant_avatar(app: AppHandle) -> AvatarView {
    let base = base_of(&app);
    let _ = avatar::clear_avatar_at(&base);
    view_at(&base)
}
