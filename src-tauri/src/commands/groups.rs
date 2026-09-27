//! 群组 IPC（P2-4 一期清单 + 二期管理面板）：薄适配，取 app_config_dir → config::groups；
//! 改名/移出/解散经 services 群务（同一投递面发群系统事件），本层零业务分支。

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::config::groups;
use crate::services::ServiceState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    pub id: String,
    pub name: String,
    pub system: bool,
    pub members: Vec<String>,
    pub created_at: u64,
    pub created_by: String,
}

/// 邀请记录行（二期面板留痕展示；status: pending|accepted|declined）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteView {
    pub id: String,
    pub group_id: String,
    pub group_name: String,
    pub from: String,
    pub to: String,
    pub message: String,
    pub status: String,
    pub reason: String,
    pub at: u64,
}

/// 管理操作结果：群系统事件送达/失败明细（失败不回滚，面板提示即可）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManageOutcome {
    pub delivered: Vec<String>,
    pub failed: Vec<FailedNotice>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedNotice {
    pub to: String,
    pub error: String,
}

/// 群清单（含系统全员群）。
#[tauri::command]
pub fn list_groups(app: AppHandle) -> Vec<GroupView> {
    let Ok(base) = app.path().app_data_dir() else {
        return Vec::new();
    };
    groups::load_at(&base)
        .groups
        .into_iter()
        .map(|g| GroupView {
            id: g.id,
            name: g.name,
            system: g.system,
            members: g.members,
            created_at: g.created_at,
            created_by: g.created_by,
        })
        .collect()
}

/// 指定群的邀请记录（按时间正序；群不存在返回空——已解散群的留痕仍可查）。
#[tauri::command]
pub fn list_group_invites(app: AppHandle, group_id: String) -> Vec<InviteView> {
    let Ok(base) = app.path().app_data_dir() else {
        return Vec::new();
    };
    let file = groups::load_at(&base);
    file.invites
        .iter()
        .filter(|i| i.group_id == group_id)
        .map(|i| InviteView {
            id: i.id.clone(),
            group_id: i.group_id.clone(),
            group_name: i.group_name.clone(),
            from: i.from.clone(),
            to: i.to.clone(),
            message: i.message.clone(),
            status: i.status.clone(),
            reason: i.reason.clone(),
            at: i.at,
        })
        .collect()
}

fn outcome_of(v: serde_json::Value) -> ManageOutcome {
    let empty = Vec::new();
    let delivered = v
        .get("delivered")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect();
    let failed = v
        .get("failed")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .filter_map(|x| {
            Some(FailedNotice {
                to: x.get("to")?.as_str()?.to_string(),
                error: x.get("error")?.as_str().unwrap_or("未知错误").to_string(),
            })
        })
        .collect();
    ManageOutcome { delivered, failed }
}

/// 群改名（系统群拒绝在 services 纯迁移层；此处只适配）。
#[tauri::command]
pub async fn rename_group(
    state: State<'_, ServiceState>,
    group_id: String,
    name: String,
) -> Result<ManageOutcome, String> {
    let v = crate::services::user_rename_group(&state, &group_id, &name).await?;
    Ok(outcome_of(v))
}

/// 移出成员（拍板「用户事后可撤人」）。
#[tauri::command]
pub async fn remove_group_member(
    state: State<'_, ServiceState>,
    group_id: String,
    member_id: String,
) -> Result<ManageOutcome, String> {
    let v = crate::services::user_remove_group_member(&state, &group_id, &member_id).await?;
    Ok(outcome_of(v))
}

/// 解散群（系统群拒绝；邀请记录保留）。
#[tauri::command]
pub async fn delete_group(state: State<'_, ServiceState>, group_id: String) -> Result<ManageOutcome, String> {
    let v = crate::services::user_delete_group(&state, &group_id).await?;
    Ok(outcome_of(v))
}
