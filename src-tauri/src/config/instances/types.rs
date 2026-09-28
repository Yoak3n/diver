//! 实例清单领域类型：元数据条目、清单文件、错误。

use serde::{Deserialize, Serialize};

/// 配置文件名称（壳层 `config_dir` 下）。
pub const FILE_NAME: &str = "instances.json";
/// 保留给零迁移实例的 id，不可删。
pub const DEFAULT_ID: &str = "default";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceMeta {
    /// 不可变实例 id，路径安全字符集 `[a-z0-9-]`。
    pub id: String,
    /// 展示名称，**创建时可不命名**（`None` = 未命名）——
    /// 名字通常由用户与其聊天后经人格卡片回填，创建时直接命名只是可选捷径。
    #[serde(default)]
    pub name: Option<String>,
    /// 是否随应用启动（P1 起生效，P0 只存储）。
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 头像留位（P0 无编辑入口）。
    #[serde(default)]
    pub avatar: Option<String>,
    /// 每实例桌宠模型 id（P2-5 多桌宠；`None` = 跟随全局模型选择）。
    #[serde(default)]
    pub pet_model: Option<String>,
    /// 该实例回复是否自动朗读（自动朗读 = 全局 TTS 总开关 AND 本开关；群聊不朗读）。
    #[serde(default = "default_true")]
    pub auto_read: bool,
    /// 登记时间（Unix 秒）。
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstancesFile {
    /// schema 版本，留迁移口。
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub instances: Vec<InstanceMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstanceError {
    /// 实例不存在。
    NotFound,
    /// `default` 实例受保护（不可删）。
    ProtectedDefault,
    /// 名称为空或超长。
    InvalidName,
    /// 落盘失败。
    Io,
}

impl std::fmt::Display for InstanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "实例不存在"),
            Self::ProtectedDefault => write!(f, "默认实例不可删除"),
            Self::InvalidName => write!(f, "名称需为 1–32 个字符"),
            Self::Io => write!(f, "实例清单写盘失败"),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_schema_version() -> u32 {
    1
}

impl Default for InstancesFile {
    fn default() -> Self {
        Self {
            schema_version: default_schema_version(),
            instances: Vec::new(),
        }
    }
}
