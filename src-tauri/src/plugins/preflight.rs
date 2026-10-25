//! 启动前布局 / profile 补丁预检。

use std::path::Path;

use tauri::AppHandle;

use super::catalog::{catalog_for, package_present};
use super::paths::plugin_paths_at;
use super::profile::quarantine_invalid_patch;
use super::types::{PreflightReport, SAFE_PROFILE};

/// 包是否「可用」：工作区已有，或 release 种子镜像里待播种（sidecar boot
/// 的 seedIfNeeded 会在装载前铺进工作区）。两者皆无才算真缺失。
fn package_available(plugins_root: &Path, seed_dir: &Path, package_name: &str) -> bool {
    if package_present(plugins_root, package_name) {
        return true;
    }
    !seed_dir.as_os_str().is_empty() && package_present(seed_dir, package_name)
}

/// 启动前检查布局与 profile 补丁；必要时隔离坏补丁。
pub fn preflight(app: &AppHandle) -> PreflightReport {
    let cos_home = crate::config::cos_home(app);
    let profile = super::paths::active_profile(app);
    preflight_with(app, &cos_home, profile)
}

/// 指定实例 COS_HOME 的启动预检（P2-3 多实例：每个 sidecar 检查自己的布局与补丁）。
///
/// 非 active 实例没有旧壳层 profile 可迁移：缺文件即 companion。
pub fn preflight_at(app: &AppHandle, cos_home: &Path) -> PreflightReport {
    let profile = crate::config::profile::active_profile_at(cos_home, cos_home);
    preflight_with(app, cos_home, profile)
}

fn preflight_with(app: &AppHandle, cos_home: &Path, profile: String) -> PreflightReport {
    let safe = profile == SAFE_PROFILE;
    let paths = plugin_paths_at(app, cos_home, &profile);
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

    // release 随包种子镜像（首启播种源）；dev 布局无种子（空路径 = 不参与判定）。
    let seed_dir = {
        #[cfg(debug_assertions)]
        {
            std::path::PathBuf::new()
        }
        #[cfg(not(debug_assertions))]
        {
            use tauri::Manager as _;
            app.path()
                .resource_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                .join("resources")
                .join("sidecar")
                .join("plugins.seed")
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
    if !package_available(&paths.plugins_root, &seed_dir, "@diver/backend") {
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
            if package_available(&paths.plugins_root, &seed_dir, &pkg) {
                continue;
            }
            problems.push(format!(
                "插件包体缺失: {id} ({pkg})（工作区与种子镜像均无）"
            ));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_available_checks_workspace_then_seed() {
        let tmp = std::env::temp_dir().join(format!("diver-preflight-{}", std::process::id()));
        let workspace = tmp.join("ws");
        let seed = tmp.join("seed");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(workspace.join("backend")).unwrap();
        std::fs::create_dir_all(seed.join("memory")).unwrap();
        std::fs::write(workspace.join("backend/package.json"), "{}").unwrap();
        std::fs::write(seed.join("memory/package.json"), "{}").unwrap();

        // 工作区有 → 可用；种子有 → 可用（待播种）；两边都无 → 缺失
        assert!(package_available(&workspace, &seed, "@diver/backend"));
        assert!(package_available(&workspace, &seed, "@diver/memory"));
        assert!(!package_available(&workspace, &seed, "@diver/onebot"));
        // 种子路径为空（dev 布局）→ 只认工作区
        let empty = std::path::PathBuf::new();
        assert!(package_available(&workspace, &empty, "@diver/backend"));
        assert!(!package_available(&workspace, &empty, "@diver/memory"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
