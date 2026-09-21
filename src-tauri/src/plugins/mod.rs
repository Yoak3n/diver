//! 壳端插件管理：对齐 DSH profile 语义的启停状态。
//!
//! 组合真相仍在 cos：
//! - mount 行来自 companion bundle 的 `cordis.patch.yml` insert
//! - 用户层 `$COS_HOME/profiles/companion/cordis.patch.yml` 用 `disabled: true`
//!   覆盖单行（禁用 ≠ 卸载；包体保留在 plugins/）
//!
//! 壳职责：扫描目录与清单、读写 profile patch、重启 sidecar。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub mod install;

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

fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .unwrap_or(&manifest)
        .to_path_buf()
}

fn harness_dir() -> PathBuf {
    std::env::var("DIVER_HARNESS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root().join("harness"))
}

/// 当前激活 profile 名（壳 store；空/未知回落 companion）。
pub fn active_profile(app: &AppHandle) -> String {
    let name = crate::config::profile::active_profile(app);
    if name == SAFE_PROFILE || name == COMPANION_PROFILE {
        name
    } else {
        COMPANION_PROFILE.to_string()
    }
}

/// 当前构建形态下的插件布局（profile 目录跟 active_profile 走）。
pub fn plugin_paths(app: &AppHandle) -> PluginPaths {
    plugin_paths_for(app, &active_profile(app))
}

/// 指定 profile 名的布局解析。
pub fn plugin_paths_for(app: &AppHandle, profile: &str) -> PluginPaths {
    let cos_home = crate::config::cos_home(app);
    let profile_dir = cos_home.join("profiles").join(profile);

    #[cfg(debug_assertions)]
    {
        let _ = app;
        let root = repo_root();
        let plugins_root = {
            let cos_plugins = root.join("cos-plugins");
            if cos_plugins.is_dir() {
                cos_plugins
            } else {
                root.join("plugins")
            }
        };
        let bundle_dir = plugins_root.join("bundle-companion");
        PluginPaths {
            bundle_dir,
            plugins_root,
            profile_dir,
        }
    }

    #[cfg(not(debug_assertions))]
    {
        use tauri::Manager as _;
        let res_dir = app
            .path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("resources")
            .join("sidecar");
        PluginPaths {
            bundle_dir: res_dir.join("bundles").join("bundle-companion"),
            plugins_root: res_dir.join("plugins"),
            profile_dir,
        }
    }
}

/// 确保 profile 用户补丁层存在；损坏补丁隔离为 `.bak-*` 并重置为 `[]`。
pub fn ensure_profile(app: &AppHandle) -> PathBuf {
    let profile = active_profile(app);
    let paths = plugin_paths_for(app, &profile);
    if let Err(e) = std::fs::create_dir_all(&paths.profile_dir) {
        log::warn!(
            "plugins: 创建 profile 目录失败 {}: {e}",
            paths.profile_dir.display()
        );
    }
    if let Some(bak) = quarantine_invalid_patch(&paths.profile_dir) {
        log::warn!(
            "plugins: profile 补丁无效，已隔离为 {} 并重置为 []",
            bak.display()
        );
    }
    let patch = paths.profile_dir.join("cordis.patch.yml");
    if !patch.exists() {
        let template = "# Diver shell-managed profile patch (enable/disable plugin rows).\n[]\n";
        if let Err(e) = std::fs::write(&patch, template) {
            log::warn!("plugins: 写入 profile patch 失败 {}: {e}", patch.display());
        }
    }
    let manifest = paths.profile_dir.join("package.json");
    if !manifest.exists() {
        let json = serde_json::json!({
            "name": format!("cos-profile-{profile}"),
            "private": true,
            "dependencies": {},
            "dsh": { "profile": { "bundles": [] } }
        });
        let _ = std::fs::write(
            &manifest,
            serde_json::to_string_pretty(&json).unwrap_or_default() + "\n",
        );
    }
    paths.profile_dir
}

/// 补丁是否像合法 YAML 列表（`[]` 或 `- …`；允许注释/空行）。
fn patch_looks_valid(content: &str) -> bool {
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        return t.starts_with('[') || t.starts_with('-');
    }
    true
}

/// 无效补丁 → 移到 `cordis.patch.yml.bak-<ms>`，写回 `[]`。返回备份路径。
fn quarantine_invalid_patch(profile_dir: &Path) -> Option<PathBuf> {
    let path = profile_dir.join("cordis.patch.yml");
    let content = std::fs::read_to_string(&path).ok()?;
    if patch_looks_valid(&content) {
        return None;
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let bak = profile_dir.join(format!("cordis.patch.yml.bak-{ms}"));
    std::fs::rename(&path, &bak).ok()?;
    let reset = "# Diver shell-managed profile patch (enable/disable plugin rows).\n[]\n";
    let _ = std::fs::write(&path, reset);
    Some(bak)
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

/// 启动前检查布局与 profile 补丁；必要时隔离坏补丁。
pub fn preflight(app: &AppHandle) -> PreflightReport {
    let profile = active_profile(app);
    let safe = profile == SAFE_PROFILE;
    let paths = plugin_paths_for(app, &profile);
    let mut problems = Vec::new();

    let harness = {
        #[cfg(debug_assertions)]
        {
            harness_dir()
        }
        #[cfg(not(debug_assertions))]
        {
            use tauri::Manager as _;
            app.path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("resources")
                .join("sidecar")
                .join("harness")
        }
    };

    let boot_entry = harness.join("packages/boot/src/index.ts");
    if !boot_entry.exists() {
        problems.push(format!("harness boot 入口缺失: {}", boot_entry.display()));
    }
    if !harness.join("cordis.yml").exists()
        && !harness.join("packages/sidecar/src/companion.ts").exists()
    {
        // release cwd 侧 cordis.yml 可能在 sidecar 根；dev 在 harness/。
        // 仅在两者都缺时告警——boot 会再报 configPath 问题。
        problems.push(format!(
            "未找到 harness 标志文件（cordis.yml / companion.ts）: {}",
            harness.display()
        ));
    }

    let backend_pkg = paths.plugins_root.join("backend/package.json");
    if !backend_pkg.exists() {
        problems.push(format!(
            "最小传输插件缺失: {}（safe/companion 均需要 backend）",
            backend_pkg.display()
        ));
    }

    if !safe {
        let bundle_patch = paths.bundle_dir.join("cordis.patch.yml");
        if !bundle_patch.exists() {
            problems.push(format!(
                "companion bundle 补丁缺失: {}",
                bundle_patch.display()
            ));
        }
        // catalog 声明但包体缺失 → 警告级问题（不阻止 companion 启动，但 preflight 记录）
        let catalog = catalog_for(&paths.bundle_dir);
        for (id, entry) in &catalog {
            let pkg = entry
                .package_name
                .clone()
                .unwrap_or_else(|| format!("@diver/{id}"));
            if !package_present(&paths.plugins_root, &pkg) {
                problems.push(format!("插件包体缺失: {id} ({pkg})"));
            }
        }
    }

    if let Err(e) = std::fs::create_dir_all(&paths.profile_dir) {
        problems.push(format!(
            "无法创建 profile 目录 {}: {e}",
            paths.profile_dir.display()
        ));
    }
    let quarantined = quarantine_invalid_patch(&paths.profile_dir).map(|p| p.display().to_string());
    let patch = paths.profile_dir.join("cordis.patch.yml");
    if !patch.exists() {
        let template = "# Diver shell-managed profile patch (enable/disable plugin rows).\n[]\n";
        let _ = std::fs::write(&patch, template);
    }

    // safe 模式只硬性要求 harness + backend；companion 下 bundle 缺失算失败。
    let hard_fail = problems.iter().any(|p| {
        p.contains("harness boot")
            || p.contains("最小传输插件缺失")
            || (!safe && p.contains("bundle 补丁缺失"))
    });

    PreflightReport {
        ok: !hard_fail,
        profile: profile.clone(),
        safe_mode: safe,
        problems,
        quarantined,
        bundle_dir: paths.bundle_dir.display().to_string(),
        plugins_root: paths.plugins_root.display().to_string(),
        profile_dir: paths.profile_dir.display().to_string(),
        harness_dir: harness.display().to_string(),
    }
}

/// 切换 profile 并重启 sidecar（设置页「安全模式」入口）。
pub fn switch_profile_and_restart(app: &AppHandle, profile: &str) -> Result<PreflightReport, String> {
    let name = profile.trim();
    if name != COMPANION_PROFILE && name != SAFE_PROFILE {
        return Err(format!("未知 profile: {name}（仅支持 {COMPANION_PROFILE} / {SAFE_PROFILE}）"));
    }
    if !crate::config::profile::set_active_profile(app, name) {
        return Err("写入 active_profile 失败".into());
    }
    ensure_profile(app);
    let report = preflight(app);
    if !report.ok {
        log::warn!(
            "plugins: 切换到 {name} 后 preflight 仍有问题: {:?}",
            report.problems
        );
    }
    let restarted = crate::base::sidecar::SidecarManager::global().restart(app);
    if !restarted {
        log::warn!("plugins: sidecar 重启未执行；profile={name} 将在下次启动生效");
    }
    Ok(report)
}

fn parse_bundle_inserts(bundle_dir: &Path) -> Vec<(String, String)> {
    let path = bundle_dir.join("cordis.patch.yml");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut rows: Vec<(String, String)> = Vec::new();
    let mut current_id: Option<String> = None;
    let mut in_insert = false;

    for raw in content.lines() {
        let line = raw.trim();
        if line.starts_with('#') {
            continue;
        }
        if line.starts_with("- insert:") || line == "- insert:" {
            in_insert = true;
            continue;
        }
        if !in_insert {
            continue;
        }
        if let Some(rest) = line.strip_prefix("- id:") {
            if let Some(id) = current_id.take() {
                rows.push((id, String::new()));
            }
            current_id = Some(unquote(rest.trim()));
            continue;
        }
        if line.starts_with("name:") && current_id.is_some() {
            let name = unquote(line.trim_start_matches("name:").trim());
            if let Some(id) = current_id.take() {
                rows.push((id, name));
            }
        }
    }
    if let Some(id) = current_id.take() {
        rows.push((id, String::new()));
    }
    rows
}

fn unquote(s: &str) -> String {
    s.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

fn load_disabled_ids(profile_dir: &Path) -> BTreeSet<String> {
    let path = profile_dir.join("cordis.patch.yml");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return BTreeSet::new();
    };
    let mut disabled = BTreeSet::new();
    let mut current_id: Option<String> = None;
    let mut current_disabled = false;

    let flush = |id: &mut Option<String>, dis: &mut bool, out: &mut BTreeSet<String>| {
        if let Some(i) = id.take() {
            if *dis {
                out.insert(i);
            }
        }
        *dis = false;
    };

    for raw in content.lines() {
        let line = raw.trim();
        if line.starts_with('#') || line.is_empty() || line == "[]" || line == "-" {
            continue;
        }
        if let Some(rest) = line.strip_prefix("- id:") {
            flush(&mut current_id, &mut current_disabled, &mut disabled);
            current_id = Some(unquote(rest.trim()));
            continue;
        }
        if let Some(rest) = line.strip_prefix("id:") {
            flush(&mut current_id, &mut current_disabled, &mut disabled);
            current_id = Some(unquote(rest.trim()));
            continue;
        }
        if line.starts_with("disabled:") {
            let val = unquote(line.trim_start_matches("disabled:").trim()).to_ascii_lowercase();
            current_disabled = matches!(val.as_str(), "true" | "1" | "yes" | "on");
        }
    }
    flush(&mut current_id, &mut current_disabled, &mut disabled);
    disabled
}

fn save_disabled_ids(
    profile_dir: &Path,
    disabled: &BTreeMap<String, String>,
) -> Result<(), String> {
    std::fs::create_dir_all(profile_dir).map_err(|e| format!("PROFILE_DIR_CREATE: {e}"))?;
    let path = profile_dir.join("cordis.patch.yml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    // Preserve non-shell blocks (profile plugin inserts, user config patches).
    let mut preserved: Vec<String> = Vec::new();
    let mut block: Vec<String> = Vec::new();
    let flush_block = |block: &mut Vec<String>, preserved: &mut Vec<String>| {
        if block.is_empty() {
            return;
        }
        let text = block.join("\n");
        let is_insert = block
            .iter()
            .any(|l| l.trim_start().starts_with("- insert:") || l.trim() == "- insert:");
        let has_id = block
            .iter()
            .any(|l| l.trim_start().starts_with("- id:") || l.trim_start().starts_with("id:"));
        let has_disable = block.iter().any(|l| {
            let t = l.trim();
            t.starts_with("disabled:")
                && matches!(
                    t.trim_start_matches("disabled:").trim().to_ascii_lowercase().as_str(),
                    "true" | "1" | "yes" | "on"
                )
        });
        // Drop only shell-managed disable rows; keep inserts and other patches.
        if is_insert || !(has_id && has_disable) {
            preserved.push(text);
        }
        block.clear();
    };

    for line in existing.lines() {
        let top_item = line.starts_with("- ") || line == "-";
        if top_item && !block.is_empty() {
            flush_block(&mut block, &mut preserved);
        }
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            if !block.is_empty() {
                block.push(line.to_string());
            }
            continue;
        }
        block.push(line.to_string());
    }
    flush_block(&mut block, &mut preserved);

    let mut out = String::from(
        "# Diver shell-managed profile patch (enable/disable plugin rows).\n",
    );
    for chunk in &preserved {
        out.push_str(chunk);
        if !chunk.ends_with('\n') {
            out.push('\n');
        }
    }
    for (id, package) in disabled {
        out.push_str("- id: ");
        out.push_str(id);
        out.push('\n');
        if !package.is_empty() {
            out.push_str("  name: '");
            out.push_str(package);
            out.push_str("'\n");
        }
        out.push_str("  disabled: true\n");
    }
    if preserved.is_empty() && disabled.is_empty() {
        out.push_str("[]\n");
    }
    std::fs::write(&path, out).map_err(|e| format!("PROFILE_PATCH_WRITE: {e}"))
}

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
    ensure_profile(app);
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

/// For install module — disabled id set for the given profile dir.
pub(crate) fn load_disabled_ids_public(profile_dir: &Path) -> BTreeSet<String> {
    load_disabled_ids(profile_dir)
}

/// 列出插件（internal + profile 安装）。
pub fn list_plugins(app: &AppHandle) -> Vec<PluginInfo> {
    ensure_profile(app);
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
