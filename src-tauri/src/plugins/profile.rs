//! profile 用户补丁层：ensure / 隔离坏补丁 / 启停禁用行。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use super::paths::{active_profile, plugin_paths_for};
use super::preflight::preflight;
use super::types::{PreflightReport, COMPANION_PROFILE, SAFE_PROFILE};

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
pub(crate) fn quarantine_invalid_patch(profile_dir: &Path) -> Option<PathBuf> {
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

/// 切换 profile 并重启 sidecar（设置页「安全模式」入口）。
///
/// `restart_fn` 由调用方注入，plugins 不依赖 core。
pub fn switch_profile_and_restart(
    app: &AppHandle,
    profile: &str,
    restart_fn: &dyn Fn(&AppHandle) -> bool,
) -> Result<PreflightReport, String> {
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
    let restarted = restart_fn(app);
    if !restarted {
        log::warn!("plugins: sidecar 重启未执行；profile={name} 将在下次启动生效");
    }
    Ok(report)
}

pub(crate) fn parse_bundle_inserts(bundle_dir: &Path) -> Vec<(String, String)> {
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

pub(crate) fn load_disabled_ids(profile_dir: &Path) -> BTreeSet<String> {
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

pub(crate) fn save_disabled_ids(
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

/// For install module — disabled id set for the given profile dir.
pub(crate) fn load_disabled_ids_public(profile_dir: &Path) -> BTreeSet<String> {
    load_disabled_ids(profile_dir)
}
