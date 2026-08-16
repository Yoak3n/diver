//! Sidecar 生命周期管理：负责启动/监控/停止 Node harness 子进程。
//!
//! sidecar 是 Node 进程，运行 dsh 框架（`--profile companion`），
//! 通过 `DIVER_READY` 标志行报告就绪，随后由 WebView 通过
//! `http://127.0.0.1:{port}` 访问其自有的 HTTP/SSE 服务。
//! agent 常驻于 sidecar：窗口隐藏/销毁（轻量模式）不影响它持续运行。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// sidecar HTTP 服务默认端口（可用环境变量 DIVER_PORT 覆盖）。
pub const DEFAULT_PORT: u16 = 3620;

/// 日志环形缓冲上限。
const LOG_CAPACITY: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SidecarState {
    Stopped,
    Starting,
    Running,
    Crashed,
}

#[derive(Debug, Clone, Serialize)]
pub struct SidecarStatus {
    pub state: SidecarState,
    pub port: u16,
    /// 最近日志（新→旧）。
    pub logs: Vec<String>,
}

pub struct SidecarManager {
    child: Mutex<Option<Child>>,
    status: Mutex<SidecarStatus>,
    harness_dir: PathBuf,
    node_bin: String,
    stopping: AtomicBool,
}

impl SidecarManager {
    pub fn global() -> &'static Self {
        static INSTANCE: OnceCell<SidecarManager> = OnceCell::new();
        INSTANCE.get_or_init(|| {
            let harness_dir = std::env::var("DIVER_HARNESS_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    // 默认相对仓库布局：src-tauri 的上一级目录下的 harness/
                    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                    manifest.parent().unwrap_or(&manifest).join("harness")
                });
            let node_bin = std::env::var("DIVER_NODE_BIN").unwrap_or_else(|_| "node".into());
            let port = std::env::var("DIVER_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_PORT);
            SidecarManager {
                child: Mutex::new(None),
                status: Mutex::new(SidecarStatus {
                    state: SidecarState::Stopped,
                    port,
                    logs: Vec::new(),
                }),
                harness_dir,
                node_bin,
                stopping: AtomicBool::new(false),
            }
        })
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

    fn push_log(&self, line: String) {
        let mut status = self.status.lock();
        status.logs.insert(0, line);
        status.logs.truncate(LOG_CAPACITY);
    }

    fn set_state(&self, state: SidecarState) {
        self.status.lock().state = state;
    }

    /// 启动 sidecar（幂等：已在运行则返回 false）。
    pub fn start(&self, app: &AppHandle) -> bool {
        {
            let status = self.status.lock();
            if status.state == SidecarState::Running || status.state == SidecarState::Starting {
                return false;
            }
        }

        let bin_js = self
            .harness_dir
            .join("node_modules/@deepseek-ai/dsh/lib/bin.js");
        let bin_js = if bin_js.exists() {
            bin_js
        } else {
            // pnpm workspace 布局：依赖可能提升到仓库根 node_modules
            self.harness_dir
                .parent()
                .unwrap_or(&self.harness_dir)
                .join("node_modules/@deepseek-ai/dsh/lib/bin.js")
        };
        let dsh_home = self.harness_dir.join(".dsh-home");
        if !bin_js.exists() {
            log::error!(
                "sidecar 入口不存在: {}（请先在根目录执行 pnpm install）",
                bin_js.display()
            );
            self.push_log(format!("[diver] harness 未安装: {}", bin_js.display()));
            self.set_state(SidecarState::Crashed);
            return false;
        }

        log::info!(
            "启动 sidecar: {} --profile companion (DSH_HOME={})",
            bin_js.display(),
            dsh_home.display()
        );
        self.push_log(format!(
            "[diver] 启动: {} --profile companion",
            bin_js.display()
        ));

        let mut cmd = Command::new(&self.node_bin);
        cmd.arg(&bin_js)
            .arg("--profile")
            .arg("companion")
            .env("DSH_HOME", &dsh_home)
            .env("DIVER_PORT", self.port().to_string())
            .env(
                "DIVER_MEMORY_PORT",
                std::env::var("DIVER_MEMORY_PORT").unwrap_or_default(),
            )
            .current_dir(&self.harness_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                log::error!("sidecar 启动失败: {e}");
                self.push_log(format!("[diver] 启动失败: {e}"));
                self.set_state(SidecarState::Crashed);
                return false;
            }
        };

        self.stopping.store(false, Ordering::SeqCst);
        self.set_state(SidecarState::Starting);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        *self.child.lock() = Some(child);

        let app_clone = app.clone();
        // 线程需要 'static 引用：单例实例经 global() 获取。
        let mgr: &'static SidecarManager = Self::global();
        let stop_flag = Arc::new(AtomicBool::new(false));

        // stdout 读取线程：日志 + 就绪检测
        let flag = stop_flag.clone();
        std::thread::spawn(move || {
            if let Some(stream) = stdout {
                let reader = BufReader::new(stream);
                for line in reader.lines() {
                    if flag.load(Ordering::SeqCst) {
                        break;
                    }
                    let line = line.unwrap_or_default();
                    mgr.push_log(line.clone());
                    // 实时转发 sidecar 日志到 diver 控制台（调试：压缩/记忆等 dsh 层日志）
                    println!("[sidecar] {}", line);
                    if line.contains("DIVER_READY") {
                        log::info!("sidecar 就绪 (port {})", mgr.port());
                        mgr.push_log("[diver] 就绪 ✓".into());
                        mgr.set_state(SidecarState::Running);
                        mgr.emit_status(&app_clone);
                    }
                }
            }
        });

        // stderr 读取线程：日志
        let flag = stop_flag.clone();
        std::thread::spawn(move || {
            if let Some(stream) = stderr {
                let reader = BufReader::new(stream);
                for line in reader.lines() {
                    if flag.load(Ordering::SeqCst) {
                        break;
                    }
                    let line = line.unwrap_or_default();
                    mgr.push_log(line.clone());
                    // 实时转发 sidecar stderr 到 diver 控制台（dsh logger 走 stderr）
                    println!("[sidecar:err] {}", line);
                }
            }
        });

        // 监控线程：进程退出时更新状态（除非是主动停止）
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let child = mgr.child.lock().take();
            if let Some(mut child) = child {
                let _ = child.wait();
                if !mgr.stopping.load(Ordering::SeqCst) {
                    log::warn!("sidecar 进程意外退出");
                    mgr.push_log("[diver] sidecar 进程退出".into());
                    mgr.set_state(SidecarState::Crashed);
                    mgr.emit_status(&app_clone);
                }
            }
        });

        true
    }

    /// 停止 sidecar。
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let mut guard = self.child.lock();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.set_state(SidecarState::Stopped);
    }

    /// 重启 sidecar。
    pub fn restart(&self, app: &AppHandle) -> bool {
        self.stop();
        std::thread::sleep(Duration::from_millis(300));
        self.start(app)
    }

    fn emit_status(&self, app: &AppHandle) {
        let status = self.status();
        let _ = app.emit("sidecar://status", status);
    }
}
