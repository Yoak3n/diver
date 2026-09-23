//! 桌宠互动文案组装（中文，陪伴角色自然搭话）。

use serde_json::{Map, Value};

use super::InteractionMode;

fn payload_str(payload: &Map<String, Value>, key: &str) -> String {
    payload
        .get(key)
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            other => other.to_string(),
        })
        .unwrap_or_else(|| "?".into())
}

fn detail_phrase(kind: &str, payload: &Map<String, Value>) -> String {
    match kind {
        "pet.drag.screen_changed" => {
            let from = payload_str(payload, "fromScreen");
            let to = payload_str(payload, "toScreen");
            let still = if payload.get("dragging").and_then(|v| v.as_bool()) == Some(true) {
                "，目前仍按住未松手"
            } else {
                ""
            };
            format!("用户把桌宠从屏幕 {from} 拖到了屏幕 {to}{still}。")
        }
        "pet.drag.long_hold" => {
            let hold = payload
                .get("holdMs")
                .and_then(|v| v.as_u64())
                .map(|n| n.to_string())
                .unwrap_or_else(|| "较长时间".into());
            format!("用户拖着你的桌宠已经约 {hold}ms 还没有松手。")
        }
        "pet.drag.dropped_edge" => {
            let edge = payload_str(payload, "edge");
            format!("用户把桌宠丢在了屏幕边缘（{edge}）。")
        }
        "pet.tap.burst" => {
            let count = payload_str(payload, "count");
            format!("用户在短时间内连续点了桌宠 {count} 次。")
        }
        other => format!("事件 {other}：{payload:?}"),
    }
}

fn context_lines(ctx: &Option<Value>, mode: InteractionMode) -> String {
    let Some(ctx) = ctx else {
        return String::new();
    };
    let mut lines = Vec::new();
    if let Some(d) = ctx.get("display") {
        let id = d
            .get("id")
            .map(|v| match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => "?".into(),
            })
            .unwrap_or_else(|| "?".into());
        let primary = if d.get("primary").and_then(|v| v.as_bool()) == Some(true) {
            "主屏"
        } else {
            "非主屏"
        };
        let w = d.get("width").and_then(|v| v.as_u64());
        let h = d.get("height").and_then(|v| v.as_u64());
        let size = match (w, h) {
            (Some(w), Some(h)) => format!("{w}x{h}"),
            _ => "分辨率未知".into(),
        };
        lines.push(format!("上下文: 屏幕 {id} 为 {size}（{primary}）。"));
    }
    if mode == InteractionMode::Context {
        if let Some(apps) = ctx.get("apps").and_then(|v| v.as_array()) {
            let names: Vec<String> = apps
                .iter()
                .filter_map(|a| a.as_str().map(|s| s.to_string()))
                .collect();
            if !names.is_empty() {
                lines.push(format!("该屏上的应用概览: {}。", names.join("、")));
            }
        }
    }
    lines.join("\n")
}

/// 组装注入给模型的文案（中文，陪伴角色自然搭话）。
pub fn build_interaction_prompt(ev: &super::PetGestureEvent, mode: InteractionMode) -> String {
    let display_id = ev
        .context
        .as_ref()
        .and_then(|c| c.get("display"))
        .and_then(|d| d.get("id"))
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => "?".into(),
        });
    let display_hint = match display_id {
        Some(id) => {
            format!("如果你想看看那边有什么，可以对 display {id} 截屏（不要截错屏幕）。")
        }
        None => "如果你想看看现场，可以截取对应显示器的画面（注意截对屏幕）。".into(),
    };
    let mut parts = vec![
        "[pet-interaction] 用户在你空闲时和你的桌宠互动了。".to_string(),
        format!("事件: {}", ev.kind),
        format!("细节: {}", detail_phrase(&ev.kind, &ev.payload)),
    ];
    let ctx = context_lines(&ev.context, mode);
    if !ctx.is_empty() {
        parts.push(ctx);
    }
    parts.push(format!(
        "提示: {display_hint} 请简短、自然地做出反应，像陪伴搭话，不要像传感器汇报。若无法读图，就基于以上粗略信息简单回应即可。"
    ));
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use super::super::{PetGestureEvent, InteractionMode};
    use super::build_interaction_prompt;

    #[test]
    fn prompt_screen_changed() {
        let ev = PetGestureEvent {
            kind: "pet.drag.screen_changed".into(),
            ts: Some(1),
            source: Some("pet".into()),
            payload: {
                let mut m = serde_json::Map::new();
                m.insert("fromScreen".into(), json!(0));
                m.insert("toScreen".into(), json!(1));
                m.insert("dragging".into(), json!(true));
                m
            },
            context: Some(json!({
                "display": { "id": 1, "width": 1920, "height": 1080, "primary": true }
            })),
        };
        let p = build_interaction_prompt(&ev, InteractionMode::Events);
        assert!(p.contains("pet.drag.screen_changed"));
        assert!(p.contains("屏幕 0"));
        assert!(p.contains("display 1"));
        assert!(!p.contains("应用概览"));
        let p2 = build_interaction_prompt(&ev, InteractionMode::Context);
        // context 模式无 apps 也不应崩
        assert!(p2.contains("事件:"));
    }

    #[test]
    fn prompt_long_hold() {
        let ev = PetGestureEvent {
            kind: "pet.drag.long_hold".into(),
            ts: None,
            source: None,
            payload: {
                let mut m = serde_json::Map::new();
                m.insert("holdMs".into(), json!(3200));
                m
            },
            context: None,
        };
        let p = build_interaction_prompt(&ev, InteractionMode::Events);
        assert!(p.contains("3200ms"));
    }
}
