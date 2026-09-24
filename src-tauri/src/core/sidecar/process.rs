//! SidecarManager：进程句柄、状态快照与生命周期入口。
//!
//! 启动/停止细节见 `lifecycle`；优雅退出见 `shutdown`；端口回收见 `reclaim`。

#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::AtomicBool;

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use super::launch::LaunchHooks;
use super::lifecycle::{start_impl, stop_impl};
use super::status::{SidecarState, SidecarStatus, LOG_CAPACITY};
use super::SidecarJob;

pub struct SidecarManager {
    pub(super) child: Mutex<Option<Child>>,
    pub(super) status: Mutex<SidecarStatus>,
    /// Windows：sidecar 进程树所在的 Job Object（KILL_ON_JOB_CLOSE）。
    /// 持有句柄期间不触发清理；应用退出 / Job 句柄 drop 时整树被终止。
    /// 非 Windows 平台为单元类型占位。
    pub(super) job: Mutex<Option<SidecarJob>>,
    #[cfg(debug_assertions)]
    pub(super) harness_dir: PathBuf,
    #[cfg(debug_assertions)]
    pub(super) node_bin: String,
    pub(super) stopping: AtomicBool,
    /// 启动期注入的跨层能力（app 组装；core 不依赖 plugins）。
    pub(super) hooks: Mutex<Option<LaunchHooks>>,
}

impl SidecarManager {
    pub fn global() -> &'static Self {
        static INSTANCE: OnceCell<SidecarManager> = OnceCell::new();
        INSTANCE.get_or_init(|| {
            #[cfg(debug_assertions)]
            let harness_dir = std::env::var("DIVER_HARNESS_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    // 默认相对仓库布局：src-tauri 的上一级目录下的 harness/
                    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                    manifest.parent().unwrap_or(&manifest).join("harness")
                });
            #[cfg(debug_assertions)]
            let node_bin = std::env::var("DIVER_NODE_BIN").unwrap_or_else(|_| "node".into());
            let port = std::env::var("DIVER_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(super::paths::DEFAULT_PORT);
            SidecarManager {
                child: Mutex::new(None),
                status: Mutex::new(SidecarStatus {
                    state: SidecarState::Stopped,
                    port,
                    logs: Vec::new(),
                }),
                job: Mutex::new(None),
                #[cfg(debug_assertions)]
                harness_dir,
                #[cfg(debug_assertions)]
                node_bin,
                stopping: AtomicBool::new(false),
                hooks: Mutex::new(None),
            }
        })
    }

    /// 注入启动期跨层能力（app/setup 调用一次）。
    pub fn set_hooks(&self, hooks: LaunchHooks) {
        *self.hooks.lock() = Some(hooks);
    }

    /// 当前状态快照。
    pub fn status(&self) -> SidecarStatus {
        self.status.lock().clone()
    }

    pub fn port(&self) -> u16 {
        self.status.lock().port
    }

    /// WebView 加载的 UI 地址。
    /// - dev（debug 构建）：Vite 开发服务器（`/api` 由 Vite 代理到 sidecar）
    /// - release：sidecar 自带的静态 UI（同源）
    pub fn ui_url(&self) -> String {
        #[cfg(debug_assertions)]
        {
            "http://localhost:1420".to_string()
        }
        #[cfg(not(debug_assertions))]
        {
            format!("http://127.0.0.1:{}", self.port())
        }
    }

    /// sidecar 的 API 根地址。
    pub fn api_base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port())
    }

    pub(super) fn push_log(&self, line: String) {
        let mut status = self.status.lock();
        status.logs.insert(0, line);
        status.logs.truncate(LOG_CAPACITY);
    }

    pub(super) fn set_state(&self, state: SidecarState) {
        self.status.lock().state = state;
    }

    pub(super) fn emit_status(&self, app: &AppHandle) {
        let status = self.status();
        let _ = app.emit("sidecar://status", status);
    }

    /// 启动 sidecar（幂等：已在运行则返回 false）。
    pub fn start(&self, app: &AppHandle) -> bool {
        start_impl(self, app)
    }

    /// 停止 sidecar：优先优雅退出（HTTP shutdown 让 Node 走 `settle()` 完整
    /// dispose agent 树），失败/超时再硬杀，最后兜底 Job Object 整树清理。
    pub fn stop(&self) {
        stop_impl(self)
    }

    /// 重启 sidecar。
    pub fn restart(&self, app: &AppHandle) -> bool {
        self.stop();
        std::thread::sleep(std::time::Duration::from_millis(300));
        self.start(app)
    }
}
