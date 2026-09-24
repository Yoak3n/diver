//! 当前 cos profile（插件组合档案）持久化。
//!
//! 状态文件：`$COS_HOME/active-profile.json`（与 backend 共读，通道收敛）。
//! 兼容：若 COS_HOME 尚无该文件、壳层旧 `diver-profile.json` 仍有值，则迁移写入。
//!
//! - `companion`：完整陪伴组合
//! - `safe`：核心 + 仅 `@diver/backend` 传输

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{config_dir, cos_home, save_at};

pub const LEGACY_FILE_NAME: &str = "diver-profile.json";
pub const ACTIVE_PROFILE_FILE: &str = "active-profile.json";

/// 完整陪伴档案。
pub const COMPANION: &str = "companion";
/// 安全档案。
pub const SAFE: &str = "safe";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileConfig {
    pub active_profile: String,
}

impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            active_profile: COMPANION.to_string(),
        }
    }
}

fn valid(name: &str) -> bool {
    name == COMPANION || name == SAFE
}

/// 读取文件中的合法 profile 名；文件缺失 / 解析失败 / 非法名返回 None。
fn read_valid_profile(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let cfg: ProfileConfig = serde_json::from_str(&raw).ok()?;
    let name = cfg.active_profile.trim().to_string();
    valid(&name).then_some(name)
}

/// 纯路径读取：当前激活的 profile 名（优先 `$COS_HOME/active-profile.json`）。
///
/// `cos_home`：数据家园目录；`shell_config_dir`：壳层配置目录（旧文件迁移来源）。
pub fn active_profile_at(cos_home: &Path, shell_config_dir: &Path) -> String {
    if let Some(name) = read_valid_profile(&cos_home.join(ACTIVE_PROFILE_FILE)) {
        return name;
    }
    // 迁移：壳层旧配置（仅当目标无有效值时）
    if let Some(name) = read_valid_profile(&shell_config_dir.join(LEGACY_FILE_NAME)) {
        let _ = save_at(
            cos_home,
            ACTIVE_PROFILE_FILE,
            &ProfileConfig {
                active_profile: name.clone(),
            },
        );
        return name;
    }
    COMPANION.to_string()
}

/// 纯路径写入：切换激活 profile（写 COS_HOME；backend 与壳共用）。
pub fn set_active_profile_at(cos_home: &Path, name: &str) -> bool {
    let name = name.trim();
    if !valid(name) {
        log::warn!("profile: 拒绝未知档案名 {name:?}（仅支持 {COMPANION} / {SAFE}）");
        return false;
    }
    save_at(
        cos_home,
        ACTIVE_PROFILE_FILE,
        &ProfileConfig {
            active_profile: name.to_string(),
        },
    )
}

/// 当前激活的 profile 名（优先 `$COS_HOME/active-profile.json`）。
pub fn active_profile(app: &AppHandle) -> String {
    active_profile_at(&cos_home(app), &config_dir(app))
}

pub fn is_safe(app: &AppHandle) -> bool {
    active_profile(app) == SAFE
}

/// 切换激活 profile（写 COS_HOME；backend 与壳共用）。
pub fn set_active_profile(app: &AppHandle, name: &str) -> bool {
    set_active_profile_at(&cos_home(app), name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("diver-prof-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn set_and_active_roundtrip() {
        let home = tmp("rt");
        assert!(set_active_profile_at(&home, SAFE));
        assert_eq!(active_profile_at(&home, &home), SAFE);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn migrates_legacy_shell_config() {
        let home = tmp("mig-home");
        let shell = tmp("mig-shell");
        assert!(save_at(
            &shell,
            LEGACY_FILE_NAME,
            &ProfileConfig {
                active_profile: SAFE.into(),
            }
        ));
        assert_eq!(active_profile_at(&home, &shell), SAFE);
        assert!(home.join(ACTIVE_PROFILE_FILE).is_file());
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&shell);
    }

    #[test]
    fn rejects_unknown_profile_name() {
        let home = tmp("bad");
        assert!(!set_active_profile_at(&home, "nope"));
        assert_eq!(active_profile_at(&home, &home), COMPANION);
        let _ = std::fs::remove_dir_all(&home);
    }
}
