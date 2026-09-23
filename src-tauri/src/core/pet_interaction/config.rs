//! 桌宠互动配置：`$COS_HOME/diver-settings.json` 的 `petInteraction` 段。
//!
//! 路径由调用方注入（app 层用 `config::cos_home`），本模块不摸 app/shell。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{InteractionMode, PetInteractionConfig};

fn num_or(v: &Value, fallback: u64, min: u64) -> u64 {
    v.as_u64()
        .filter(|n| *n >= min)
        .unwrap_or(fallback)
}

fn diver_settings_path(cos_home: &Path) -> PathBuf {
    cos_home.join("diver-settings.json")
}

/// 从 `$COS_HOME/diver-settings.json` 读 `petInteraction`（与 backend 同文件）。
pub fn load_config(cos_home: &Path) -> PetInteractionConfig {
    let path = diver_settings_path(cos_home);
    let mut cfg = PetInteractionConfig::default();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return cfg;
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return cfg;
    };
    let Some(src) = v.get("petInteraction") else {
        return cfg;
    };
    if let Some(m) = src.get("mode").and_then(|x| x.as_str()) {
        cfg.mode = match m {
            "off" => InteractionMode::Off,
            "context" => InteractionMode::Context,
            _ => InteractionMode::Events,
        };
    }
    cfg.quiet_ms = num_or(src.get("quietMs").unwrap_or(&Value::Null), cfg.quiet_ms, 100);
    cfg.cooldown_ms = num_or(
        src.get("cooldownMs").unwrap_or(&Value::Null),
        cfg.cooldown_ms,
        100,
    );
    cfg.max_triggers = num_or(
        src.get("maxTriggers").unwrap_or(&Value::Null),
        cfg.max_triggers as u64,
        1,
    ) as u32;
    cfg.long_hold_ms = num_or(
        src.get("longHoldMs").unwrap_or(&Value::Null),
        cfg.long_hold_ms,
        500,
    );
    cfg
}

/// 写回 diver-settings.petInteraction（与 backend 设置页共用文件）。
pub fn save_config(cos_home: &Path, cfg: &PetInteractionConfig) -> std::io::Result<()> {
    let path = diver_settings_path(cos_home);
    let mut root: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    root["petInteraction"] = serde_json::to_value(cfg).unwrap_or_default();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_save_roundtrip() {
        let dir = std::env::temp_dir().join(format!("diver-pet-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut cfg = PetInteractionConfig::default();
        cfg.mode = InteractionMode::Context;
        cfg.quiet_ms = 5_000;
        save_config(&dir, &cfg).unwrap();
        let loaded = load_config(&dir);
        assert_eq!(loaded.mode, InteractionMode::Context);
        assert_eq!(loaded.quiet_ms, 5_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_missing_returns_default() {
        let dir = std::env::temp_dir().join(format!("diver-pet-cfg-miss-{}", std::process::id()));
        let cfg = load_config(&dir);
        assert_eq!(cfg.mode, InteractionMode::Events);
    }
}
