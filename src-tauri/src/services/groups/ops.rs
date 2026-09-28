//! 群务操作（`group::{create,invite,respond}`）与目标解析。

use serde_json::{json, Value};

use crate::config::groups::{self, Group, GroupsFile, Invite, SYSTEM_SENDER};
use crate::services::peer::{deliver, display_name, registry_rows, InstanceRow};
use crate::services::ServiceState;

use super::body::{client_msg_id, group_body, invite_body};
use super::rpc::text_param;

/// 建群（agent 自建群）：只把创建者入册；`members` 是邀请名单，逐一发邀请
/// （对方 accept 才入册——拍板：拉人可拒绝）。
pub(super) async fn create(state: &ServiceState, sender: &str, params: &Value) -> Result<Value, String> {
    let name = text_param(params, "name");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let members: Vec<String> = params
        .get("members")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let mut file = groups::load_at(&state.groups_dir);
    let group = groups::create_group(&mut file, &name, &members, sender, now)?;
    groups::save_at(&state.groups_dir, &file)?;
    let rows = registry_rows(&(state.registry_list)()?);
    let sender_name = display_name(&rows, sender);
    let mut invited = Vec::new();
    let mut failed = Vec::new();
    for to in members.iter().filter(|m| m.as_str() != sender) {
        let message = format!("邀请你加入群聊「{}」。", group.name);
        if let Err(err) = invite_member(state, &mut file, &group, sender, &sender_name, to, &message, &rows, now).await
        {
            failed.push(json!({ "to": to, "error": err }));
        } else {
            invited.push(to.clone());
        }
    }
    groups::save_at(&state.groups_dir, &file)?;
    Ok(json!({
        "group": { "id": group.id, "name": group.name, "members": group.members },
        "invited": invited,
        "failed": failed,
    }))
}

/// 拉人进群（成员皆可邀请）：留痕 + 唤醒投递（对方 agent 自主裁决）。
pub(super) async fn invite(state: &ServiceState, sender: &str, params: &Value) -> Result<Value, String> {
    let key = text_param(params, "group");
    let to = text_param(params, "to");
    let message = text_param(params, "message");
    if to.is_empty() {
        return Err("to 必填".to_string());
    }
    let mut file = groups::load_at(&state.groups_dir);
    let group = find_group(&file, &key)?.clone();
    if !group.system && !group.members.iter().any(|m| m == sender) {
        return Err(format!("你不在群「{}」里，不能邀请", group.name));
    }
    let rows = registry_rows(&(state.registry_list)()?);
    let sender_name = display_name(&rows, sender);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let invite = invite_member(state, &mut file, &group, sender, &sender_name, &to, &message, &rows, now).await?;
    groups::save_at(&state.groups_dir, &file)?;
    Ok(json!({ "inviteId": invite.id, "to": to, "group": group.id }))
}

/// 应答邀请（被邀方 agent 自主裁决）：
/// accept → 入群 + 群内 `inject` 系统条「X 加入了群聊」；
/// decline → 显式告知邀请者 + 理由（拍板）。
pub(super) async fn respond(state: &ServiceState, sender: &str, params: &Value) -> Result<Value, String> {
    let key = text_param(params, "group");
    let accept = params.get("accept").and_then(Value::as_bool).unwrap_or(false);
    let reason = text_param(params, "reason");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut file = groups::load_at(&state.groups_dir);
    let group = find_group(&file, &key)?.clone();
    let invite_id = file
        .invites
        .iter()
        .find(|i| i.group_id == group.id && i.to == sender && i.status == "pending")
        .map(|i| i.id.clone())
        .ok_or_else(|| format!("没有等你处理的「{}」邀请", group.name))?;
    let invite = groups::apply_response(&mut file, &invite_id, accept, &reason, now)?;
    groups::save_at(&state.groups_dir, &file)?;
    let rows = registry_rows(&(state.registry_list)()?);
    let sender_name = display_name(&rows, sender);
    let mut delivered = Vec::new();
    if accept {
        let text = format!("「{sender_name}」加入了群聊。");
        let body = group_body(&text, "系统", SYSTEM_SENDER, "inject", &group, &client_msg_id(sender));
        for to in group.members.iter().filter(|m| m.as_str() != sender) {
            if let Some(row) = rows.iter().find(|r| r.id == *to) {
                if deliver(state, row, &body).await.is_ok() {
                    delivered.push(to.clone());
                }
            }
        }
    } else {
        let text = if reason.is_empty() {
            format!("「{sender_name}」婉拒了你的群聊邀请。")
        } else {
            format!("「{sender_name}」婉拒了你的群聊邀请：{reason}")
        };
        let body = json!({
            "text": text,
            "from": { "id": sender, "name": sender_name },
            "target": "next-turn",
            "kind": "peer",
        });
        if let Some(row) = rows.iter().find(|r| r.id == invite.from) {
            if deliver(state, row, &body).await.is_ok() {
                delivered.push(invite.from.clone());
            }
        }
    }
    Ok(json!({
        "inviteId": invite.id,
        "status": invite.status,
        "group": { "id": group.id, "name": group.name },
        "delivered": delivered,
    }))
}

/// 解析群（缺省 = 系统全员群；id 或名皆可）。
pub(super) fn find_group<'a>(file: &'a GroupsFile, key: &str) -> Result<&'a Group, String> {
    let key = key.trim();
    if key.is_empty() {
        return groups::find(file, groups::GENERAL_ID)
            .ok_or_else(|| "系统全员群缺失".to_string());
    }
    groups::find(file, key).ok_or_else(|| {
        let names: Vec<&str> = file.groups.iter().map(|g| g.name.as_str()).collect();
        format!("未知群「{key}」，可用群：{}", names.join("、"))
    })
}

/// 群投递目标（纯函数）：成员 ∩ 在册实例 − 自己。
pub fn group_targets(group: &Group, rows: &[InstanceRow], sender: &str) -> Vec<InstanceRow> {
    let all: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let members = groups::members_of(group, &all);
    rows.iter()
        .filter(|r| r.id != sender && members.iter().any(|m| m == &r.id))
        .cloned()
        .collect()
}

/// 邀请单个成员：留痕 + 投递邀请消息。
async fn invite_member(
    state: &ServiceState,
    file: &mut GroupsFile,
    group: &Group,
    sender: &str,
    sender_name: &str,
    to: &str,
    message: &str,
    rows: &[InstanceRow],
    now: u64,
) -> Result<Invite, String> {
    let row = rows
        .iter()
        .find(|r| r.id == to)
        .ok_or_else(|| format!("未知实例「{to}」"))?;
    let invite = groups::add_invite(file, group, sender, to, message, now)?;
    let body = invite_body(message, sender_name, sender, group);
    deliver(state, row, &body).await?;
    Ok(invite)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::groups::{create_group, ensure_general, GroupsFile};

    #[test]
    fn group_targets_members_minus_self() {
        let mut f = GroupsFile::default();
        ensure_general(&mut f);
        let rows = vec![
            InstanceRow { id: "default".into(), name: "默认".into(), port: 1 },
            InstanceRow { id: "beta".into(), name: "".into(), port: 2 },
            InstanceRow { id: "gamma".into(), name: "".into(), port: 3 },
        ];
        // 全员群 = 在册全体 − 自己
        let general = groups::find(&f, groups::GENERAL_ID).unwrap();
        let targets = group_targets(general, &rows, "beta");
        let ids: Vec<&str> = targets.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["default", "gamma"]);
        // 普通群 = 成员 ∩ 在册 − 自己（创建只有创建者；gamma 受邀 accept 后入册）
        let g = create_group(&mut f, "小圈", &["gamma".into()], "beta", 1).unwrap();
        assert!(group_targets(&g, &rows, "beta").is_empty(), "未 accept 不入册");
        let inv = groups::add_invite(&mut f, &g, "beta", "gamma", "来", 2).unwrap();
        groups::apply_response(&mut f, &inv.id, true, "", 3).unwrap();
        let g = groups::find(&f, &g.id).unwrap().clone();
        let targets = group_targets(&g, &rows, "beta");
        let ids: Vec<&str> = targets.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["gamma"]);
    }

    #[test]
    fn find_group_defaults_to_general_and_lists_on_error() {
        let mut f = GroupsFile::default();
        ensure_general(&mut f);
        create_group(&mut f, "开黑", &[], "default", 1).unwrap();
        assert_eq!(find_group(&f, "").unwrap().id, groups::GENERAL_ID);
        assert_eq!(find_group(&f, "开黑").unwrap().id, "group-2");
        let err = find_group(&f, "无此群").unwrap_err();
        assert!(err.contains("开黑") && err.contains("全员群"), "错误应列出可用群：{err}");
    }
}
