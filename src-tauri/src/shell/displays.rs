//! 显示器清单（canonical 编号）：与截屏工具 `list_displays` 同序同号。
//!
//! 桌宠互动事件上下文、`list_monitors` command、桌宠跨屏定位都从这里取屏，
//! 保证事件里说的「屏幕 N」就是工具认的 `display N`——排序键复用
//! `diver_shot::canonicalize_displays`，禁止再按枚举原序当编号用。

use serde_json::{json, Value};
use tauri::AppHandle;

use diver_shot::{canonicalize_displays, DisplayInfo, Rect};

/// canonical 显示器清单：Tauri 枚举（物理坐标、全平台可用）+ diver-shot 规范序。
pub fn canonical_displays(app: &AppHandle) -> Vec<DisplayInfo> {
    let monitors = app.available_monitors().unwrap_or_default();
    // 本版 Tauri 的 Monitor 未暴露 primary 标记：用 primary_monitor() 的身份比对。
    // 优先 name 精确比对——镜像屏坐标相同，位置比对会把副屏也标成 primary。
    let primary = app.primary_monitor().ok().flatten();
    let primary_name = primary.as_ref().and_then(|m| m.name()).cloned();
    let primary_pos = primary.as_ref().map(|m| *m.position());
    let list = monitors
        .iter()
        .map(|m| {
            let p = *m.position();
            let s = *m.size();
            let a = *m.work_area();
            DisplayInfo {
                index: 0,
                name: m.name().cloned().unwrap_or_default(),
                primary: is_primary(
                    primary_name.as_deref(),
                    m.name().map(String::as_str),
                    primary_pos.map(|q| (q.x, q.y)),
                    (p.x, p.y),
                ),
                x: p.x,
                y: p.y,
                width: s.width,
                height: s.height,
                work: Rect {
                    x: a.position.x,
                    y: a.position.y,
                    width: a.size.width,
                    height: a.size.height,
                },
            }
        })
        .collect();
    canonicalize_displays(list)
}

/// IPC 形状（前端 `MonitorInfo`）：`index` 即 canonical 编号。
pub fn monitor_json(displays: &[DisplayInfo]) -> Vec<Value> {
    displays
        .iter()
        .map(|d| {
            json!({
                "index": d.index,
                "name": d.name,
                "x": d.x,
                "y": d.y,
                "width": d.width,
                "height": d.height,
                "primary": d.primary,
            })
        })
        .collect()
}

/// 主屏判定（纯函数）：name 双方都有时精确比对；name 缺失退回位置比对。
///
/// 位置比对兜底仅用于 name 缺失的平台/退化枚举——镜像屏坐标相同会双标。
fn is_primary(
    primary_name: Option<&str>,
    name: Option<&str>,
    primary_pos: Option<(i32, i32)>,
    pos: (i32, i32),
) -> bool {
    match (primary_name, name) {
        (Some(pn), Some(mn)) => pn == mn,
        _ => primary_pos == Some(pos),
    }
}

/// `list_monitors` command 数据源。
pub fn list_monitors_json(app: &AppHandle) -> Vec<Value> {
    monitor_json(&canonical_displays(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(name: &str, primary: bool, x: i32, y: i32, width: u32, height: u32) -> DisplayInfo {
        DisplayInfo {
            index: 7,
            name: name.into(),
            primary,
            x,
            y,
            width,
            height,
            work: Rect { x, y, width, height },
        }
    }

    #[test]
    fn monitor_json_carries_identity_fields() {
        let v = &monitor_json(&[display(r"\\.\DISPLAY1", true, 0, 0, 2560, 1440)])[0];
        assert_eq!(v["index"], 7);
        assert_eq!(v["name"], r"\\.\DISPLAY1");
        assert_eq!(v["x"], 0);
        assert_eq!(v["y"], 0);
        assert_eq!(v["width"], 2560);
        assert_eq!(v["height"], 1440);
        assert_eq!(v["primary"], true);
    }

    #[test]
    fn monitor_json_preserves_canonical_order() {
        let list = canonicalize_displays(vec![
            display("B", false, 2560, 0, 1440, 2560),
            display("A", true, 0, 0, 2560, 1440),
        ]);
        let json = monitor_json(&list);
        assert_eq!(json[0]["name"], "A");
        assert_eq!(json[0]["index"], 0);
        assert_eq!(json[1]["name"], "B");
        assert_eq!(json[1]["index"], 1);
    }

    #[test]
    fn primary_matched_by_name_not_position() {
        // 镜像屏：两块屏坐标相同，只有 name 对上的那块是 primary。
        assert!(is_primary(Some("A"), Some("A"), Some((0, 0)), (0, 0)));
        assert!(!is_primary(Some("A"), Some("B"), Some((0, 0)), (0, 0)));
    }

    #[test]
    fn primary_falls_back_to_position_when_name_missing() {
        assert!(is_primary(None, Some("B"), Some((0, 0)), (0, 0)));
        assert!(!is_primary(Some("A"), None, Some((0, 0)), (2560, 0)));
    }
}
