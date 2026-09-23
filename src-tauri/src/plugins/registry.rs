//! profile 插件安装记录（`diver-plugins.json`）。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// `$COS_HOME/profiles/<p>/diver-plugins.json` 中的一条安装记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePluginRecord {
    pub id: String,
    pub package_name: String,
    pub spec: String,
    #[serde(default = "kind_profile")]
    pub kind: String,
    #[serde(default)]
    pub bundle: bool,
    #[serde(default)]
    pub insert_name: Option<String>,
}

fn kind_profile() -> String {
    "profile".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePluginsFile {
    #[serde(default = "schema_one")]
    pub schema_version: u32,
    #[serde(default)]
    pub installed: Vec<ProfilePluginRecord>,
}

fn schema_one() -> u32 {
    1
}

fn registry_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("diver-plugins.json")
}

pub fn read_registry(profile_dir: &Path) -> ProfilePluginsFile {
    let path = registry_path(profile_dir);
    let Ok(content) = fs::read_to_string(&path) else {
        return ProfilePluginsFile::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn write_registry(profile_dir: &Path, file: &ProfilePluginsFile) -> Result<(), String> {
    fs::create_dir_all(profile_dir).map_err(|e| format!("PROFILE_DIR: {e}"))?;
    let path = registry_path(profile_dir);
    let json = serde_json::to_string_pretty(file).map_err(|e| format!("REGISTRY_SERDE: {e}"))?;
    fs::write(&path, json + "\n").map_err(|e| format!("REGISTRY_WRITE: {e}"))
}

/// Snapshot helper for list_plugins merge.
pub fn installed_ids(profile_dir: &Path) -> BTreeMap<String, ProfilePluginRecord> {
    read_registry(profile_dir)
        .installed
        .into_iter()
        .map(|p| (p.id.clone(), p))
        .collect()
}
