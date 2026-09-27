//! 群组清单 IPC（P2-4 一期）：侧栏多群行数据源。薄适配：取 app_config_dir → config::groups。

use serde::Serialize;
use tauri::Manager;

use crate::config::groups;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    pub id: String,
    pub name: String,
    pub system: bool,
    pub members: Vec<String>,
}

/// 群清单（含系统全员群）。
#[tauri::command]
pub fn list_groups(app: tauri::AppHandle) -> Vec<GroupView> {
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
        })
        .collect()
}
