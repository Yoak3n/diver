//! 实例桌宠窗口池（P2-5 多桌宠）：label `pet-<id>`、URL `/#/pet?instance=<id>`。
//! 同屏上限 [`PETS_CAP`] 只（含经典单例窗 `pet`）；构建参数复用 Pet 窗口配置。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::super::config::WindowConfig;
use super::super::schema::WindowType;
use super::{logical_size, place_at_default};

/// 同屏桌宠上限（拍板：一次最多 3 只）。
pub const PETS_CAP: usize = 3;

/// 实例桌宠窗口 label。
pub fn pet_label(id: &str) -> String {
    format!("pet-{id}")
}

/// 实例桌宠 URL（前端经 query 取绑定实例）。
pub fn pet_url(id: &str) -> String {
    format!("/#/pet?instance={id}")
}

/// 从窗口 URL 解析绑定实例（`?instance=<id>`）。
pub fn instance_from_url(url: &str) -> Option<String> {
    let (_, q) = url.split_once('?')?;
    for pair in q.split('&') {
        if let Some(v) = pair.strip_prefix("instance=") {
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// 在屏桌宠窗口 label（经典 `pet` + 实例 `pet-*`，排序稳定）。
fn pet_labels(app: &AppHandle) -> Vec<String> {
    let mut v: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|l| l.as_str() == "pet" || l.starts_with("pet-"))
        .map(|l| l.to_string())
        .collect();
    v.sort();
    v
}

/// 在屏实例桌宠（`pet-<id>` → id）。
pub fn list(app: &AppHandle) -> Vec<String> {
    pet_labels(app)
        .iter()
        .filter_map(|l| l.strip_prefix("pet-").map(String::from))
        .collect()
}

/// 打开实例桌宠（幂等：已开则前置）；超上限报错并列明已在屏的实例。
pub fn open(app: &AppHandle, id: &str) -> Result<Vec<String>, String> {
    let label = pet_label(id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        return Ok(list(app));
    }
    if pet_labels(app).len() >= PETS_CAP {
        return Err(format!(
            "桌宠同屏上限 {PETS_CAP} 只（已在屏：{}），请先收起一只",
            list(app).join("、")
        ));
    }
    let cfg = WindowConfig::new(WindowType::Pet);
    let (w, h) = logical_size(app);
    let builder = WebviewWindowBuilder::new(
        app,
        label.clone(),
        WebviewUrl::App(pet_url(id).into()),
    )
    .title(WindowType::Pet.title())
    .inner_size(w, h)
    .min_inner_size(w, h)
    .decorations(cfg.decorations)
    .focused(cfg.focused)
    .skip_taskbar(cfg.skip_taskbar)
    .always_on_top(cfg.always_on_top)
    .maximizable(cfg.maximizable)
    .transparent(cfg.transparent)
    .shadow(cfg.shadow)
    .disable_drag_drop_handler();
    // WebView2 独立 data 目录：与经典窗同策略，规避共享环境竞争（tauri#8196）。
    #[cfg(target_os = "windows")]
    let builder = {
        let data_dir = app
            .path()
            .app_local_data_dir()
            .map(|d| d.join(format!("EBWebView-{label}")))
            .unwrap_or_default();
        builder.data_directory(data_dir)
    };
    let window = builder
        .build()
        .map_err(|e| format!("桌宠窗口创建失败：{e}"))?;
    place_at_default(&window);
    // 同屏多宠横向错位（160px/只）：错位太小会同款模型糊成一只。
    let offset = (pet_labels(app).len().saturating_sub(1) as i32) * 160;
    if offset > 0 {
        if let Ok(pos) = window.outer_position() {
            let _ = window.set_position(tauri::PhysicalPosition::new(pos.x + offset, pos.y));
        }
    }
    log::info!(
        "[window] 实例桌宠 {label} 就绪（同屏 {} / {PETS_CAP}）",
        pet_labels(app).len()
    );
    Ok(list(app))
}

/// 收起实例桌宠（幂等）。用 `destroy` 而非 `close`：桌宠窗口拦截 close-request
/// （隐藏语义），close 会被前端吞掉；destroy 直接销毁（本命令为 async，非主线程）。
pub fn close(app: &AppHandle, id: &str) -> Result<Vec<String>, String> {
    if let Some(w) = app.get_webview_window(&pet_label(id)) {
        w.destroy()
            .map_err(|e| format!("桌宠窗口销毁失败：{e}"))?;
    }
    Ok(list(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_and_url_bind_instance() {
        assert_eq!(pet_label("beta"), "pet-beta");
        assert_eq!(pet_url("beta"), "/#/pet?instance=beta");
    }

    #[test]
    fn instance_from_url_parses_query() {
        assert_eq!(
            instance_from_url("http://127.0.0.1:1420/#/pet?instance=beta"),
            Some("beta".to_string())
        );
        assert_eq!(
            instance_from_url("tauri://localhost/#/pet?foo=1&instance=a-b"),
            Some("a-b".to_string())
        );
        assert_eq!(instance_from_url("tauri://localhost/#/pet"), None);
        assert_eq!(instance_from_url("tauri://localhost/#/pet?instance="), None);
    }
}
