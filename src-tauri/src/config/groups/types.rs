//! 群组领域类型（P2-4）：群 = 壳层实体，邀请全程留痕。

use serde::{Deserialize, Serialize};

/// 配置文件名称（壳层 `app_config_dir` 下）。
pub const FILE_NAME: &str = "groups.json";
/// 系统群 id：全员群，成员动态跟随实例增删、不可删。
pub const GENERAL_ID: &str = "general";
/// 系统群显示名。
pub const GENERAL_NAME: &str = "全员群";
/// 群系统事件的合成发送方 id（入群/退群等）。
pub const SYSTEM_SENDER: &str = "system";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    /// 成员实例 id；`system` 群为空 = 动态跟随全部实例（全员）。
    #[serde(default)]
    pub members: Vec<String>,
    /// 创建时间（Unix 秒）。
    #[serde(default)]
    pub created_at: u64,
    /// 创建者实例 id（agent 自建群留痕；`user`/`system` 亦可）。
    #[serde(default)]
    pub created_by: String,
    /// 系统群（全员群）：不可删、成员动态。
    #[serde(default)]
    pub system: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub id: String,
    pub group_id: String,
    pub group_name: String,
    /// 邀请方实例 id。
    pub from: String,
    /// 被邀方实例 id。
    pub to: String,
    #[serde(default)]
    pub message: String,
    /// `pending` | `accepted` | `declined`——拒绝也留痕（拍板：显式拒绝 + 理由）。
    pub status: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupsFile {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub invites: Vec<Invite>,
}

fn default_schema_version() -> u32 {
    1
}

impl Default for GroupsFile {
    fn default() -> Self {
        Self {
            schema_version: default_schema_version(),
            groups: Vec::new(),
            invites: Vec::new(),
        }
    }
}

/// 系统全员群（members 空 = 动态全员）。
pub fn general_group() -> Group {
    Group {
        id: GENERAL_ID.to_string(),
        name: GENERAL_NAME.to_string(),
        members: Vec::new(),
        created_at: 0,
        created_by: "system".to_string(),
        system: true,
    }
}
