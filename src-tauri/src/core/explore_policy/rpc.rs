//! Explore 执行面传输：sidecar HTTP RPC（pick-terms / explore / 状态轮询）。

use serde_json::Value;

pub(super) fn api_base() -> String {
    crate::core::sidecar::SidecarManager::global().api_base_url()
}

pub(super) async fn http_json(method: &str, url: &str, body: Option<Value>) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let builder = match method {
        "GET" => client.get(url),
        "POST" => client.post(url),
        other => return Err(format!("unsupported method: {other}")),
    };
    let builder = match body {
        Some(b) => builder.json(&b),
        None => builder,
    };
    let builder = builder.header("Authorization", crate::core::sidecar::auth_bearer());
    let res = builder
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let val = res
        .json::<Value>()
        .await
        .map_err(|e| format!("response parse failed: {e}"))?;
    if !status.is_success() && status.as_u16() != 202 {
        return Err(format!("HTTP {status}: {val}"));
    }
    Ok(val)
}
