//! Node sidecar 启动命令组装（dev / release 两套 loader 契约）。

use std::process::{Command, Stdio};
use tauri::AppHandle;
#[cfg(not(debug_assertions))]
use tauri::Manager;

use super::paths::{shutdown_token, LAST_COS_HOME};
use super::process::SidecarManager;
#[cfg(not(debug_assertions))]
use super::paths::{
    RELEASE_BUNDLE_DIR, RELEASE_ENTRY, RELEASE_HARNESS_DIR, RELEASE_PLUGINS_DIR, RELEASE_SIDECAR_DIR,
};

impl SidecarManager {
    /// 构建 sidecar 启动命令。
    pub(super) fn build_command(&self, app: &AppHandle) -> Result<Command, String> {
        #[cfg(not(debug_assertions))]
        {
            // ── release：解析 Node + tsx 启动 companion-bundle.ts ─────────
            // Tauri 在 Windows 上把 resources 打包到 <exe_dir>/resources/，
            // 而 resource_dir() 返回 exe 所在目录，需再拼 resources 前缀。
            let res_dir = app
                .path()
                .resource_dir()
                .map_err(|e| format!("无法解析资源目录: {e}"))?
                .join("resources");
            let sidecar_dir = res_dir.join(RELEASE_SIDECAR_DIR);

            // 1) 进程内解压依赖（无黑窗；进度 setup://progress）
            crate::base::setup_progress::ensure_deps_extracted(app, &sidecar_dir)?;
            self.push_log("[diver] 运行依赖就绪".into());

            // 2) Node 不随包：本机 / 缓存 / 按需下载
            let mut boot_logs: Vec<String> = Vec::new();
            let runtime = {
                let logs = &mut boot_logs;
                crate::base::setup_progress::ensure_node_ready(app, &mut |line: String| {
                    log::info!("{line}");
                    logs.push(line);
                })?
            };
            for line in boot_logs {
                self.push_log(line);
            }
            let node_exe = runtime.node_exe.clone();
            self.push_log(format!(
                "[diver] Node ({}) {}",
                runtime.source,
                node_exe.display()
            ));

            let entry = sidecar_dir.join(RELEASE_ENTRY);
            if !entry.exists() {
                return Err(format!(
                    "sidecar 入口不存在: {}",
                    entry.display()
                ));
            }
            let bundle_dir = sidecar_dir.join(RELEASE_BUNDLE_DIR);
            if !bundle_dir.join("cordis.patch.yml").exists() {
                return Err(format!(
                    "打包的 companion bundle 层不存在: {}",
                    bundle_dir.display()
                ));
            }
            let harness_dir = sidecar_dir.join(RELEASE_HARNESS_DIR);
            let plugins_dir = sidecar_dir.join(RELEASE_PLUGINS_DIR);

            // 用户数据目录：与安装目录隔离（升级安装不丢会话/记忆）。
            // 与 config::mcp 共享同一路径（cos_home 即 sidecar 注入的 COS_HOME）。
            let cos_home = crate::config::cos_home(app);
            let _ = LAST_COS_HOME.set(cos_home.clone());
            if let Err(e) = std::fs::create_dir_all(&cos_home) {
                log::warn!("创建 COS_HOME 失败: {e}");
            }

            let ui_dist = sidecar_dir.join("dist");

            // Windows 长路径前缀 \\?\（Tauri 的 resource_dir 可能带它）会使
            // node 无法处理路径参数（EISDIR / lstat 'C:'），统一剥离。
            let clean = |p: &std::path::Path| -> String {
                p.to_string_lossy().trim_start_matches("\\\\?\\").to_string()
            };

            // tsx loader：随包 harness 的 node_modules/tsx/dist/loader.mjs（file:// URL）。
            let tsx_loader = format!(
                "file:///{}/node_modules/tsx/dist/loader.mjs",
                clean(&harness_dir).replace('\\', "/")
            );

            log::info!(
                "启动 sidecar: {} --import tsx {}（harness={}, plugins={}, COS_HOME={}）",
                node_exe.display(),
                entry.display(),
                harness_dir.display(),
                plugins_dir.display(),
                cos_home.display()
            );
            self.push_log(format!(
                "[diver] 启动 sidecar (Node source={})",
                runtime.source
            ));

            let mut cmd = Command::new(&node_exe);
            cmd.arg("--import").arg(&tsx_loader)
                .arg("--expose-internals")
                .arg(clean(&entry))
                .arg("--bundles").arg(clean(&bundle_dir))
                .arg("--plugin-root").arg(clean(&plugins_dir))
                .arg("--harness").arg(clean(&harness_dir))
                .arg("--profile").arg(crate::plugins::active_profile(app))
                .env("COS_HOME", &cos_home)
                .env("DIVER_PORT", self.port().to_string())
                .env("DIVER_SHUTDOWN_TOKEN", shutdown_token())
                .env("DIVER_UI_DIST", &ui_dist)
                .env("DIVER_BUNDLE_DIR", clean(&bundle_dir))
                .env("DIVER_PLUGINS_ROOT", clean(&plugins_dir))
                .env(
                    "DIVER_MCP_CONFIG_FILE",
                    crate::config::mcp::config_path(app).to_string_lossy().to_string(),
                )
                .env(
                    "DIVER_MEMORY_PORT",
                    std::env::var("DIVER_MEMORY_PORT").unwrap_or_default(),
                )
                .current_dir(&sidecar_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            return Ok(cmd);
        }

        #[cfg(debug_assertions)]
        {
            // ── dev：仓库内 harness + node/tsx（与 release 同一 loader 契约） ──
            let entry = self.harness_dir.join("packages/sidecar/src/companion.ts");
            let entry = if entry.exists() {
                entry
            } else {
                // pnpm 依赖提升布局：入口可能位于仓库根
                self.harness_dir
                    .parent()
                    .unwrap_or(&self.harness_dir)
                    .join("packages/sidecar/src/companion.ts")
            };
            let cos_home = crate::config::cos_home(app);
            let _ = LAST_COS_HOME.set(cos_home.clone());
            if !entry.exists() {
                return Err(format!(
                    "sidecar 入口不存在: {}（请先在根目录执行 pnpm install）",
                    entry.display()
                ));
            }

            let repo_root = self
                .harness_dir
                .parent()
                .unwrap_or(&self.harness_dir)
                .to_path_buf();
            let plugins_root = {
                let cos_plugins = repo_root.join("cos-plugins");
                if cos_plugins.is_dir() {
                    cos_plugins
                } else {
                    repo_root.join("plugins")
                }
            };
            let bundle_dir = plugins_root.join("bundle-companion");
            let harness_dir = if self.harness_dir.join("packages").is_dir() {
                self.harness_dir.clone()
            } else {
                repo_root.join("harness")
            };

            log::info!(
                "启动 sidecar: node --import tsx {}（profile=companion plugins={} harness={} COS_HOME={}）",
                entry.display(),
                plugins_root.display(),
                harness_dir.display(),
                cos_home.display()
            );
            self.push_log(format!(
                "[diver] 启动: {}（profile=companion + pluginRoot）",
                entry.display()
            ));

            let mut cmd = Command::new(&self.node_bin);
            cmd.arg("--import")
                .arg("tsx")
                .arg("--expose-internals")
                .arg(&entry)
                .arg("--bundles")
                .arg(&bundle_dir)
                .arg("--plugin-root")
                .arg(&plugins_root)
                .arg("--harness")
                .arg(&harness_dir)
                .arg("--profile")
                .arg(crate::plugins::active_profile(app))
                .env("COS_HOME", &cos_home)
                .env("DIVER_PORT", self.port().to_string())
                .env("DIVER_SHUTDOWN_TOKEN", shutdown_token())
                .env(
                    "DIVER_BUNDLE_DIR",
                    crate::plugins::plugin_paths_for(app, &crate::plugins::active_profile(app))
                        .bundle_dir
                        .display()
                        .to_string(),
                )
                .env(
                    "DIVER_PLUGINS_ROOT",
                    crate::plugins::plugin_paths_for(app, &crate::plugins::active_profile(app))
                        .plugins_root
                        .display()
                        .to_string(),
                )
                .env(
                    "DIVER_MCP_CONFIG_FILE",
                    crate::config::mcp::config_path(app).to_string_lossy().to_string(),
                )
                .env(
                    "DIVER_MEMORY_PORT",
                    std::env::var("DIVER_MEMORY_PORT").unwrap_or_default(),
                )
                .current_dir(&harness_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            return Ok(cmd);
        }
    }
}
