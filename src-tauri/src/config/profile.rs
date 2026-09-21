//! 当前 cos profile（插件组合档案）持久化。
//!
//! 状态文件：`$COS_HOME/active-profile.json`（与 backend 共读，通道收敛）。
//! 兼容：若 COS_HOME 尚无该文件、壳层旧 `diver-profile.json` 仍有值，则迁移写入。
//!
//! - `companion`：完整陪伴组合
//! - `safe`：核心 + 仅 `@diver/backend` 传输

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{load, load_at, save_at, cos_home};

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

/// 当前激活的 profile 名（优先 `$COS_HOME/active-profile.json`）。
pub fn active_profile(app: &AppHandle) -> String {
    let home = cos_home(app);
    let cfg: ProfileConfig = load_at(&home, ACTIVE_PROFILE_FILE);
    if valid(cfg.active_profile.trim()) {
        return cfg.active_profile;
    }
    // 迁移：壳层旧配置
    let legacy: ProfileConfig = load(app, LEGACY_FILE_NAME);
    if valid(legacy.active_profile.trim()) {
        let _ = save_at(
            &home,
            ACTIVE_PROFILE_FILE,
            &ProfileConfig {
                active_profile: legacy.active_profile,
            },
        );
        return load_at::<ProfileConfig>(&home, ACTIVE_PROFILE_FILE).active_profile;
    }
    COMPANION.to_string()
}

pub fn is_safe(app: &AppHandle) -> bool {
    active_profile(app) == SAFE
}

/// 切换激活 profile（写 COS_HOME；backend 与壳共用）。
pub fn set_active_profile(app: &AppHandle, name: &str) -> bool {
    let name = name.trim();
    if !valid(name) {
        log::warn!("profile: 拒绝未知档案名 {name:?}（仅支持 {COMPANION} / {SAFE}）");
        return false;
    }
    let home = cos_home(app);
    save_at(
        &home,
        ACTIVE_PROFILE_FILE,
        &ProfileConfig {
            active_profile: name.to_string(),
        },
    )
}
