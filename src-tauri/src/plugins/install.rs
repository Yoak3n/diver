//! P4：profile 插件安装（对齐 DSH plugin-manager 不变量）。
//!
//! - 状态在磁盘：`diver-plugins.json` + profile `package.json`（依赖 / dsh.profile.bundles）
//! - 禁用 ≠ 卸载：disable 只写 profile patch；uninstall 才动依赖
//! - internal（cos-plugins / plugins 目录、catalog `@diver/*`）**不可卸载**
//! - 安装失败回滚 `package.json` + `pnpm-lock.yaml`

use tauri::AppHandle;

use super::package::{
    backup_pair, insert_id_from_package, node_modules_pkg_dir, package_declares_bundle,
    package_name_from_spec, restore_pair, run_pnpm, update_profile_bundles,
};
use super::registry::{read_registry, write_registry, ProfilePluginRecord};
use super::{
    active_profile, catalog_for, package_present, plugin_paths_for, PluginInfo, SAFE_PROFILE,
};

/// Whether an id/package is an internal (shipped) plugin — uninstall rejected.
pub fn is_internal(app: &AppHandle, id: &str, package_name: &str) -> bool {
    let paths = plugin_paths_for(app, &active_profile(app));
    let catalog = catalog_for(&paths.bundle_dir);
    if catalog.contains_key(id) {
        return true;
    }
    if package_name.starts_with("@diver/") {
        return true;
    }
    // Present under the open plugins root with matching package name → internal source.
    if package_present(&paths.plugins_root, package_name) {
        return true;
    }
    let slash = package_name.rfind('/').map(|i| i + 1).unwrap_or(0);
    let pkg = &package_name[slash..];
    paths.plugins_root.join(pkg).join("package.json").exists()
}

/// Install a plugin into the active profile via pnpm.
pub fn install_profile_plugin(
    app: &AppHandle,
    spec: &str,
    restart: bool,
) -> Result<Vec<PluginInfo>, String> {
    let profile = active_profile(app);
    if profile == SAFE_PROFILE {
        return Err("safe 模式不可安装插件，请先切回 companion".into());
    }
    super::ensure_profile(app);
    let paths = plugin_paths_for(app, &profile);
    let profile_dir = paths.profile_dir.clone();

    let package_name = package_name_from_spec(spec, &profile_dir)?;
    if is_internal(app, &insert_id_from_package(&package_name), &package_name) {
        return Err(format!(
            "{package_name} 已是 internal/随包插件，请直接在列表中启用，无需安装"
        ));
    }

    let mut registry = read_registry(&profile_dir);
    if registry
        .installed
        .iter()
        .any(|p| p.package_name == package_name || p.id == insert_id_from_package(&package_name))
    {
        return Err(format!("{package_name} 已在 profile 安装记录中"));
    }

    let backups = backup_pair(&profile_dir);
    let pnpm_log = match run_pnpm(&profile_dir, &["add", spec]) {
        Ok(log) => log,
        Err(e) => {
            restore_pair(&profile_dir, backups.0, backups.1);
            return Err(e);
        }
    };
    for line in pnpm_log.lines().filter(|l| !l.trim().is_empty()).take(30) {
        log::info!("[pnpm] {line}");
    }

    let pkg_dir = node_modules_pkg_dir(&profile_dir, &package_name);
    if !pkg_dir.join("package.json").exists() {
        restore_pair(&profile_dir, backups.0, backups.1);
        return Err(format!(
            "pnpm 成功但未找到包体 {}，已回滚 manifest/lock",
            pkg_dir.display()
        ));
    }

    let bundle = package_declares_bundle(&profile_dir, &package_name);
    let id = insert_id_from_package(&package_name);
    if bundle {
        if let Err(e) = update_profile_bundles(&profile_dir, &package_name, true) {
            restore_pair(&profile_dir, backups.0, backups.1);
            return Err(e);
        }
    }

    registry.installed.push(ProfilePluginRecord {
        id: id.clone(),
        package_name: package_name.clone(),
        spec: spec.to_string(),
        kind: "profile".into(),
        bundle,
        insert_name: Some(package_name.clone()),
    });
    write_registry(&profile_dir, &registry)?;
    log::info!("plugins: installed {package_name} (id={id}, bundle={bundle}) into {profile_dir:?}");

    if restart {
        let _ = crate::core::sidecar::SidecarManager::global().restart(app);
    }
    Ok(super::list_profile_aware(app))
}

/// Merge profile-installed plugins into the plugin list (kind=profile).
pub fn profile_plugin_infos(app: &AppHandle) -> Vec<PluginInfo> {
    let profile = active_profile(app);
    let paths = plugin_paths_for(app, &profile);
    let registry = read_registry(&paths.profile_dir);
    let catalog = catalog_for(&paths.bundle_dir);
    // disabled set from parent module
    let disabled = super::load_disabled_ids_public(&paths.profile_dir);

    registry
        .installed
        .iter()
        .map(|p| {
            let pkg_dir = node_modules_pkg_dir(&paths.profile_dir, &p.package_name);
            let present = pkg_dir.join("package.json").exists();
            let enabled = present && !disabled.contains(&p.id) && profile != SAFE_PROFILE;
            PluginInfo {
                id: p.id.clone(),
                package_name: p.package_name.clone(),
                display_name: p
                    .insert_name
                    .clone()
                    .unwrap_or_else(|| p.package_name.clone()),
                description: format!(
                    "profile 安装 · spec: {}{}",
                    p.spec,
                    if p.bundle { " · bundle" } else { " · insert" }
                ),
                kind: "profile".into(),
                enabled,
                toggleable: true,
                source: pkg_dir.display().to_string(),
                present,
                advisory: if catalog.contains_key(&p.id) {
                    Some("id 与 internal catalog 冲突".into())
                } else {
                    None
                },
            }
        })
        .collect()
}
