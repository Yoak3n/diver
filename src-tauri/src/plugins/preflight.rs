//! 启动前布局 / profile 补丁预检。

use tauri::AppHandle;

use super::catalog::{catalog_for, package_present};
use super::paths::{active_profile, plugin_paths_for};
use super::profile::quarantine_invalid_patch;
use super::types::{PreflightReport, SAFE_PROFILE};

/// 启动前检查布局与 profile 补丁；必要时隔离坏补丁。
pub fn preflight(app: &AppHandle) -> PreflightReport {
    let profile = active_profile(app);
    let safe = profile == SAFE_PROFILE;
    let paths = plugin_paths_for(app, &profile);
    let mut problems = Vec::new();

    let harness = {
        #[cfg(debug_assertions)]
        {
            use super::paths::harness_dir;
            harness_dir()
        }
        #[cfg(not(debug_assertions))]
        {
            use std::path::PathBuf;
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
        && !harness.join("packages/sidecar/src/plugins.ts").exists()
    {
        // release cwd 侧 cordis.yml 可能在 sidecar 根；dev 在 harness/。
        // 仅在两者都缺时告警——boot 会再报 configPath 问题。
        problems.push(format!(
            "未找到 harness 标志文件（cordis.yml / plugins.ts）: {}",
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
