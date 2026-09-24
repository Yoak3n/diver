//! 启动描述与预检结果（由上层注入，core 不依赖 plugins）。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::AppHandle;

/// sidecar 启动描述：profile + 插件布局路径。
///
/// 由 app/commands 在启动前用参数填入（组装逻辑在 plugins 层），
/// core 只消费，不反向依赖 plugins。
#[derive(Debug, Clone)]
pub struct LaunchContext {
    pub profile: String,
    pub bundle_dir: PathBuf,
    pub plugins_root: PathBuf,
}

impl LaunchContext {
    /// 拼 `--profile` 启动参数（纯函数，便于单测）。
    pub fn profile_args(&self) -> [(&'static str, &str); 1] {
        [("--profile", self.profile.as_str())]
    }
}

/// 预检结果（core 启动决策所需字段；完整报告在 plugins）。
#[derive(Debug, Clone)]
pub struct PreflightStatus {
    pub ok: bool,
    pub profile: String,
    pub safe_mode: bool,
    pub problems: Vec<String>,
    pub quarantined: Option<String>,
}

/// 启动期注入的跨层能力（app 组装，core 不依赖 plugins）。
#[derive(Clone)]
pub struct LaunchHooks {
    /// 组装启动描述（app 包一层 plugins::active_profile / plugin_paths_for）。
    pub launch: Arc<dyn Fn(&AppHandle) -> LaunchContext + Send + Sync>,
    /// 启动预检（app 包一层 plugins::preflight，映射到 PreflightStatus）。
    pub preflight: Arc<dyn Fn(&AppHandle) -> PreflightStatus + Send + Sync>,
    /// 降级用 safe profile 名（如 `"safe"`）。
    pub safe_profile_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_args_emits_profile_flag() {
        let ctx = LaunchContext {
            profile: "companion".into(),
            bundle_dir: PathBuf::from("/b"),
            plugins_root: PathBuf::from("/p"),
        };
        let args = ctx.profile_args();
        assert_eq!(args[0].0, "--profile");
        assert_eq!(args[0].1, "companion");
    }

    #[test]
    fn profile_args_safe_name() {
        let ctx = LaunchContext {
            profile: "safe".into(),
            bundle_dir: PathBuf::from("/b"),
            plugins_root: PathBuf::from("/p"),
        };
        assert_eq!(ctx.profile_args()[0].1, "safe");
    }
}
