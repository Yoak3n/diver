//! 群清单（`group::list`）。

use serde_json::{json, Value};

use crate::config::groups::{self, GroupsFile};
use crate::services::peer::{registry_rows, InstanceRow};
use crate::services::ServiceState;

/// 群清单（含 self 成员/未决邀请标记）。
/// `members` 与投递同口径（system 群 = 在册全体，见 [`super::ops::group_targets`]）——
/// 曾按原始名单返回，系统群的名单永远是空数组，agent 查到的群员
/// 「只有我自己」，会误判同伴不在群里。
pub(super) fn list(state: &ServiceState, sender: &str) -> Result<Value, String> {
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
}
