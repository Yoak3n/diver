//! 用户面板群务（P2-4 二期）：改名 / 移出成员 / 解散群 + 群系统事件广播。
//!
//! 与 agent 侧 `group::` RPC（groups.rs）同盘同语义（`config::groups`）；
//! 发起方是壳层用户（无身份头、无 sender 概念）。群系统事件（改名/移出/解散）
//! 统一走 `inject`（收听不吵），from = `system`（与入群系统条同构）。
//! 系统群不可改名/移出/解散（成员动态跟随实例增删，纯迁移层已拒）。

use serde_json::{json, Value};

use crate::config::groups::{self, Group, SYSTEM_SENDER};

use super::groups::{client_msg_id, fan_out, group_body, group_targets};
use super::peer::{deliver, display_name, registry_rows, InstanceRow};
use super::ServiceState;

/// 注册表行（容错）：注册中心暂不可用时按空表处理（事件照发，目标为空 = 无人收）。
fn registry_rows_lenient(state: &ServiceState) -> Vec<InstanceRow> {
    (state.registry_list)()
        .map(|v| registry_rows(&v))
        .unwrap_or_default()
}

/// fan_out 结果 → (送达 id 列表, 失败 {to, error} 列表)。
fn fan_summary(v: &Value) -> (Vec<String>, Vec<Value>) {
    let delivered = v
        .get("delivered")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.get("to").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let failed = v
        .get("failed")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    let to = x.get("to")?;
                    let error = x.get("error").and_then(Value::as_str).unwrap_or("未知错误");
                    Some(json!({ "to": to, "error": error }))
                })
                .collect()
        })
        .unwrap_or_default();
    (delivered, failed)
}

/// 群系统事件：inject 到群成员（成员 ∩ 在册），单败不阻断。
async fn system_event(state: &ServiceState, group: &Group, text: &str) -> (Vec<String>, Vec<Value>) {
    let rows = registry_rows_lenient(state);
    let targets = group_targets(group, &rows, "");
    let body = group_body(text, "系统", SYSTEM_SENDER, "inject", group, &client_msg_id(SYSTEM_SENDER));
    match fan_out(state, &targets, &body).await {
        Ok(v) => fan_summary(&v),
        Err(err) => (
            Vec::new(),
            targets
                .iter()
                .map(|r| json!({ "to": r.id, "error": err }))
                .collect(),
        ),
    }
}

/// 改名：纯迁移（系统群/重名/空名拒绝）→ 落盘 → 广播系统条。
pub async fn user_rename_group(state: &ServiceState, key: &str, name: &str) -> Result<Value, String> {
    let mut file = groups::load_at(&state.groups_dir);
    let old_name = groups::find(&file, key)
        .ok_or_else(|| format!("未知群「{key}」"))?
        .name
        .clone();
    let group = groups::rename_group(&mut file, key, name)?;
    groups::save_at(&state.groups_dir, &file)?;
    let (delivered, failed) =
        system_event(state, &group, &format!("群聊「{old_name}」已更名为「{}」。", group.name)).await;
    Ok(json!({ "group": { "id": group.id, "name": group.name }, "delivered": delivered, "failed": failed }))
}

/// 移出成员（拍板「用户事后可撤人」）：剩余成员收群系统条，被移者单独收告知。
pub async fn user_remove_group_member(state: &ServiceState, key: &str, member: &str) -> Result<Value, String> {
    let mut file = groups::load_at(&state.groups_dir);
    let group = groups::remove_member(&mut file, key, member)?;
    groups::save_at(&state.groups_dir, &file)?;
    let rows = registry_rows_lenient(state);
    let member_name = display_name(&rows, member);
    // 剩余成员：group_targets 按新成员表过滤，被移者自然排除。
    let mut delivered = Vec::new();
    let mut failed = Vec::new();
    let body = group_body(
        &format!("「{member_name}」被移出了群聊。"),
        "系统",
        SYSTEM_SENDER,
        "inject",
        &group,
        &client_msg_id(SYSTEM_SENDER),
    );
    let targets = group_targets(&group, &rows, "");
    match fan_out(state, &targets, &body).await {
        Ok(v) => {
            let (d, f) = fan_summary(&v);
            delivered.extend(d);
            failed.extend(f);
        }
        Err(err) => failed.extend(
            targets
                .iter()
                .map(|r| json!({ "to": r.id, "error": err }))
                .collect::<Vec<_>>(),
        ),
    }
    // 被移者本人（已不在成员表，单独告知——agent 下一轮看见，此后不再收该群投递）。
    if let Some(row) = rows.iter().find(|r| r.id == member) {
        let body = group_body(
            &format!("你被移出了群聊「{}」。", group.name),
            "系统",
            SYSTEM_SENDER,
            "inject",
            &group,
            &client_msg_id(member),
        );
        match deliver(state, row, &body).await {
            Ok(_) => delivered.push(row.id.clone()),
            Err(err) => failed.push(json!({ "to": row.id, "error": err })),
        }
    }
    Ok(json!({ "group": { "id": group.id, "name": group.name }, "removed": member, "delivered": delivered, "failed": failed }))
}

/// 解散群：先广播（群还在盘上、成员表完整），后删除落盘；邀请记录保留（留痕）。
pub async fn user_delete_group(state: &ServiceState, key: &str) -> Result<Value, String> {
    let mut file = groups::load_at(&state.groups_dir);
    let group = groups::find(&file, key)
        .ok_or_else(|| format!("未知群「{key}」"))?
        .clone();
    let (delivered, failed) =
        system_event(state, &group, &format!("群聊「{}」已解散。", group.name)).await;
    groups::delete_group(&mut file, key)?;
    groups::save_at(&state.groups_dir, &file)?;
    if failed.is_empty() {
        log::info!("群「{}」已解散（通知 {} 名成员）", group.name, delivered.len());
    } else {
        log::warn!(
            "群「{}」已解散；{} 名成员通知失败：{}",
            group.name,
            failed.len(),
            failed
                .iter()
                .filter_map(|f| Some(format!("{}: {}", f.get("to")?, f.get("error")?)))
                .collect::<Vec<_>>()
                .join("；")
        );
    }
    Ok(json!({ "group": { "id": group.id, "name": group.name }, "delivered": delivered, "failed": failed }))
}
