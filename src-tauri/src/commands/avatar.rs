//! 图片资产 IPC（薄适配：base64 ↔ config::avatar）。
//! 助手头像按实例存 `$COS_HOME`；应用图标存应用配置目录（品牌位，与实例无关）。

use base64::Engine as _;
use tauri::AppHandle;

use crate::config::avatar::{self, APP_ICON_PREFIX, FILE_PREFIX, MAX_BYTES};
use crate::config::config_dir;

/// 图片资产视图。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarView {
    /// `data:image/png;base64,...`；无自定义时为 `None`。
    pub data_url: Option<String>,
    /// 当前/默认落盘路径（便于设置页展示、供 agent 写入）。
    pub path: String,
}

fn view_at(base: &std::path::Path, prefix: &str) -> AvatarView {
    AvatarView {
        data_url: avatar::load_prefixed_data_url_at(base, prefix),
        path: avatar::prefixed_path_hint(base, prefix),
    }
}

fn base_of(app: &AppHandle) -> std::path::PathBuf {
    crate::config::cos_home(app)
}

/// 按实例解析头像基目录：带 instance → 该实例 cos_home；缺省 → active。
fn base_of_instance(app: &AppHandle, instance: Option<&str>) -> std::path::PathBuf {
    match instance.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => crate::config::cos_home_for(app, id),
        None => base_of(app),
    }
}

fn decode_or_err(data: &str, mime: &str) -> Result<Vec<u8>, String> {
    if !avatar::is_allowed_mime(mime) {
        return Err(format!("不支持的图片类型: {mime}"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("图片 base64 解码失败: {e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("图片过大（上限 {} KB）", MAX_BYTES / 1024));
    }
    Ok(bytes)
}

/// 读取助手头像（每次从磁盘读，agent 改文件后可被拉到）。
/// `instance` 缺省 = active 实例；群聊按发送实例取头像时显式传入。
#[tauri::command]
pub fn get_assistant_avatar(app: AppHandle, instance: Option<String>) -> AvatarView {
    view_at(&base_of_instance(&app, instance.as_deref()), FILE_PREFIX)
}

/// 设置助手头像。`data` 为不带 `data:` 前缀的 base64。`instance` 缺省 = active 实例。
#[tauri::command]
pub fn set_assistant_avatar(
    app: AppHandle,
    mime: String,
    data: String,
    instance: Option<String>,
) -> Result<AvatarView, String> {
    let bytes = decode_or_err(&data, &mime)?;
    let base = base_of_instance(&app, instance.as_deref());
    if avatar::save_prefixed_at(&base, FILE_PREFIX, &mime, &bytes).is_none() {
        return Err("保存头像失败".into());
    }
    Ok(view_at(&base, FILE_PREFIX))
}

/// 恢复默认头像（✦）。`instance` 缺省 = active 实例。
#[tauri::command]
pub fn clear_assistant_avatar(app: AppHandle, instance: Option<String>) -> AvatarView {
    let base = base_of_instance(&app, instance.as_deref());
    let _ = avatar::clear_prefixed_at(&base, FILE_PREFIX);
    view_at(&base, FILE_PREFIX)
}

/// 应用图标基目录（应用配置目录，与实例无关）。
fn app_icon_base(app: &AppHandle) -> std::path::PathBuf {
    config_dir(app)
}

/// 读取应用图标（窗口标题栏等品牌位；与实例头像无关）。
#[tauri::command]
pub fn get_app_icon(app: AppHandle) -> AvatarView {
    view_at(&app_icon_base(&app), APP_ICON_PREFIX)
}

/// 设置应用图标。`data` 为不带 `data:` 前缀的 base64。
#[tauri::command]
pub fn set_app_icon(app: AppHandle, mime: String, data: String) -> Result<AvatarView, String> {
    let bytes = decode_or_err(&data, &mime)?;
    let base = app_icon_base(&app);
    if avatar::save_prefixed_at(&base, APP_ICON_PREFIX, &mime, &bytes).is_none() {
        return Err("保存应用图标失败".into());
    }
    Ok(view_at(&base, APP_ICON_PREFIX))
}

/// 恢复默认应用图标（✦）。
#[tauri::command]
pub fn clear_app_icon(app: AppHandle) -> AvatarView {
    let base = app_icon_base(&app);
    let _ = avatar::clear_prefixed_at(&base, APP_ICON_PREFIX);
    view_at(&base, APP_ICON_PREFIX)
}

// ---------- 群头像（按群 id 一份；侧栏群行 / 群管理面板使用） ----------

/// 群头像基目录（应用配置目录下 groups/，与实例无关）。
fn group_avatar_base(app: &AppHandle) -> std::path::PathBuf {
    config_dir(app).join("groups")
}

/// gid 净化：只放行小写字母数字与连字符（shell 生成的 `group-N` / `general`）。
fn sanitize_gid(gid: &str) -> Result<String, String> {
    let id = gid.trim();
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!("非法群 id: {gid}"));
    }
    Ok(id.to_string())
}

/// 读取群头像。未设置时 dataUrl 为 None（前端回退首字渐变块）。
#[tauri::command]
pub fn get_group_avatar(app: AppHandle, group_id: String) -> Result<AvatarView, String> {
    let gid = sanitize_gid(&group_id)?;
    Ok(view_at(&group_avatar_base(&app), &gid))
}

/// 设置群头像。`data` 为不带 `data:` 前缀的 base64（前端已预缩至 256×256）。
#[tauri::command]
pub fn set_group_avatar(
    app: AppHandle,
    group_id: String,
    mime: String,
    data: String,
) -> Result<AvatarView, String> {
    let gid = sanitize_gid(&group_id)?;
    let bytes = decode_or_err(&data, &mime)?;
    let base = group_avatar_base(&app);
    if avatar::save_prefixed_at(&base, &gid, &mime, &bytes).is_none() {
        return Err("保存群头像失败".into());
    }
    Ok(view_at(&base, &gid))
}

/// 恢复默认群头像（首字渐变块）。
#[tauri::command]
pub fn clear_group_avatar(app: AppHandle, group_id: String) -> Result<AvatarView, String> {
    let gid = sanitize_gid(&group_id)?;
    let base = group_avatar_base(&app);
    let _ = avatar::clear_prefixed_at(&base, &gid);
    Ok(view_at(&base, &gid))
}
