//! `/rpc presence::*` 派发（Node sidecar 经 `x-diver-instance` 头路由到实例 FSM）
//! 与已裁决注入的 L3 HTTP 下发（sidecar 无门控执行）。

use diver_presence::{Event, InjectRequest, ProactiveConfig, Regime};
use serde_json::{json, Value};

use super::{instance_snapshot_json, resolve_instance_id, PresenceHandle};

/// 解析 sidecar `/rpc` 上的 presence 方法（按 `x-diver-instance` 路由到实例 FSM；
/// 无头/未知 id 回退 active 实例）。
pub fn dispatch_rpc(instance: Option<&str>, method: &str, params: &Value) -> Result<Value, String> {
    let resolved = resolve_instance_id(instance);
    let handle = PresenceHandle::instance(&resolved);
    match method {
        "presence::ping" => Ok(Value::Null),
        "presence::phase" => Ok(json!({ "phase": handle.phase().as_str() })),
        "presence::snapshot" => Ok(instance_snapshot_json(instance)),
        "presence::busy" => {
            let busy = params.get("busy").and_then(|v| v.as_bool()).unwrap_or(false);
            handle.apply_event(Event::Busy(busy));
            Ok(json!({ "busy": busy }))
        }
        "presence::event" => {
            let ty = params
                .get("type")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "type 必填".to_string())?;
            let now = diver_presence::types::now_ms();
            let ev = match ty {
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
                "REGIME" => {
                    let name = params
                        .get("regime")
                        .and_then(|v| v.as_str())
                        .unwrap_or("normal");
                    let regime = match name {
                        "dnd" => Regime::Dnd,
                        "quiet_hours" => Regime::QuietHours,
                        "focus" => Regime::Focus,
                        "sleep" => Regime::Sleep,
                        _ => Regime::Normal,
                    };
                    Event::Regime(regime)
                }
                "ENABLED" => Event::Enabled(params.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true)),
                other => return Err(format!("未知 presence 事件: {other}")),
            };
            handle.apply_event(ev);
            handle.with(|p| p.evaluate(now));
            Ok(json!({ "phase": handle.phase().as_str() }))
        }
        "presence::set_config" => {
            let now = diver_presence::types::now_ms();
            let cfg = handle.with(|p| p.snapshot(now).proactive);
            let next = ProactiveConfig {
                quiet_ms: params
                    .get("quietMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(cfg.quiet_ms),
                cooldown_ms: params
                    .get("cooldownMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(cfg.cooldown_ms),
                max_triggers: params
                    .get("maxTriggers")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(cfg.max_triggers as u64)
                    as u32,
            };
            handle.set_proactive_config(next);
            Ok(json!({
                "quietMs": next.quiet_ms,
                "cooldownMs": next.cooldown_ms,
                "maxTriggers": next.max_triggers,
            }))
        }
        "presence::request_inject" => {
            let source = params
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("proactive")
                .to_string();
            let text = params
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                return Err("text 必填".into());
            }
            let (result, payload) = handle.request_proactive_inject(&source, &text);
            let mut body = serde_json::to_value(&result).unwrap_or(Value::Null);
            if body.is_null() {
                body = json!({ "ok": false, "reason": "serialize_failed" });
            }
            if let Some(p) = payload {
                body["inject"] = serde_json::to_value(&p).unwrap_or(Value::Null);
            }
            Ok(body)
        }
        _ => Err(format!("未知 presence 方法: {method}")),
    }
}

/// L3：把已裁决注入发给 sidecar `POST /api/inject`（无门控）。
pub async fn dispatch_inject(base_url: &str, req: &InjectRequest) -> Result<Value, String> {
    let url = format!("{}/api/inject", base_url.trim_end_matches('/'));
    let body = json!({
        "text": req.text,
        "source": { "kind": "plugin", "detail": req.detail },
        "origin": req.source,
    });
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .header("Authorization", crate::core::sidecar::auth_bearer())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("inject 请求失败: {e}"))?;
    let status = res.status();
    let val = res
        .json::<Value>()
        .await
        .map_err(|e| format!("inject 响应解析失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("inject HTTP {status}: {val}"));
    }
    Ok(val)
}

/// 壳命令 / 内部调用：裁决 + 下发注入（active 实例）。
pub async fn request_and_inject(
    base_url: &str,
    source: &str,
    text: &str,
) -> Result<Value, String> {
    let (result, payload) = PresenceHandle::active().request_proactive_inject(source, text);
    let mut body = serde_json::to_value(&result).map_err(|e| e.to_string())?;
    match (result.is_ok(), payload) {
        (true, Some(req)) => match dispatch_inject(base_url, &req).await {
            Ok(val) => {
                // 注入成功推进静默（与 claim 分离，避免冷却/静默纠缠）
                PresenceHandle::active().apply_event(Event::ChatActivity);
                body["dispatch"] = val;
            }
            Err(e) => {
                // 已 claim 不回滚：记日志，不双 claim
                log::warn!("[presence] L3 inject 失败: {e}");
                body["dispatchError"] = json!(e);
            }
        },
        _ => {}
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dispatch_rpc_routes_by_instance_header() {
        dispatch_rpc(Some("test-route-a"), "presence::event", &json!({ "type": "USER_CHAT" })).unwrap();
        dispatch_rpc(Some("test-route-a"), "presence::busy", &json!({ "busy": true })).unwrap();
        let a = dispatch_rpc(Some("test-route-a"), "presence::phase", &json!({})).unwrap();
        let b = dispatch_rpc(Some("test-route-b"), "presence::phase", &json!({})).unwrap();
        assert_eq!(a["phase"], json!("thinking"));
        assert_ne!(a["phase"], b["phase"]);
        // snapshot 带实例身份（UI 标注展示来源）
        let snap = dispatch_rpc(Some("test-route-a"), "presence::snapshot", &json!({})).unwrap();
        assert_eq!(snap["instance"], json!("test-route-a"));
    }
}
