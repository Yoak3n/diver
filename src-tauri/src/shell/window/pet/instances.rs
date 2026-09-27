//! 实例桌宠窗口池（P2-5 多桌宠）：label `pet-<id>`、URL `/#/pet?instance=<id>`。
//! 同屏上限 [`PETS_CAP`] 只（含经典单例窗 `pet`）；构建参数复用 Pet 窗口配置。
//!
//! **归属**：经典窗 `pet` 没有实例参数（跟随 active），它就是 **active 实例的桌宠**
//! ——启动按配置自动创建。所以查询/召唤/收起都按这个归属算：active 实例的桌宠
//! 就是经典窗，不能另建一只 `pet-<id>`（否则同一实例两只宠物，按钮状态也对不上）。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::super::config::WindowConfig;
use super::super::schema::WindowType;
use super::{logical_size, place_pool_window, PET_WINDOW_LABEL};

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
        .filter(|l| l.as_str() == PET_WINDOW_LABEL || l.starts_with("pet-"))
        .map(|l| l.to_string())
        .collect();
    v.sort();
    v
}

/// 桌宠窗 + 可见性（`hide()` 只撤下窗口、对象仍在，不算在屏）。
fn pet_windows(app: &AppHandle) -> Vec<(String, bool)> {
    app.webview_windows()
        .iter()
        .filter(|(l, _)| l.as_str() == PET_WINDOW_LABEL || l.starts_with("pet-"))
        .map(|(l, w)| (l.to_string(), w.is_visible().unwrap_or(true)))
        .collect()
}

/// 在屏桌宠归属的实例（纯函数，可单测）：
/// 可见的经典窗 → `active`（它跟随 active 实例）；可见的 `pet-<id>` → `id`。
/// 同一实例只报一次（经典窗与 `pet-<id>` 并存时是历史遗留的重复召唤）。
fn owner_ids(windows: &[(String, bool)], active: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (label, visible) in windows {
        if !visible {
            continue;
        }
        let owner = if label == PET_WINDOW_LABEL {
            active
        } else if let Some(id) = label.strip_prefix("pet-") {
            id
        } else {
            continue;
        };
        if !owner.is_empty() && !out.iter().any(|o| o == owner) {
            out.push(owner.to_string());
        }
    }
    out.sort();
    out
}

/// active 实例 id（经典窗归属；`config` 侧的清单真源）。
fn active_instance(app: &AppHandle) -> String {
    crate::config::instances::active_instance_id(app)
}

/// 在屏桌宠归属的实例（可见者；经典窗算 active 实例的）。
pub fn list(app: &AppHandle) -> Vec<String> {
    owner_ids(&pet_windows(app), &active_instance(app))
}

/// 打开实例桌宠（幂等：已开则前置）；超上限报错并列明已在屏的实例。
///
/// active 实例的桌宠就是经典窗（启动自动创建，TTS 分流 `is_pet_window_open` 也只认它）：
/// 要「召唤」时前置/重建经典窗，不再另建 `pet-<id>`。
pub fn open(app: &AppHandle, id: &str) -> Result<Vec<String>, String> {
    let label = pet_label(id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        return Ok(list(app));
    }
    if id == active_instance(app) {
        super::set_visible(app, true)?;
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
    // 浏览器参数与经典窗同源（wry 默认禁用集漏掉会开 SmartScreen 导航检查）。
    // DevTools 口 9224：同屏多只只首只绑定成功（纯调试便利）。
    #[cfg(target_os = "windows")]
    let builder =
        builder.additional_browser_args(&crate::shell::window::webview_browser_args(
            &label,
            Some(9224),
        ));
    let window = builder
        .build()
        .map_err(|e| format!("桌宠窗口创建失败：{e}"))?;
    // 同屏多宠：落在已有桌宠那块屏的工作区内，按池内序号向内错位（不写盘）。
    place_pool_window(&window, pet_labels(app).len().saturating_sub(1));
    log::info!(
        "[window] 实例桌宠 {label} 就绪（同屏 {} / {PETS_CAP}）",
        pet_labels(app).len()
    );
    Ok(list(app))
}

/// 收起桌宠（幂等）：销毁该实例名下的全部桌宠窗。用 `destroy` 而非 `close`：
/// 桌宠窗口拦截 close-request（隐藏语义），close 会被前端吞掉。
/// active 实例还要收掉经典窗——它也是这个实例的桌宠，留着「收起」就名不副实。
pub fn close(app: &AppHandle, id: &str) -> Result<Vec<String>, String> {
    if let Some(w) = app.get_webview_window(&pet_label(id)) {
        w.destroy()
            .map_err(|e| format!("桌宠窗口销毁失败：{e}"))?;
    }
    if id == active_instance(app) {
        super::set_visible(app, false)?;
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

    fn win(label: &str, visible: bool) -> (String, bool) {
        (label.to_string(), visible)
    }

    /// 经典窗算 active 实例的桌宠（启动就有窗 → 该行按钮应显示「收起」）。
    #[test]
    fn owner_ids_maps_classic_to_active() {
        assert_eq!(
            owner_ids(&[win("pet", true)], "default"),
            vec!["default".to_string()]
        );
        assert_eq!(
            owner_ids(&[win("pet", true)], "beta"),
            vec!["beta".to_string()]
        );
    }

    /// 只看可见的：hide 掉的窗对象还在，但屏上没有它。
    #[test]
    fn owner_ids_skips_hidden_and_foreign_windows() {
        assert!(owner_ids(&[win("pet", false)], "default").is_empty());
        assert!(owner_ids(&[win("pet-beta", false)], "default").is_empty());
        assert!(owner_ids(&[win("main", true)], "default").is_empty());
    }

    /// 经典窗与 pet-<id> 并存（历史遗留的重复召唤）也只报一次。
    #[test]
    fn owner_ids_dedupes_and_sorts() {
        assert_eq!(
            owner_ids(
                &[win("pet", true), win("pet-default", true), win("pet-beta", true)],
                "default"
            ),
            vec!["beta".to_string(), "default".to_string()]
        );
    }
}
