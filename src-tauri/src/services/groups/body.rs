//! 群请求体构造与 fan-out 共享 id（纯函数）。

use serde_json::{json, Value};

use crate::config::groups::Group;

/// 群消息请求体：`group` 供收方盖 `【群聊「组名」｜…】` 章并挂归属标；
/// `clientMsgId` = 整次 fan-out 共享 id，各收方副本与发送方落账同 id（UI 按 id 去重）。
pub fn group_body(
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
pub(super) fn invite_body(message: &str, sender_name: &str, sender: &str, group: &Group) -> Value {
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

/// 群投递 fan-out 共享 id：时间戳 + 发起方 id。同一发起方一次只有一个 fan-out
/// 在途，毫秒内不会自我碰撞；跨发起方靠 sender 段区分。
pub fn client_msg_id(sender: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("gsay-{sender}-{now}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::groups::{self, ensure_general, GroupsFile};

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
