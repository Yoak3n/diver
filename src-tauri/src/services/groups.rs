//! 群组消息与群务（P2-4）：`group::{list,say,create,invite,respond}`。
//! 群 = 壳层实体（`config::groups`，与实例注册表同层）；投递复用 peer 路由
//! （壳盖章 from/kind/group，对端 `/api/inbox` 注入）。
//!
//! 拍板：邀请裁决 = 被邀实例 agent 自主（respond 自决）；拒绝 = 显式告知邀请者 + 理由；
//! 群系统事件（入群等）走 `inject`（收听不吵）。

use serde_json::{json, Value};

use crate::config::groups::{self, Group, GroupsFile, Invite, SYSTEM_SENDER};

use super::grep::RpcFailure;
use super::peer::{deliver, display_name, registry_rows, InstanceRow};
use super::ServiceState;

/// `group::*` 分发（P2-4）。
pub async fn dispatch(
    state: &ServiceState,
    instance_id: Option<&str>,
    method: &str,
    params: &Value,
) -> Result<Value, RpcFailure> {
    let sender = instance_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| state.memory.fallback());
    match method {
        "group::list" => list(state, sender).map_err(RpcFailure::new),
        "group::say" => say(state, sender, params).await.map_err(RpcFailure::new),
        "group::create" => create(state, sender, params).await.map_err(RpcFailure::new),
        "group::invite" => invite(state, sender, params).await.map_err(RpcFailure::new),
        "group::respond" => respond(state, sender, params).await.map_err(RpcFailure::new),
        other => Err(RpcFailure::new(format!("未知 group 方法：{other}"))),
    }
}

fn text_param(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

/// 群消息请求体：`group` 供收方盖 `【群聊「组名」｜…】` 章并挂归属标；
/// `clientMsgId` = 整次 fan-out 共享 id，各收方副本与发送方落账同 id（UI 按 id 去重）。
pub(crate) fn group_body(
    text: &str,
    sender_name: &str,
    sender: &str,
    target: &str,
    group: &Group,
    client_msg_id: &str,
) -> Value {
    json!({
        "text": text,
        "from": { "id": sender, "name": sender_name },
        "target": target,
        "kind": "group",
        "group": { "id": group.id, "name": group.name },
        "clientMsgId": client_msg_id,
    })
}

/// 邀请请求体：收方 agent 见章后调 `respond_invite` 自主裁决。
fn invite_body(message: &str, sender_name: &str, sender: &str, group: &Group) -> Value {
    let text = if message.trim().is_empty() {
        format!("邀请你加入群聊「{}」。", group.name)
    } else {
        message.trim().to_string()
    };
    json!({
        "text": text,
        "from": { "id": sender, "name": sender_name },
        "target": "next-turn",
        "kind": "invite",
        "group": { "id": group.id, "name": group.name },
    })
}

/// 群清单（含 self 成员/未决邀请标记）。
/// `members` 与投递同口径（system 群 = 在册全体，见 [`group_targets`]）——
/// 曾按原始名单返回，系统群的名单永远是空数组，agent 查到的群员
/// 「只有我自己」，会误判同伴不在群里。
fn list(state: &ServiceState, sender: &str) -> Result<Value, String> {
    let file = groups::load_at(&state.groups_dir);
    let rows = registry_rows(&(state.registry_list)()?);
    Ok(Value::Array(list_json(&file, &rows, sender)))
}

/// 群清单 JSON（纯函数）：`members` = `members_of` 解析后的有效成员名单。
fn list_json(file: &GroupsFile, rows: &[InstanceRow], sender: &str) -> Vec<Value> {
    let all: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    file.groups
        .iter()
        .map(|g| {
            let invited = file
                .invites
                .iter()
                .any(|i| i.group_id == g.id && i.to == sender && i.status == "pending");
            json!({
                "id": g.id,
                "name": g.name,
                "system": g.system,
                "members": groups::members_of(g, &all),
                "member": g.system || g.members.iter().any(|m| m == sender),
                "invited": invited,
            })
        })
        .collect()
}

/// 群发言：目标 = 群成员 ∩ 在册实例 − 自己；逐个投递，单败不阻断。
/// `wake=true`（缺省，拍板 2026-09-27）`next-turn` 唤醒成员给发言机会；
/// `wake=false` `inject` 只入对方上下文不唤醒（对方下次开口才看到）。
/// 显示不依赖收方领取：fan-out 成功后在**发送方**会话落一条 `group/sent`
/// （record-only），收方副本共享 clientMsgId 由前端按 id 去重。
async fn say(state: &ServiceState, sender: &str, params: &Value) -> Result<Value, String> {
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

/// 群投递 fan-out 共享 id：时间戳 + 发起方 id。同一发起方一次只有一个 fan-out
/// 在途，毫秒内不会自我碰撞；跨发起方靠 sender 段区分。
pub(crate) fn client_msg_id(sender: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("gsay-{sender}-{now}")
}

/// 发送方落账（拍板 2026-09-27）：至少投递成功一人时，向发送方自己的 backend
/// POST `/api/group-sent`，在其会话 append record-only 的 `group/sent` 事件——
/// 群视图在发送时刻即显示本条，不等收方领取。落账失败只记日志（不影响发言结果）。
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
    if let Err(err) = super::peer::post_instance(state, row, "/api/group-sent", &body).await {
        log::warn!("[groups] 发送方落账失败（{sender}）：{err}");
    }
}

/// 建群（agent 自建群）：只把创建者入册；`members` 是邀请名单，逐一发邀请
/// （对方 accept 才入册——拍板：拉人可拒绝）。
async fn create(state: &ServiceState, sender: &str, params: &Value) -> Result<Value, String> {
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
async fn invite(state: &ServiceState, sender: &str, params: &Value) -> Result<Value, String> {
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
async fn respond(state: &ServiceState, sender: &str, params: &Value) -> Result<Value, String> {
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
fn find_group<'a>(file: &'a GroupsFile, key: &str) -> Result<&'a Group, String> {
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
pub(crate) fn group_targets(group: &Group, rows: &[InstanceRow], sender: &str) -> Vec<InstanceRow> {
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

/// 逐个投递（纯副作用），单败不阻断。
pub(crate) async fn fan_out(state: &ServiceState, targets: &[InstanceRow], body: &Value) -> Result<Value, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::groups::{create_group, ensure_general, GroupsFile};

    #[test]
    fn list_reports_effective_members_in_delivery_order() {
        let mut f = GroupsFile::default();
        ensure_general(&mut f);
        create_group(&mut f, "小圈", &["gamma".into()], "default", 1).unwrap();
        let rows = vec![
            InstanceRow { id: "default".into(), name: "小芊".into(), port: 1 },
            InstanceRow { id: "beta".into(), name: "小贝".into(), port: 2 },
        ];
        // 系统群 members = 在册全体（与 group::say 投递口径一致）；
        // 曾返回原始名单（空数组），agent 查群员只有自己、误判同伴不在群。
        let out = list_json(&f, &rows, "beta");
        assert_eq!(out[0]["id"], "general");
        assert_eq!(out[0]["members"], serde_json::json!(["default", "beta"]));
        assert_eq!(out[0]["member"], true, "system 群人人是在册成员");
        // 普通群 = 名单 ∩ 在册：创建者 default 在册，受邀的 gamma 未 accept 不在册；
        // sender=beta 不在名单 → member=false。
        assert_eq!(out[1]["members"], serde_json::json!(["default"]));
        assert_eq!(out[1]["member"], false);
    }

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

    #[test]
    fn group_body_carries_shared_client_msg_id() {
        let mut f = GroupsFile::default();
        ensure_general(&mut f);
        let g = groups::find(&f, groups::GENERAL_ID).unwrap().clone();
        let body = group_body("在吗", "小芊", "default", "next-turn", &g, "gsay-default-123");
        assert_eq!(body["clientMsgId"], "gsay-default-123", "收方副本与发送方落账共享 id，缺失会双份显示");
        assert_eq!(body["kind"], "group");
        assert_eq!(body["target"], "next-turn");
        assert_eq!(body["group"]["id"], "general");
    }

    #[test]
    fn client_msg_id_separates_senders() {
        let a = client_msg_id("default");
        let b = client_msg_id("beta");
        assert!(a.starts_with("gsay-default-"), "{a}");
        assert!(b.starts_with("gsay-beta-"), "{b}");
        assert_ne!(a, b, "跨发送方不得碰撞：同 id 的不同消息会被合并流误去重");
    }
}
