//! 构建形态下的插件布局解析。

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use super::types::{PluginPaths, COMPANION_PROFILE, SAFE_PROFILE};

/// 纯路径拼装（release 语义，P1c/B′）：bundle/进程入口在安装目录，
/// **运行时插件区在用户工作区** `cos_home/plugins`（seed 播种对账落点）。
/// 安装目录 `sidecar/plugins` 只剩进程入口 companion，不能当插件根
/// （预检曾误查安装目录 → 每次启动硬失败 → 自动降级 safe，插件层全灭）。
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn plugin_paths_release(res_dir: &Path, cos_home: &Path, profile: &str) -> PluginPaths {
    PluginPaths {
        bundle_dir: res_dir.join("bundles").join("bundle-companion"),
        plugins_root: cos_home.join("plugins"),
        profile_dir: cos_home.join("profiles").join(profile),
    }
}

pub(crate) fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .unwrap_or(&manifest)
        .to_path_buf()
}

pub(crate) fn harness_dir() -> PathBuf {
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

/// 指定 profile 名的布局解析（active 实例）。
pub fn plugin_paths_for(app: &AppHandle, profile: &str) -> PluginPaths {
    plugin_paths_at(app, &crate::config::cos_home(app), profile)
}

/// 指定实例 COS_HOME 的布局解析（P2-3 多实例：每实例一份插件区/profile 补丁）。
pub fn plugin_paths_at(app: &AppHandle, cos_home: &Path, profile: &str) -> PluginPaths {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        plugin_paths_dev(cos_home, profile)
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
        plugin_paths_release(&res_dir, cos_home, profile)
    }
}

/// dev 布局：插件包在仓库 `cos-plugins/`（全体实例共享），profile 补丁按实例 COS_HOME 分叉。
#[cfg(debug_assertions)]
fn plugin_paths_dev(cos_home: &Path, profile: &str) -> PluginPaths {
    let root = repo_root();
    let plugins_root = {
        let cos_plugins = root.join("cos-plugins");
        if cos_plugins.is_dir() {
            cos_plugins
        } else {
            root.join("plugins")
        }
    };
    PluginPaths {
        bundle_dir: plugins_root.join("bundle-companion"),
        plugins_root,
        profile_dir: cos_home.join("profiles").join(profile),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_layout_points_plugins_to_user_workspace() {
        let res = PathBuf::from(r"C:\Program Files\Diver\resources\sidecar");
        let home = PathBuf::from(r"C:\Users\u\AppData\Roaming\com.diver.companion\cos");
        let p = plugin_paths_release(&res, &home, "companion");
        // bundle/入口在安装目录；插件区在用户工作区（预检/目录/启停都以这里为准）
        assert_eq!(p.bundle_dir, res.join("bundles").join("bundle-companion"));
        assert_eq!(p.plugins_root, home.join("plugins"));
        assert_eq!(p.profile_dir, home.join("profiles").join("companion"));
        assert_ne!(p.plugins_root, res.join("plugins"));
    }

    #[test]
    #[cfg(debug_assertions)]
    fn instance_homes_isolate_profile_patches() {
        let a = PathBuf::from("/tmp/.cos-home-default");
        let b = PathBuf::from("/tmp/.cos-home-beta");
        let pa = plugin_paths_dev(&a, "companion");
        let pb = plugin_paths_dev(&b, "companion");
        assert_eq!(pa.profile_dir, a.join("profiles").join("companion"));
        assert_eq!(pb.profile_dir, b.join("profiles").join("companion"));
        assert_ne!(pa.profile_dir, pb.profile_dir);
        // dev 形态插件包共享仓库 cos-plugins/，只有 profile 补丁逐实例分叉。
        assert_eq!(pa.plugins_root, pb.plugins_root);
    }
}
