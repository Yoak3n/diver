//! P4：profile 插件卸载。

use std::fs;

use tauri::AppHandle;

use super::install::is_internal;
use super::package::{
    backup_pair, profile_manifest_path, restore_pair, run_pnpm, update_profile_bundles,
};
use super::registry::{read_registry, write_registry};
use super::{active_profile, plugin_paths_for, PluginInfo, SAFE_PROFILE};

/// Uninstall a profile plugin. Internal plugins are rejected.
pub fn uninstall_profile_plugin(
    app: &AppHandle,
    id: &str,
    restart: bool,
) -> Result<Vec<PluginInfo>, String> {
    let profile = active_profile(app);
    if profile == SAFE_PROFILE {
        return Err("safe 模式不可卸载插件，请先切回 companion".into());
    }
    let paths = plugin_paths_for(app, &profile);
    let profile_dir = paths.profile_dir.clone();
    let mut registry = read_registry(&profile_dir);
    let idx = registry
        .installed
        .iter()
        .position(|p| p.id == id || p.package_name == id)
        .ok_or_else(|| {
            if is_internal(app, id, id) || is_internal(app, id, &format!("@diver/{id}")) {
                format!("{id} 是 internal 插件，不可卸载（可在列表中禁用）")
            } else {
                format!("未找到 profile 插件记录: {id}")
            }
        })?;

    let entry = registry.installed[idx].clone();
    if is_internal(app, &entry.id, &entry.package_name) {
        return Err(format!(
            "{} 是 internal 插件，不可卸载（可在列表中禁用）",
            entry.package_name
        ));
    }

    let backups = backup_pair(&profile_dir);
    if entry.bundle {
        if let Err(e) = update_profile_bundles(&profile_dir, &entry.package_name, false) {
            return Err(e);
        }
    }

    let pnpm_log = match run_pnpm(&profile_dir, &["remove", &entry.package_name]) {
        Ok(log) => log,
        Err(e) => {
            restore_pair(&profile_dir, backups.0, backups.1);
            return Err(e);
        }
    };
    for line in pnpm_log.lines().filter(|l| !l.trim().is_empty()).take(20) {
        log::info!("[pnpm] {line}");
    }

    // Verify removal from profile manifest dependencies.
    let manifest = profile_manifest_path(&profile_dir);
    if let Ok(content) = fs::read_to_string(&manifest) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            let still = json
                .get("dependencies")
                .and_then(|d| d.get(&entry.package_name))
                .is_some();
            if still {
                log::warn!(
                    "plugins: pnpm remove 后 dependencies 仍含 {}，请检查 profile",
                    entry.package_name
                );
            }
        }
    }

    registry.installed.remove(idx);
    write_registry(&profile_dir, &registry)?;
    log::info!(
        "plugins: uninstalled {} (id={}) from {profile_dir:?}",
        entry.package_name,
        entry.id
    );

    if restart {
        let _ = crate::core::sidecar::SidecarManager::global().restart(app);
    }
    Ok(super::list_profile_aware(app))
}
