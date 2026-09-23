//! 桌宠互动：手势语义事件 → 壳组文案 → CompanionPresence 裁决 → inject。
//!
//! 控制面在壳（见 docs/companion-presence-fsm.md / pet-interaction-events.md）。
//! sidecar 只执行 `POST /api/inject`，不再做闲时门控。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::core::presence::{request_and_inject, PresenceHandle};
use diver_presence::{Event, ProactiveConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionMode {
    Off,
    Events,
    Context,
}

impl Default for InteractionMode {
    fn default() -> Self {
        InteractionMode::Events
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetInteractionConfig {
    pub mode: InteractionMode,
    pub quiet_ms: u64,
    pub cooldown_ms: u64,
    pub max_triggers: u32,
    pub long_hold_ms: u64,
}

impl Default for PetInteractionConfig {
    fn default() -> Self {
        Self {
            mode: InteractionMode::Events,
            quiet_ms: 10_000,
            cooldown_ms: 45_000,
            max_triggers: 1,
            long_hold_ms: 3_000,
        }
    }
}

impl PetInteractionConfig {
    pub fn to_proactive(&self) -> ProactiveConfig {
        ProactiveConfig {
            quiet_ms: self.quiet_ms,
            cooldown_ms: self.cooldown_ms,
            max_triggers: self.max_triggers,
        }
    }
}

/// 手势事件（PetApp 经 invoke 上报）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetGestureEvent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub ts: Option<u64>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub payload: Map<String, Value>,
    #[serde(default)]
    pub context: Option<Value>,
}

fn num_or(v: &Value, fallback: u64, min: u64) -> u64 {
    v.as_u64()
        .filter(|n| *n >= min)
        .unwrap_or(fallback)
}

/// 从 `$COS_HOME/diver-settings.json` 读 `petInteraction`（与 backend 同文件）。
pub fn load_config() -> PetInteractionConfig {
    let path = diver_settings_path();
    let mut cfg = PetInteractionConfig::default();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return cfg;
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return cfg;
    };
    let Some(src) = v.get("petInteraction") else {
        return cfg;
    };
    if let Some(m) = src.get("mode").and_then(|x| x.as_str()) {
        cfg.mode = match m {
            "off" => InteractionMode::Off,
            "context" => InteractionMode::Context,
            _ => InteractionMode::Events,
        };
    }
    cfg.quiet_ms = num_or(src.get("quietMs").unwrap_or(&Value::Null), cfg.quiet_ms, 100);
    cfg.cooldown_ms = num_or(
        src.get("cooldownMs").unwrap_or(&Value::Null),
        cfg.cooldown_ms,
        100,
    );
    cfg.max_triggers = num_or(
        src.get("maxTriggers").unwrap_or(&Value::Null),
        cfg.max_triggers as u64,
        1,
    ) as u32;
    cfg.long_hold_ms = num_or(
        src.get("longHoldMs").unwrap_or(&Value::Null),
        cfg.long_hold_ms,
        500,
    );
    cfg
}

/// 写回 diver-settings.petInteraction（与 backend 设置页共用文件）。
pub fn save_config(cfg: &PetInteractionConfig) -> std::io::Result<()> {
    let path = diver_settings_path();
    let mut root: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    root["petInteraction"] = serde_json::to_value(cfg).unwrap_or_default();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap_or_default())
}

fn diver_settings_path() -> std::path::PathBuf {
    cos_home().join("diver-settings.json")
}

fn cos_home() -> std::path::PathBuf {
    if let Some(app) = crate::app::handle::Handle::global().app_handle() {
        return crate::config::cos_home(&app);
    }
    // 退化：与 sidecar 约定的 COS_HOME / debug 默认一致
    if let Ok(home) = std::env::var("COS_HOME") {
        return std::path::PathBuf::from(home);
    }
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .unwrap_or(&manifest)
        .join("harness")
        .join(".cos-home")
}

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
pub fn build_interaction_prompt(ev: &PetGestureEvent, mode: InteractionMode) -> String {
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

const PET_EVENT_TYPES: &[&str] = &[
    "pet.drag.screen_changed",
    "pet.drag.long_hold",
    "pet.drag.dropped_edge",
    "pet.tap.burst",
];

/// 同步配置到 ProactiveSpeak（设置保存 / 启动加载后调用）。
pub fn apply_config(cfg: &PetInteractionConfig) {
    PresenceHandle::global().set_proactive_config(cfg.to_proactive());
}

/// 手势事件入口：白名单 → L0 PET_GESTURE → 组文案 → request(proactive_inject) → L3。
pub async fn handle_pet_gesture(ev: PetGestureEvent) -> Value {
    if !PET_EVENT_TYPES.contains(&ev.kind.as_str()) {
        return json!({ "accepted": false, "reason": "bad_type" });
    }
    let cfg = load_config();
    apply_config(&cfg);
    if cfg.mode == InteractionMode::Off {
        return json!({ "accepted": false, "reason": "disabled" });
    }

    // T17：内部事件，不迁叶；L2 可据此反应（切片 0 只记账）
    PresenceHandle::global().handle_event(Event::PetGesture);

    let text = build_interaction_prompt(&ev, cfg.mode);
    let base = crate::core::sidecar::SidecarManager::global().api_base_url();
    match request_and_inject(&base, "pet-interaction", &text).await {
        Ok(body) => {
            let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            if ok {
                json!({
                    "accepted": true,
                    "triggered": true,
                    "messageId": body.get("dispatch").and_then(|d| d.get("messageId")).cloned().unwrap_or(Value::Null),
                })
            } else {
                let reason = body
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("rejected")
                    .to_string();
                json!({ "accepted": false, "reason": reason })
            }
        }
        Err(e) => json!({ "accepted": false, "reason": "dispatch_failed", "detail": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_screen_changed() {
        let ev = PetGestureEvent {
            kind: "pet.drag.screen_changed".into(),
            ts: Some(1),
            source: Some("pet".into()),
            payload: {
                let mut m = Map::new();
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
                let mut m = Map::new();
                m.insert("holdMs".into(), json!(3200));
                m
            },
            context: None,
        };
        let p = build_interaction_prompt(&ev, InteractionMode::Events);
        assert!(p.contains("3200ms"));
    }
}
