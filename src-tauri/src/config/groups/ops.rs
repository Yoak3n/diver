//! 群组纯状态迁移：建群、邀请、应答、成员解析（无 IO，可单测）。

use super::types::{general_group, Group, GroupsFile, Invite, GENERAL_ID};

/// 确保系统全员群在位（幂等）。
pub fn ensure_general(file: &mut GroupsFile) -> bool {
    if file.groups.iter().any(|g| g.id == GENERAL_ID) {
        return false;
    }
    file.groups.insert(0, general_group());
    true
}

/// 按 id 或名解析群。
pub fn find<'a>(file: &'a GroupsFile, key: &str) -> Option<&'a Group> {
    let key = key.trim();
    file.groups
        .iter()
        .find(|g| g.id == key || g.name == key)
}

/// 成员解析：system 群 = 全部实例 id；普通群 = 名单 ∩ 在册 id。
pub fn members_of(group: &Group, all_ids: &[String]) -> Vec<String> {
    if group.system {
        return all_ids.to_vec();
    }
    group
        .members
        .iter()
        .filter(|m| all_ids.iter().any(|a| a == *m))
        .cloned()
        .collect()
}

/// 建群（agent 自建群入口）：**只把创建者入册**；`members` 是邀请名单——
/// 对方 accept 后才入册（拍板：拉人可拒绝，不自动入册）。
/// id 递增分配 `group-N`。
pub fn create_group(
    file: &mut GroupsFile,
    name: &str,
    _members: &[String],
    creator: &str,
    now: u64,
) -> Result<Group, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("群名不能为空".to_string());
    }
    if file.groups.iter().any(|g| g.name == name) {
        return Err(format!("群「{name}」已存在"));
    }
    let n = file.groups.len() + 1;
    let mut id = format!("group-{n}");
    let mut i = n;
    while file.groups.iter().any(|g| g.id == id) {
        i += 1;
        id = format!("group-{i}");
    }
    let mut member_list: Vec<String> = Vec::new();
    for m in [creator.to_string()].iter() {
        let m = m.trim();
        if !m.is_empty() && !member_list.iter().any(|x| x == m) {
            member_list.push(m.to_string());
        }
    }
    let group = Group {
        id,
        name: name.to_string(),
        members: member_list,
        created_at: now,
        created_by: creator.to_string(),
        system: false,
    };
    file.groups.push(group.clone());
    Ok(group)
}

/// 登记邀请（留痕）；同群同目标的未决邀请去重。
pub fn add_invite(
    file: &mut GroupsFile,
    group: &Group,
    from: &str,
    to: &str,
    message: &str,
    now: u64,
) -> Result<Invite, String> {
    if file
        .invites
        .iter()
        .any(|i| i.group_id == group.id && i.to == to && i.status == "pending")
    {
        return Err(format!("已有一条发给「{to}」的未决邀请"));
    }
    let n = file.invites.len() + 1;
    let invite = Invite {
        id: format!("invite-{n}"),
        group_id: group.id.clone(),
        group_name: group.name.clone(),
        from: from.to_string(),
        to: to.to_string(),
        message: message.trim().to_string(),
        status: "pending".to_string(),
        reason: String::new(),
        at: now,
    };
    file.invites.push(invite.clone());
    Ok(invite)
}

/// 应答邀请：接受 → 入群（幂等）；拒绝 → 记理由（拍板：显式拒绝 + 理由）。
pub fn apply_response(
    file: &mut GroupsFile,
    invite_id: &str,
    accept: bool,
    reason: &str,
    now: u64,
) -> Result<Invite, String> {
    let idx = file
        .invites
        .iter()
        .position(|i| i.id == invite_id)
        .ok_or_else(|| format!("未找到邀请「{invite_id}」"))?;
    if file.invites[idx].status != "pending" {
        return Err(format!("邀请「{invite_id}」已处理过（{}）", file.invites[idx].status));
    }
    let to = file.invites[idx].to.clone();
    let gid = file.invites[idx].group_id.clone();
    file.invites[idx].status = if accept { "accepted" } else { "declined" }.to_string();
    file.invites[idx].reason = reason.trim().to_string();
    file.invites[idx].at = now;
    if accept {
        if let Some(g) = file.groups.iter_mut().find(|g| g.id == gid) {
            if !g.system && !g.members.iter().any(|m| m == &to) {
                g.members.push(to);
            }
        }
    }
    Ok(file.invites[idx].clone())
}

/// 群改名（用户面板 / 二期）：系统群不可改（「全员群」名是身份一部分）；
/// 新名去空、非空、不与其它群重名。历史邀请的 `group_name` 快照不改（留痕语义）。
pub fn rename_group(file: &mut GroupsFile, key: &str, new_name: &str) -> Result<Group, String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("群名不能为空".to_string());
    }
    let group = find(file, key).ok_or_else(|| format!("未知群「{key}」"))?;
    if group.system {
        return Err("系统全员群不可改名".to_string());
    }
    if group.name == new_name {
        return Ok(group.clone());
    }
    if file.groups.iter().any(|g| g.name == new_name) {
        return Err(format!("群「{new_name}」已存在"));
    }
    let id = group.id.clone();
    let g = file.groups.iter_mut().find(|g| g.id == id).expect("id 已解析");
    g.name = new_name.to_string();
    Ok(g.clone())
}

/// 移出成员（用户面板 / 二期，拍板「用户事后可撤人」）：系统群成员动态跟随
/// 实例增删、不可移；目标必须在册。
pub fn remove_member(file: &mut GroupsFile, key: &str, member: &str) -> Result<Group, String> {
    let member = member.trim();
    if member.is_empty() {
        return Err("成员 id 必填".to_string());
    }
    let group = find(file, key).ok_or_else(|| format!("未知群「{key}」"))?;
    if group.system {
        return Err("系统全员群成员跟随实例增删，不能移出".to_string());
    }
    if !group.members.iter().any(|m| m == member) {
        return Err(format!("「{member}」不在群「{}」里", group.name));
    }
    let id = group.id.clone();
    let g = file.groups.iter_mut().find(|g| g.id == id).expect("id 已解析");
    g.members.retain(|m| m != member);
    Ok(g.clone())
}

/// 解散群（用户面板 / 二期；用户侧「退群」的唯一形态——用户不是成员）：
/// 系统群不可解散；邀请记录保留（留痕）。
pub fn delete_group(file: &mut GroupsFile, key: &str) -> Result<Group, String> {
    let idx = file
        .groups
        .iter()
        .position(|g| g.id == key.trim() || g.name == key.trim())
        .ok_or_else(|| format!("未知群「{key}」"))?;
    if file.groups[idx].system {
        return Err("系统全员群不可解散".to_string());
    }
    Ok(file.groups.remove(idx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::groups::types::GroupsFile;

    #[test]
    fn ensure_general_idempotent() {
        let mut f = GroupsFile::default();
        assert!(ensure_general(&mut f));
        assert!(!ensure_general(&mut f));
        assert_eq!(f.groups.len(), 1);
        assert!(f.groups[0].system);
    }

    #[test]
    fn find_by_id_or_name() {
        let mut f = GroupsFile::default();
        let g = create_group(&mut f, "工作台", &[], "default", 1).unwrap();
        assert_eq!(find(&f, &g.id).unwrap().name, "工作台");
        assert_eq!(find(&f, "工作台").unwrap().id, g.id);
        assert!(find(&f, "无此群").is_none());
    }

    #[test]
    fn members_of_filters_registry() {
        let mut f = GroupsFile::default();
        ensure_general(&mut f);
        let all = vec!["default".to_string(), "beta".to_string()];
        // system 群 = 全部实例
        let general = find(&f, GENERAL_ID).unwrap();
        assert_eq!(members_of(general, &all), all);
        // 普通群 = 名单 ∩ 在册（创建后只有创建者；受邀者 accept 后才入册）
        let g = create_group(&mut f, "小圈", &["beta".into(), "gone".into()], "default", 1).unwrap();
        assert_eq!(members_of(&g, &all), vec!["default".to_string()]);
    }

    #[test]
    fn create_group_creator_only_and_names_dedupe() {
        let mut f = GroupsFile::default();
        let g = create_group(&mut f, "开黑", &["beta".into(), "beta".into()], "default", 5).unwrap();
        assert_eq!(g.members, vec!["default".to_string()], "成员仅创建者；members 只作邀请名单");
        assert!(create_group(&mut f, "开黑", &[], "beta", 6).is_err());
        assert!(create_group(&mut f, "  ", &[], "beta", 6).is_err());
    }

    #[test]
    fn invite_accept_joins_and_decline_records_reason() {
        let mut f = GroupsFile::default();
        let g = create_group(&mut f, "开黑", &[], "default", 1).unwrap();
        let inv = add_invite(&mut f, &g, "default", "beta", "来玩", 2).unwrap();
        // 未决去重
        assert!(add_invite(&mut f, &g, "default", "beta", "再来", 3).is_err());
        let done = apply_response(&mut f, &inv.id, true, "", 4).unwrap();
        assert_eq!(done.status, "accepted");
        assert!(find(&f, &g.id).unwrap().members.contains(&"beta".to_string()));
        // 不可重复应答
        assert!(apply_response(&mut f, &inv.id, false, "", 5).is_err());
        // 拒绝留痕 + 不入册
        let inv2 = add_invite(&mut f, &g, "default", "gamma", "来玩", 6).unwrap();
        let done2 = apply_response(&mut f, &inv2.id, false, "在忙", 7).unwrap();
        assert_eq!(done2.status, "declined");
        assert_eq!(done2.reason, "在忙");
        assert!(!find(&f, &g.id).unwrap().members.contains(&"gamma".to_string()));
    }

    #[test]
    fn rename_group_guards_and_applies() {
        let mut f = GroupsFile::default();
        ensure_general(&mut f);
        let g = create_group(&mut f, "工作台", &[], "default", 1).unwrap();
        // 系统群 / 空名 / 重名 / 未知群全拒
        assert!(rename_group(&mut f, GENERAL_ID, "大群").is_err());
        assert!(rename_group(&mut f, &g.id, "  ").is_err());
        assert!(create_group(&mut f, "小圈", &[], "beta", 2).is_ok());
        assert!(rename_group(&mut f, &g.id, "小圈").is_err());
        assert!(rename_group(&mut f, "无此群", "随便").is_err());
        // 正常改名；同名幂等；按旧名也能找到直到改名后
        assert_eq!(rename_group(&mut f, "工作台", "作战室").unwrap().name, "作战室");
        assert_eq!(find(&f, &g.id).unwrap().name, "作战室");
        assert_eq!(rename_group(&mut f, &g.id, "作战室").unwrap().name, "作战室");
        assert!(find(&f, "工作台").is_none(), "旧名不再命中");
    }

    #[test]
    fn remove_member_guards_and_applies() {
        let mut f = GroupsFile::default();
        ensure_general(&mut f);
        let g = create_group(&mut f, "工作台", &[], "default", 1).unwrap();
        // 正常移出；重复移出报不在群
        let inv = add_invite(&mut f, &g, "default", "beta", "", 2).unwrap();
        apply_response(&mut f, &inv.id, true, "", 3).unwrap();
        // 系统群 / 非成员 / 空参全拒
        assert!(remove_member(&mut f, GENERAL_ID, "default").is_err());
        assert!(remove_member(&mut f, &g.id, "gamma").is_err());
        assert!(remove_member(&mut f, &g.id, " ").is_err());
        assert!(remove_member(&mut f, "无此群", "beta").is_err());
        // 正常移出；重复移出报不在群
        let after = remove_member(&mut f, &g.id, "beta").unwrap();
        assert_eq!(after.members, vec!["default".to_string()]);
        assert!(remove_member(&mut f, &g.id, "beta").is_err());
    }

    #[test]
    fn delete_group_keeps_invites_and_guards_system() {
        let mut f = GroupsFile::default();
        ensure_general(&mut f);
        let g = create_group(&mut f, "临时", &[], "default", 1).unwrap();
        add_invite(&mut f, &g, "default", "beta", "来", 2).unwrap();
        assert!(delete_group(&mut f, GENERAL_ID).is_err(), "系统群不可解散");
        let removed = delete_group(&mut f, "临时").unwrap();
        assert_eq!(removed.id, g.id);
        assert!(find(&f, "临时").is_none());
        // 邀请记录保留（留痕），且指向已不存在的群 id
        assert_eq!(f.invites.len(), 1);
        assert_eq!(f.invites[0].group_id, g.id);
        assert!(delete_group(&mut f, "临时").is_err());
    }
}
