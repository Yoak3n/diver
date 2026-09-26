//! 互实例消息路由（P2-2）：`peer::send` → 注册表解析对端 → POST 对端 `/api/inbox`。
//!
//! 拓扑拍板：壳 = 注册中心 + 消息路由。发送方身份取 `X-Diver-Instance` 身份头
//! （sidecar 进程 env 固定，客户端不可伪），壳把 `from` 盖章进消息体后投递；
//! 对端把消息注入 session inbox（`next-turn` / `next-step`），agent 下一轮当输入。

use serde_json::{json, Value};

use super::grep::RpcFailure;
use super::ServiceState;

/// 注册表行投影（`registry::list` 返回项 → 消息路由所需字段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceRow {
    pub id: String,
    pub name: String,
    pub port: u16,
}

/// 注册表 JSON → 行投影（纯函数）：`name` 缺失/为 null 记空串，缺 `port` 的行跳过。
pub fn registry_rows(value: &Value) -> Vec<InstanceRow> {
    value
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let id = row.get("id")?.as_str()?.to_string();
                    let name = row
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let port = row.get("port")?.as_u64()? as u16;
                    Some(InstanceRow { id, name, port })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn list_ids(rows: &[InstanceRow]) -> String {
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    if ids.is_empty() {
        "（无）".to_string()
    } else {
        ids.join("、")
    }
}

/// 解析发送方与目标（纯函数）：自我发送拒绝；未知 id 报错并列出可用实例。
/// 返回（发送方显示名，缺省 = id；目标行）。
pub fn resolve_route(
    rows: &[InstanceRow],
    sender: &str,
    to: &str,
) -> Result<(String, InstanceRow), String> {
    if sender == to {
        return Err("不能给自己发消息".to_string());
    }
    let target = rows
        .iter()
        .find(|r| r.id == to)
        .cloned()
        .ok_or_else(|| format!("未知目标实例「{to}」，可用实例：{}", list_ids(rows)))?;
    let sender_name = rows
        .iter()
        .find(|r| r.id == sender)
        .map(|r| {
            if r.name.is_empty() {
                r.id.clone()
            } else {
                r.name.clone()
            }
        })
        .unwrap_or_else(|| sender.to_string());
    Ok((sender_name, target))
}

/// `/api/inbox` 请求体（纯函数）：`from` 由壳盖章（来源可信）。
pub fn inbox_body(text: &str, sender_name: &str, sender: &str, target: &str) -> Value {
    json!({
        "text": text,
        "from": { "id": sender, "name": sender_name },
        "target": target,
    })
}

/// `peer::*` 分发（P2-2）。
pub async fn dispatch(
    state: &ServiceState,
    instance_id: Option<&str>,
    method: &str,
    params: &Value,
) -> Result<Value, RpcFailure> {
    match method {
        "peer::send" => send(state, instance_id, params).await.map_err(RpcFailure::new),
        other => Err(RpcFailure::new(format!("未知 peer 方法：{other}"))),
    }
}

async fn send(
    state: &ServiceState,
    instance_id: Option<&str>,
    params: &Value,
) -> Result<Value, String> {
    let to = params
        .get("to")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if to.is_empty() || text.is_empty() {
        return Err("to 与 text 必填".to_string());
    }
    let target = match params.get("target").and_then(Value::as_str).unwrap_or("next-turn") {
        "next-step" => "next-step",
        _ => "next-turn",
    };
    // 发送方身份：X-Diver-Instance 头（sidecar env 固定，不可伪），无头回退 active。
    let sender = instance_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| state.memory.fallback());
    let rows = registry_rows(&(state.registry_list)()?);
    let (sender_name, target_row) = resolve_route(&rows, sender, &to)?;
    let body = inbox_body(&text, &sender_name, sender, target);

    let url = format!("http://127.0.0.1:{}/api/inbox", target_row.port);
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&state.auth_token)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("对端投递失败（{}:{}）：{err}", target_row.id, target_row.port))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("对端响应不是 JSON（{status}）：{err}"))?;
    if !status.is_success() {
        return Err(format!(
            "对端拒绝（{status}）：{}",
            payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("未知错误")
        ));
    }
    Ok(json!({
        "to": target_row.id,
        "messageId": payload.get("messageId").cloned().unwrap_or(Value::Null),
        "queued": payload.get("queued").cloned().unwrap_or(Value::Null),
    }))
}

#[cfg(test)]
mod tests {
    use super::{inbox_body, registry_rows, resolve_route, InstanceRow};
    use serde_json::json;

    fn row(id: &str, name: &str, port: u16) -> InstanceRow {
        InstanceRow {
            id: id.to_string(),
            name: name.to_string(),
            port,
        }
    }

    #[test]
    fn registry_rows_projects_id_name_port() {
        let rows = registry_rows(&json!([
            { "id": "default", "name": null, "pid": 1, "port": 6285, "startedAt": 1 },
            { "id": "beta", "name": "小贝", "pid": 2, "port": 2496, "startedAt": 2 },
            { "id": "broken", "name": "缺端口" }
        ]));
        assert_eq!(rows.len(), 2, "缺 port 的行应被跳过");
        assert_eq!(rows[0].name, "", "name 为 null 记空串");
        assert_eq!(rows[1].port, 2496);
    }

    #[test]
    fn route_rejects_self_and_unknown_target() {
        let rows = vec![row("default", "默认", 1), row("beta", "小贝", 2)];
        assert!(
            resolve_route(&rows, "beta", "beta").unwrap_err().contains("自己"),
            "自我发送应被拒绝"
        );
        let err = resolve_route(&rows, "default", "gamma").unwrap_err();
        assert!(err.contains("gamma"), "错误应点名未知 id：{err}");
        assert!(err.contains("default") && err.contains("beta"), "错误应列出可用实例");
        let (name, target) = resolve_route(&rows, "default", "beta").unwrap();
        assert_eq!(name, "默认");
        assert_eq!(target.port, 2);
    }

    #[test]
    fn inbox_body_stamps_sender() {
        let body = inbox_body("你好", "小贝", "beta", "next-step");
        assert_eq!(body["from"]["id"], "beta");
        assert_eq!(body["from"]["name"], "小贝");
        assert_eq!(body["text"], "你好");
        assert_eq!(body["target"], "next-step");
    }
}
