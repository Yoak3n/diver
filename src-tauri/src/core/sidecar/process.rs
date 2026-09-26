//! SidecarManager：进程句柄、状态快照与生命周期入口。
//!
//! 启动/停止细节见 `lifecycle`；优雅退出见 `shutdown`；端口回收见 `reclaim`。

use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::AtomicBool;

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
    /// 实例注册表定位（P1-2）：就绪登记 / 退出注销。
    pub(super) registry: Mutex<Option<crate::core::instance_registry::RegistryTarget>>,
    /// 本实例 COS_HOME（P1-2 多实例；启动前注入，COS_HOME / 重启标志清理用）。
    pub(super) home: Mutex<Option<PathBuf>>,
}

impl SidecarManager {
    /// active 实例的 manager（P1-2 起由 [`super::runtimes::Runtimes`] 管理，
    /// 进程级常驻；单实例形态与旧全局单例等价）。
    pub fn global() -> &'static Self {
        super::runtimes::Runtimes::global().active()
    }

    /// 构造 active 实例 manager（端口走协商语义：显式 DIVER_PORT 固定，否则随机预选）。
    pub fn new() -> Self {
        Self::with_port(super::ports::resolve_port())
    }

    /// 构造指定端口的 manager（附加实例一律随机端口，不消费显式固定端口）。
    pub fn with_port(port: u16) -> Self {
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
        SidecarManager {
            child: Mutex::new(None),
            status: Mutex::new(SidecarStatus {
                // 实例 id 由 status() 从注册表定位盖章（构造早于 set_registry_target）。
                id: String::new(),
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
            registry: Mutex::new(None),
            home: Mutex::new(None),
        }
    }

    /// 注入实例注册表定位（app 组装，启动前调用一次）。
    pub fn set_registry_target(&self, target: crate::core::instance_registry::RegistryTarget) {
        *self.registry.lock() = Some(target);
    }

    /// 实例 id（注册表定位携带；未设置时 `None`）。
    pub fn instance_id(&self) -> Option<String> {
        self.registry.lock().as_ref().map(|t| t.id.clone())
    }

    /// 本实例 COS_HOME（未注入时 `None`，调用方回退 active 实例路径）。
    pub fn cos_home(&self) -> Option<PathBuf> {
        self.home.lock().clone()
    }

    /// 注入本实例 COS_HOME（app 组装，启动前调用）。
    pub fn set_cos_home(&self, home: PathBuf) {
        *self.home.lock() = Some(home);
    }

    /// 就绪时登记注册表（幂等覆盖写）。
    pub(super) fn registry_ready(&self, port: u16) {
        let Some(target) = self.registry.lock().clone() else {
            return;
        };
        let pid = self.child.lock().as_ref().map(|c| c.id()).unwrap_or(0);
        match crate::core::instance_registry::register(&target, pid, port) {
            Ok(()) => log::info!("实例注册表登记 {} (pid={pid}, port={port})", target.id),
            Err(e) => log::warn!("实例注册表写入失败: {e}"),
        }
    }

    /// 退出 / 崩溃时注销注册表。
    pub(super) fn registry_gone(&self) {
        if let Some(target) = self.registry.lock().clone() {
            crate::core::instance_registry::deregister(&target);
        }
    }

    /// 注入启动期跨层能力（app/setup 调用一次）。
    pub fn set_hooks(&self, hooks: LaunchHooks) {
        *self.hooks.lock() = Some(hooks);
    }

    /// 当前状态快照（P2-3：盖章实例 id，供多实例 UI 过滤）。
    pub fn status(&self) -> SidecarStatus {
        let mut status = self.status.lock().clone();
        status.id = self.instance_id().unwrap_or_default();
        status
    }

    pub fn port(&self) -> u16 {
        self.status.lock().port
    }

    /// 就绪行回报的实际端口（与预选不一致时更正，以 Node 为准）。
    pub(super) fn set_port(&self, port: u16) {
        self.status.lock().port = port;
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
        // P2-3 多实例 UI：全实例广播，payload 带 id，前端按 id 过滤。
        let status = self.status();
        let _ = app.emit("sidecar://status", status);
    }

    /// 启动 sidecar（幂等：已在运行则返回 false）。
    /// `&'static`：监控线程绑定 self，manager 进程级常驻（Runtimes 登记）。
    pub fn start(self: &'static Self, app: &AppHandle) -> bool {
        start_impl(self, app)
    }

    /// 停止 sidecar：优先优雅退出（HTTP shutdown 让 Node 走 `settle()` 完整
    /// dispose agent 树），失败/超时再硬杀，最后兜底 Job Object 整树清理。
    pub fn stop(&self) {
        stop_impl(self)
    }

    /// 重启 sidecar。
    pub fn restart(self: &'static Self, app: &AppHandle) -> bool {
        self.stop();
        std::thread::sleep(std::time::Duration::from_millis(300));
        self.start(app)
    }
}
