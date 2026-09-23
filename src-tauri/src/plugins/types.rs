//! 插件目录类型与 profile 名常量。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// companion profile 名（完整陪伴组合）。
pub const COMPANION_PROFILE: &str = "companion";
/// 安全档案：核心 + backend 最小传输（故障恢复）。
pub const SAFE_PROFILE: &str = "safe";

/// 展示元数据目录（随 bundle 分发，壳只读）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PluginCatalogFile {
    #[serde(default)]
    pub plugins: Vec<PluginCatalogEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PluginCatalogEntry {
    pub id: String,
    #[serde(default)]
    pub package_name: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_true")]
    pub toggleable: bool,
    #[serde(default = "default_true")]
    pub default_enabled: bool,
    #[serde(default)]
    pub advisory: Option<String>,
}

fn default_true() -> bool {
    true
}

/// 前端看到的插件行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub package_name: String,
    pub display_name: String,
    pub description: String,
    /// internal = 随安装包/仓库提供；profile = 未来用户安装。
    pub kind: String,
    pub enabled: bool,
    pub toggleable: bool,
    pub source: String,
    pub present: bool,
    pub advisory: Option<String>,
}

/// 解析后的布局：bundle / plugins / profile。
#[derive(Debug, Clone)]
pub struct PluginPaths {
    pub bundle_dir: PathBuf,
    pub plugins_root: PathBuf,
    pub profile_dir: PathBuf,
}

/// 启动预检报告。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    pub ok: bool,
    pub profile: String,
    pub safe_mode: bool,
    pub problems: Vec<String>,
    pub quarantined: Option<String>,
    pub bundle_dir: String,
    pub plugins_root: String,
    pub profile_dir: String,
    pub harness_dir: String,
}
