//! 壳端插件管理：对齐 DSH profile 语义的启停状态。
//!
//! 组合真相仍在 cos：
//! - mount 行来自 companion bundle 的 `cordis.patch.yml` insert
//! - 用户层 `$COS_HOME/profiles/companion/cordis.patch.yml` 用 `disabled: true`
//!   覆盖单行（禁用 ≠ 卸载；包体保留在 plugins/）
//!
//! 壳职责：扫描目录与清单、读写 profile patch、重启 sidecar。

mod catalog;
pub mod install;
mod package;
mod paths;
mod preflight;
mod profile;
pub mod registry;
mod types;
pub mod uninstall;

pub use catalog::{
    list_plugins, list_profile_aware, plugin_paths_json, set_plugin_enabled, toggle_plugin,
};
pub(crate) use catalog::{catalog_for, package_present};
pub use install::{install_profile_plugin, is_internal, profile_plugin_infos};
pub use paths::{active_profile, plugin_paths, plugin_paths_for};
pub use preflight::preflight;
pub use profile::{ensure_profile, switch_profile_and_restart};
pub(crate) use profile::load_disabled_ids_public;
pub use registry::{installed_ids, ProfilePluginRecord, ProfilePluginsFile};
pub use types::{
    PluginCatalogEntry, PluginCatalogFile, PluginInfo, PluginPaths, PreflightReport,
    COMPANION_PROFILE, SAFE_PROFILE,
};
pub use uninstall::uninstall_profile_plugin;
