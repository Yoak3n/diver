//! 群发言（`group::say`）与发送方落账。

use serde_json::{json, Value};

use crate::config::groups::{self, Group};
use crate::services::peer::{self, deliver, display_name, registry_rows, InstanceRow};
use crate::services::ServiceState;

use super::body::{client_msg_id, group_body};
use super::ops::{find_group, group_targets};
use super::rpc::text_param;

/// 群发言：目标 = 群成员 ∩ 在册实例 − 自己；逐个投递，单败不阻断。
/// `wake=true`（缺省，拍板 2026-09-27）`next-turn` 唤醒成员给发言机会；
/// `wake=false` `inject` 只入对方上下文不唤醒（对方下次开口才看到）。
/// 显示不依赖收方领取：fan-out 成功后把本条记进**发送方自己的落账存储**
/// （`$COS_HOME/group-sent.jsonl`，产品自有、不进 harness 会话日志），
/// 收方副本共享 clientMsgId 由前端按 id 去重。
pub(super) async fn say(state: &ServiceState, sender: &str, params: &Value) -> Result<Value, String> {
    let text = text_param(params, "text");
    if text.is_empty() {
        return Err("text 必填".to_string());
    }
    let key = text_param(params, "group");
    let file = groups::load_at(&state.groups_dir);
    let group = find_group(&file, &key)?.clone();
    let target = if params.get("wake").and_then(Value::as_bool).unwrap_or(true) {
        "next-turn"
    } else {
        "inject"
    };
    let rows = registry_rows(&(state.registry_list)()?);
    let targets = group_targets(&group, &rows, sender);
    if targets.is_empty() {
        return Err(format!("群「{}」没有其它在线成员可投递", group.name));
    }
    let client_msg_id = client_msg_id(sender);
    let body = group_body(&text, &display_name(&rows, sender), sender, target, &group, &client_msg_id);
    let result = fan_out(state, &targets, &body).await?;
    record_group_sent(state, sender, &rows, &text, &group, &client_msg_id, &result).await;
    Ok(result)
}

/// 发送方落账（拍板 2026-09-27）：至少投递成功一人时，向发送方自己的 backend
/// POST `/api/group-sent`，由其写入**产品自有落账存储**（`$COS_HOME/group-sent.jsonl`）
/// 并即时广播——群视图在发送时刻即显示本条，不等收方领取。
/// 落账失败只记日志（不影响发言结果）。
async fn record_group_sent(
    state: &ServiceState,
    sender: &str,
    rows: &[InstanceRow],
    text: &str,
    group: &Group,
    client_msg_id: &str,
    result: &Value,
) {
    let delivered = result
        .get("delivered")
        .and_then(Value::as_array)
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if !delivered {
        return;
    }
    let Some(row) = rows.iter().find(|r| r.id == sender) else {
        return;
    };
    let body = json!({
        "text": text,
        "from": { "id": sender, "name": display_name(rows, sender) },
        "group": { "id": group.id, "name": group.name },
        "clientMsgId": client_msg_id,
    });
    if let Err(err) = peer::post_instance(state, row, "/api/group-sent", &body).await {
        log::warn!("[groups] 发送方落账失败（{sender}）：{err}");
    }
}

/// 逐个投递（纯副作用），单败不阻断。
pub async fn fan_out(state: &ServiceState, targets: &[InstanceRow], body: &Value) -> Result<Value, String> {
    let mut delivered = Vec::new();
    let mut failed = Vec::new();
    for row in targets {
        match deliver(state, row, body).await {
            Ok(payload) => delivered.push(json!({
                "to": row.id,
                "messageId": payload.get("messageId").cloned().unwrap_or(Value::Null),
            })),
            Err(err) => failed.push(json!({ "to": row.id, "error": err })),
        }
    }
    Ok(json!({ "delivered": delivered, "failed": failed, "queued": body.get("target") }))
}
