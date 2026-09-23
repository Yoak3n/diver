//! P4：profile 插件安装 / 卸载（对齐 DSH plugin-manager 不变量）。
//!
//! - 状态在磁盘：`diver-plugins.json` + profile `package.json`（依赖 / dsh.profile.bundles）
//! - 禁用 ≠ 卸载：disable 只写 profile patch；uninstall 才动依赖
//! - internal（cos-plugins / plugins 目录、catalog `@diver/*`）**不可卸载**
//! - 安装失败回滚 `package.json` + `pnpm-lock.yaml`

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{
    active_profile, catalog_for, package_present, plugin_paths_for, PluginInfo, SAFE_PROFILE,
};

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

fn pnpm_bin() -> String {
    std::env::var("DIVER_PNPM").unwrap_or_else(|_| "pnpm".into())
}

fn run_pnpm(profile_dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(pnpm_bin())
        .args(args)
        .current_dir(profile_dir)
        .stdin(Stdio::null())
        .env("CI", "1")
        .env("npm_config_yes", "true")
        .output()
        .map_err(|e| format!("无法执行 pnpm（{}）: {e}（可设置 DIVER_PNPM 指向 pnpm）", pnpm_bin()))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let log = format!("{stdout}\n{stderr}");
    if !out.status.success() {
        return Err(format!("pnpm {} 失败:\n{}", args.join(" "), log.trim()));
    }
    Ok(log)
}

/// Derive npm package name from install spec (file: / scoped / name@version).
fn package_name_from_spec(spec: &str, profile_dir: &Path) -> Result<String, String> {
    let spec = spec.trim();
    if let Some(rest) = spec.strip_prefix("file:") {
        let raw = rest.trim_start_matches("./");
        let path = if Path::new(raw).is_absolute() {
            PathBuf::from(raw)
        } else {
            profile_dir.join(raw)
        };
        let manifest = path.join("package.json");
        let content =
            fs::read_to_string(&manifest).map_err(|e| format!("读取 file: 包失败 {manifest:?}: {e}"))?;
        let json: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| format!("file: package.json 解析失败: {e}"))?;
        let name = json
            .get("name")
            .and_then(|n| n.as_str())
            .ok_or_else(|| "file: 包缺少 name 字段".to_string())?;
        return Ok(name.to_string());
    }
    if spec.starts_with('@') {
        // @scope/name or @scope/name@version
        let without_ver = match spec.rfind('@') {
            Some(i) if i > 0 => &spec[..i],
            _ => spec,
        };
        return Ok(without_ver.to_string());
    }
    let name = spec.split('@').next().unwrap_or(spec);
    if name.is_empty() {
        return Err(format!("无法从 spec 解析包名: {spec}"));
    }
    Ok(name.to_string())
}

fn insert_id_from_package(package_name: &str) -> String {
    let slash = package_name.rfind('/').map(|i| i + 1).unwrap_or(0);
    package_name[slash..].to_string()
}

fn node_modules_pkg_dir(profile_dir: &Path, package_name: &str) -> PathBuf {
    if package_name.starts_with('@') {
        let slash = package_name.find('/').unwrap_or(0);
        profile_dir
            .join("node_modules")
            .join(&package_name[..slash])
            .join(&package_name[slash + 1..])
    } else {
        profile_dir.join("node_modules").join(package_name)
    }
}

fn package_declares_bundle(profile_dir: &Path, package_name: &str) -> bool {
    let manifest = node_modules_pkg_dir(profile_dir, package_name).join("package.json");
    let Ok(content) = fs::read_to_string(&manifest) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    json.pointer("/dsh/bundle").is_some() || json.pointer("/cos/bundle").is_some()
}

fn profile_manifest_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("package.json")
}

fn backup_pair(profile_dir: &Path) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    (
        fs::read(profile_manifest_path(profile_dir)).ok(),
        fs::read(profile_dir.join("pnpm-lock.yaml")).ok(),
    )
}

fn restore_pair(profile_dir: &Path, pkg: Option<Vec<u8>>, lock: Option<Vec<u8>>) {
    if let Some(bytes) = pkg {
        let _ = fs::write(profile_manifest_path(profile_dir), bytes);
    }
    if let Some(bytes) = lock {
        let _ = fs::write(profile_dir.join("pnpm-lock.yaml"), bytes);
    }
}

fn update_profile_bundles(profile_dir: &Path, package_name: &str, add: bool) -> Result<(), String> {
    let path = profile_manifest_path(profile_dir);
    let content =
        fs::read_to_string(&path).map_err(|e| format!("读取 profile package.json 失败: {e}"))?;
    let mut json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("profile package.json 解析失败: {e}"))?;
    if json.get("dsh").and_then(|d| d.get("profile")).is_none() {
        let obj = json.as_object_mut().ok_or("profile package.json 非对象")?;
        obj.insert(
            "dsh".into(),
            serde_json::json!({ "profile": { "bundles": [] } }),
        );
    }
    let bundles = json
        .pointer_mut("/dsh/profile/bundles")
        .ok_or("dsh.profile.bundles 缺失")?;
    let arr = bundles
        .as_array_mut()
        .ok_or("dsh.profile.bundles 不是数组")?;
    let has = arr.iter().any(|v| v.as_str() == Some(package_name));
    if add && !has {
        arr.push(serde_json::Value::String(package_name.to_string()));
    } else if !add && has {
        arr.retain(|v| v.as_str() != Some(package_name));
    } else {
        return Ok(());
    }
    let out = serde_json::to_string_pretty(&json).map_err(|e| format!("manifest 序列化失败: {e}"))?;
    fs::write(&path, out + "\n").map_err(|e| format!("写 profile package.json 失败: {e}"))
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
        kind: kind_profile(),
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

/// Snapshot helper for list_plugins merge.
pub fn installed_ids(profile_dir: &Path) -> BTreeMap<String, ProfilePluginRecord> {
    read_registry(profile_dir)
        .installed
        .into_iter()
        .map(|p| (p.id.clone(), p))
        .collect()
}
