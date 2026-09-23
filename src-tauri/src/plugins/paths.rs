//! 构建形态下的插件布局解析。

use std::path::PathBuf;

use tauri::AppHandle;

use super::types::{PluginPaths, COMPANION_PROFILE, SAFE_PROFILE};

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
