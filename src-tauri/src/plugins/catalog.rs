//! catalog 扫描、启停写补丁、列表门面。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use tauri::AppHandle;

use super::install;
use super::paths::{active_profile, harness_dir, plugin_paths, plugin_paths_for};
use super::profile::{load_disabled_ids, parse_bundle_inserts, save_disabled_ids};
use super::types::{PluginCatalogEntry, PluginCatalogFile, PluginInfo, SAFE_PROFILE};

pub(crate) fn catalog_for(bundle_dir: &Path) -> BTreeMap<String, PluginCatalogEntry> {
    let path = bundle_dir.join("plugins.json");
    let mut map = BTreeMap::new();
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(file) = serde_json::from_str::<PluginCatalogFile>(&content) {
            for entry in file.plugins {
                map.insert(entry.id.clone(), entry);
            }
        }
    }
    map
}

pub(crate) fn package_present(plugins_root: &Path, package_name: &str) -> bool {
    let slash = package_name.rfind('/').map(|i| i + 1).unwrap_or(0);
    let pkg = &package_name[slash..];
    plugins_root.join(pkg).join("package.json").exists()
}

fn source_of(plugins_root: &Path, package_name: &str) -> String {
    let slash = package_name.rfind('/').map(|i| i + 1).unwrap_or(0);
    let pkg = &package_name[slash..];
    plugins_root.join(pkg).display().to_string()
}

fn list_plugins_scan(app: &AppHandle) -> Vec<PluginInfo> {
    let profile = active_profile(app);
    let safe = profile == SAFE_PROFILE;
    let paths = plugin_paths_for(app, &profile);
    let catalog = catalog_for(&paths.bundle_dir);
    let disabled = load_disabled_ids(&paths.profile_dir);
    let inserts = parse_bundle_inserts(&paths.bundle_dir);

    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out: Vec<PluginInfo> = Vec::new();
    let mut rows: Vec<(String, String)> = inserts;

    if let Ok(read) = std::fs::read_dir(&paths.plugins_root) {
        for entry in read.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let manifest = dir.join("package.json");
            let Ok(content) = std::fs::read_to_string(&manifest) else {
                continue;
            };
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
                continue;
            };
            let Some(name) = json.get("name").and_then(|n| n.as_str()) else {
                continue;
            };
            if !name.starts_with("@diver/") || name == "@diver/bundle-companion" {
                continue;
            }
            let pkg = name.trim_start_matches("@diver/");
            let id = catalog
                .values()
                .find(|c| c.package_name.as_deref() == Some(name))
                .map(|c| c.id.clone())
                .unwrap_or_else(|| pkg.to_string());
            if !rows.iter().any(|(rid, rname)| rid == &id || rname == name) {
                rows.push((id, name.to_string()));
            }
        }
    }

    for (id, package_name) in rows {
        if !seen.insert(id.clone()) {
            continue;
        }
        let meta = catalog.get(&id);
        let package_name = if package_name.is_empty() {
            meta.and_then(|m| m.package_name.clone())
                .unwrap_or_else(|| format!("@diver/{id}"))
        } else {
            package_name
        };
        let present = package_present(&paths.plugins_root, &package_name);
        // Mount truth = bundle insert + profile disabled；safe 档案只加载 backend。
        let enabled = present
            && !disabled.contains(&id)
            && (!safe || id == "backend");
        let source = source_of(&paths.plugins_root, &package_name);
        out.push(PluginInfo {
            display_name: meta
                .and_then(|m| m.display_name.clone())
                .unwrap_or_else(|| id.clone()),
            description: meta
                .and_then(|m| m.description.clone())
                .unwrap_or_default(),
            toggleable: meta.map(|m| m.toggleable).unwrap_or(true),
            advisory: meta.and_then(|m| m.advisory.clone()),
            id,
            package_name,
            kind: "internal".into(),
            enabled,
            source,
            present,
        });
    }

    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn set_plugin_enabled_impl(
    app: &AppHandle,
    id: &str,
    enabled: bool,
) -> Result<Vec<PluginInfo>, String> {
    let paths = plugin_paths(app);
    super::ensure_profile(app);
    let mut disabled: BTreeMap<String, String> = BTreeMap::new();
    let current = load_disabled_ids(&paths.profile_dir);
    let catalog = catalog_for(&paths.bundle_dir);
    let package = catalog
        .get(id)
        .and_then(|c| c.package_name.clone())
        .unwrap_or_else(|| format!("@diver/{id}"));

    for existing in current {
        if existing == id {
            continue;
        }
        let pkg = catalog
            .get(&existing)
            .and_then(|c| c.package_name.clone())
            .unwrap_or_else(|| format!("@diver/{existing}"));
        disabled.insert(existing, pkg);
    }
    if !enabled {
        disabled.insert(id.to_string(), package);
    }
    save_disabled_ids(&paths.profile_dir, &disabled)?;
    log::info!(
        "plugins: {} → {} ({})",
        id,
        if enabled { "enabled" } else { "disabled" },
        paths.profile_dir.display()
    );
    Ok(list_plugins_scan(app))
}

/// 列出插件（internal + profile 安装）。
pub fn list_plugins(app: &AppHandle) -> Vec<PluginInfo> {
    super::ensure_profile(app);
    list_profile_aware(app)
}

/// Merge internal scan + profile-installed rows (profile wins on id clash).
pub fn list_profile_aware(app: &AppHandle) -> Vec<PluginInfo> {
    let mut list = list_plugins_scan(app);
    for row in install::profile_plugin_infos(app) {
        if let Some(existing) = list.iter_mut().find(|x| x.id == row.id) {
            *existing = row;
        } else {
            list.push(row);
        }
    }
    list.sort_by(|a, b| a.id.cmp(&b.id));
    list
}

/// 启停插件：写 profile 补丁，不自动重启。
pub fn set_plugin_enabled(
    app: &AppHandle,
    id: &str,
    enabled: bool,
) -> Result<Vec<PluginInfo>, String> {
    set_plugin_enabled_impl(app, id, enabled)
}

/// 启停并重启 sidecar。
pub fn toggle_plugin(
    app: &AppHandle,
    id: &str,
    enabled: bool,
) -> Result<Vec<PluginInfo>, String> {
    let plugins = set_plugin_enabled_impl(app, id, enabled)?;
    let restarted = crate::base::sidecar::SidecarManager::global().restart(app);
    if !restarted {
        log::warn!("plugins: sidecar 重启未执行（可能未在运行）；配置已写入，下次启动生效");
    }
    Ok(plugins)
}

/// 当前布局路径（诊断用）。
pub fn plugin_paths_json(app: &AppHandle) -> serde_json::Value {
    let paths = plugin_paths(app);
    serde_json::json!({
        "activeProfile": active_profile(app),
        "bundleDir": paths.bundle_dir.display().to_string(),
        "pluginsRoot": paths.plugins_root.display().to_string(),
        "profileDir": paths.profile_dir.display().to_string(),
        "harnessDir": harness_dir().display().to_string(),
    })
}
