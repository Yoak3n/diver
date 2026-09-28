//! 回报注入：注册表寻址发起实例 → POST /api/inbox（Bearer，P2-1 同闸）。

use std::time::Duration;

use serde_json::json;

use crate::core::instance_registry;

use super::types::Paths;

/// 回报注入：注册表寻址发起实例 → POST /api/inbox（Bearer，P2-1 同闸）。
pub fn notify(paths: &Paths, instance: &str, text: &str, target: &str) -> Result<(), String> {
    let rows = instance_registry::list_at(&paths.registry_dir);
    let rec = rows
        .iter()
        .find(|r| r.id == instance)
        .ok_or_else(|| format!("实例「{instance}」不在注册表，无法回报"))?;
    let body = json!({
        "text": text,
        "from": { "id": "delegate", "name": "任务委派" },
        "target": target,
        "kind": "peer",
    });
    let url = format!("http://127.0.0.1:{}/api/inbox", rec.port);
    let resp = reqwest::blocking::Client::new()
        .post(&url)
        .bearer_auth(crate::core::sidecar::service_token())
        .timeout(Duration::from_secs(5))
        .json(&body)
        .send()
        .map_err(|err| format!("回报投递失败（{url}）：{err}"))?;
    if !resp.status().is_success() {
        return Err(format!("回报被拒（{}）", resp.status()));
    }
    Ok(())
}
