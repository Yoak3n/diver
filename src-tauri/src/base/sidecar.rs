//! Sidecar 生命周期管理：负责启动/监控/停止 Node harness 子进程。
//!
//! sidecar 是 Node 进程，运行自研 cos harness（统一 companion 组合：pluginPaths
//! 解析 @cos/* 核心、pluginRoot 解析开放插件目录、profile=companion 承载启停补丁）。
//! 通过 `DIVER_READY` 标志行报告就绪，随后由 WebView 通过
//! `http://127.0.0.1:{port}` 访问其自有的 HTTP/SSE 服务。
//! agent 常驻于 sidecar：窗口隐藏/销毁（轻量模式）不影响它持续运行。
//!
//! 两种形态（同一 loader 契约，已放弃 SEA 烘焙路径）：
//! - dev（debug 构建）：`node --import tsx .../companion.ts`，
//!   `--plugin-root <repo>/cos-plugins`、`--bundles .../bundle-companion`、
//!   `--harness <repo>/harness`、`--profile companion`。
//! - release：随包 Node + `companion-bundle.ts`（非 SEA）：
//!   `resources/sidecar/{node.exe,harness/,plugins/,bundles/}`，
//!   cwd = resources/sidecar，COS_HOME = 用户数据目录（升级不丢数据）。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
#[cfg(not(debug_assertions))]
use tauri::Manager;

/// 启动时缓存的 COS_HOME：stop() 清 restart 标志用（无 AppHandle）。
static LAST_COS_HOME: once_cell::sync::OnceCell<PathBuf> = once_cell::sync::OnceCell::new();

/// sidecar HTTP 服务默认端口（可用环境变量 DIVER_PORT 覆盖）。
///
/// 高位端口（动态/私有区间 49152–65535）：本服务非常驻、使用频率低，
/// 低位段易与常用服务冲突，故迁到高位；53620 取"5 + 旧 3620"便于记忆。
pub const DEFAULT_PORT: u16 = 53620;

/// 日志环形缓冲上限。
const LOG_CAPACITY: usize = 300;

/// 优雅退出等待上限：POST /api/shutdown 后轮询进程退出的最长时间。
const GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_millis(2500);

/// stop() 优雅等待阶段进程退出轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 监控线程进程退出轮询间隔（不持有 Child，保证 stop() 能拿到句柄）。
const MONITOR_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// 优雅退出令牌：每次启动 sidecar 时随机生成，经 `DIVER_SHUTDOWN_TOKEN` 环境变量
/// 注入。`stop()` 发起的 `POST /api/shutdown` 必须携带该令牌，防止 sidecar 上
/// 同源静态 UI / 本地恶意脚本把常驻 agent 进程关掉（sidecar 只监听 127.0.0.1）。
fn shutdown_token() -> &'static str {
    static TOKEN: once_cell::sync::OnceCell<String> = once_cell::sync::OnceCell::new();
    TOKEN.get_or_init(|| {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let pid = std::process::id();
        format!("diver-shutdown-{pid}-{nanos:x}")
    })
}

/// Windows：把子进程放进 Job Object，进程树随 Job 一起被清理。
///
/// 设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` —— Job 的最后一个句柄关闭时，系统
/// 强制终止 Job 内**全部**进程（含 agent 经 sh 工具拉起的 powershell 等孙进程）。
/// 这样即使应用被强杀（任务管理器结束、崩溃、`ExitRequested` 被跳过），sidecar
/// 进程树也不会变成孤儿常驻内存。
///
/// 注意：Rust 标准库的 `Child` 在子进程退出时会自动关闭进程句柄，而 Job 句柄
/// 独立持有（存进 `SidecarManager`），只要 Job 句柄未关闭就不会触发误杀。
#[cfg(target_os = "windows")]
mod job_object {
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_SET_QUOTA;
    use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;

    pub struct SidecarJob {
        handle: HANDLE,
    }

    unsafe impl Send for SidecarJob {}
    unsafe impl Sync for SidecarJob {}

    impl SidecarJob {
        pub fn assign(child: &Child) -> Option<Self> {
            unsafe {
                // 匿名 Job（无名句柄）：避免与系统里其他"同名 Job"（可能来自别的
                // Diver 实例或残留）冲突，也无需跨进程引用该名字。
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                // 先放行所有子进程（含后代）进 Job，再叠加 KILL_ON_JOB_CLOSE。
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(job);
                    return None;
                }
                // 用目标 pid 开一个带权限的句柄（Child 的进程句柄不一定带
                // PROCESS_SET_QUOTA / PROCESS_TERMINATE，Assign 会失败）。
                let pid = child.id() as u32;
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    CloseHandle(job);
                    return None;
                }
                let assigned = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if assigned == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(SidecarJob { handle: job })
            }
        }
    }

    impl Drop for SidecarJob {
        fn drop(&mut self) {
            // Job 句柄关闭 → 系统按 KILL_ON_JOB_CLOSE 终止 Job 内所有进程。
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

/// 非 Windows 平台的占位类型（SidecarManager 字段统一携带）。
#[cfg(not(target_os = "windows"))]
pub type SidecarJob = ();

/// Windows：把 Job Object 类型提升到模块可见（字段声明用）。
#[cfg(target_os = "windows")]
pub use job_object::SidecarJob;

/// release 构建时 sidecar 资源在 bundle resources 下的相对路径。
#[cfg(not(debug_assertions))]
const RELEASE_SIDECAR_DIR: &str = "sidecar";
#[cfg(not(debug_assertions))]
const RELEASE_NODE_EXE: &str = "node.exe";
#[cfg(not(debug_assertions))]
const RELEASE_ENTRY: &str = "harness/packages/sidecar/src/companion-bundle.ts";
#[cfg(not(debug_assertions))]
const RELEASE_BUNDLE_DIR: &str = "bundles/bundle-companion";
#[cfg(not(debug_assertions))]
const RELEASE_HARNESS_DIR: &str = "harness";
#[cfg(not(debug_assertions))]
const RELEASE_PLUGINS_DIR: &str = "plugins";

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
    /// Windows：sidecar 进程树所在的 Job Object（KILL_ON_JOB_CLOSE）。
    /// 持有句柄期间不触发清理；应用退出 / Job 句柄 drop 时整树被终止。
    /// 非 Windows 平台为单元类型占位。
    job: Mutex<Option<SidecarJob>>,
    #[cfg(debug_assertions)]
    harness_dir: PathBuf,
    #[cfg(debug_assertions)]
    node_bin: String,
    stopping: AtomicBool,
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
                .unwrap_or(DEFAULT_PORT);
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

    /// 构建 sidecar 启动命令。
    fn build_command(&self, app: &AppHandle) -> Result<Command, String> {
        #[cfg(not(debug_assertions))]
        {
            // ── release：随包 node + tsx 启动 companion-bundle.ts ────────
            // Tauri 在 Windows 上把 resources 打包到 <exe_dir>/resources/，
            // 而 resource_dir() 返回 exe 所在目录，需再拼 resources 前缀。
            let res_dir = app
                .path()
                .resource_dir()
                .map_err(|e| format!("无法解析资源目录: {e}"))?
                .join("resources");
            let sidecar_dir = res_dir.join(RELEASE_SIDECAR_DIR);
            let node_exe = sidecar_dir.join(RELEASE_NODE_EXE);
            if !node_exe.exists() {
                return Err(format!(
                    "随包 Node 不存在: {}（请先执行 pnpm bundle:release 构建安装包）",
                    node_exe.display()
                ));
            }

            // 首次运行：解压 node_modules 归档（打包时 node_modules → *.tar，
            // 见 bundle-release.mjs；NSIS 只复制大文件，安装极快）。
            // extract-deps.mjs 幂等（marker 检查），已解压则秒过。
            let extract_script = sidecar_dir.join("extract-deps.mjs");
            if extract_script.exists()
                && (sidecar_dir.join("node_modules.tar").exists()
                    || sidecar_dir.join("harness/node_modules.tar").exists()
                    || sidecar_dir.join("plugins/node_modules.tar").exists())
            {
                log::info!("首次运行：解压 node_modules 归档 …");
                self.push_log("[diver] 首次运行：解压依赖…".into());
                let clean = |p: &std::path::Path| -> String {
                    p.to_string_lossy().trim_start_matches("\\\\?\\").to_string()
                };
                let status = Command::new(&node_exe)
                    .arg(clean(&extract_script))
                    .current_dir(&sidecar_dir)
                    .stdin(Stdio::null())
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .status();
                match status {
                    Ok(s) if s.success() => {
                        log::info!("node_modules 解压完成");
                        self.push_log("[diver] 依赖解压完成".into());
                    }
                    Ok(s) => {
                        log::warn!("依赖解压返回异常状态: {:?}（继续启动，可能因缺依赖失败）", s.code());
                    }
                    Err(e) => {
                        log::warn!("依赖解压失败: {e}（继续启动，可能因缺依赖失败）");
                    }
                }
            }
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
            self.push_log(format!("[diver] 启动 sidecar (随包 Node)"));

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

    /// 启动 sidecar（幂等：已在运行则返回 false）。
    pub fn start(&self, app: &AppHandle) -> bool {
        {
            let status = self.status.lock();
            if status.state == SidecarState::Running || status.state == SidecarState::Starting {
                return false;
            }
        }

        // 预检：上一会话可能留下仍然占用端口的孤儿 sidecar（强杀会话时未被回收）。
        // 命中自研 cos 入口（companion.ts / companion-bundle.ts）的先回收再启动；
        // 被其他进程占用则中止并给出明确提示。
        match Self::reclaim_stale_sidecar(self.port()) {
            Some(true) => {
                log::warn!("端口 {} 被残留 sidecar 占用，已回收后继续启动", self.port());
                self.push_log(format!("[diver] 回收残留 sidecar (port {})", self.port()));
            }
            Some(false) => {
                log::error!("端口 {} 被其他进程占用，无法启动 sidecar", self.port());
                self.push_log(format!(
                    "[diver] 端口 {} 被其他进程占用（非本应用 sidecar），请释放后重试",
                    self.port()
                ));
                self.set_state(SidecarState::Crashed);
                return false;
            }
            None => {}
        }

        // P3 preflight：布局/profile 补丁检查；companion 失败时自动降级 safe 一次。
        let mut report = crate::plugins::preflight(app);
        if let Some(bak) = &report.quarantined {
            self.push_log(format!("[diver] profile 补丁已隔离: {bak}"));
        }
        if !report.ok {
            for p in &report.problems {
                log::warn!("sidecar preflight: {p}");
            }
            if !report.safe_mode {
                log::warn!("sidecar preflight 失败，自动切换 safe profile 后重试");
                self.push_log(
                    "[diver] companion 预检失败 → 自动 safe 模式（仅核心 + backend）".into(),
                );
                if crate::config::profile::set_active_profile(app, crate::plugins::SAFE_PROFILE) {
                    report = crate::plugins::preflight(app);
                }
            }
            if !report.ok {
                log::error!(
                    "sidecar preflight 仍失败: {:?}（继续尝试启动，boot 可能自行报错）",
                    report.problems
                );
                self.push_log(format!("[diver] preflight: {:?}", report.problems));
            }
        }
        self.push_log(format!(
            "[diver] profile={} safe={}",
            report.profile, report.safe_mode
        ));

        // 构建启动命令：dev 用仓库内 companion.ts；release 用随包 Node +
        // companion-bundle.ts（开放 plugins/ 目录，非 SEA）。
        let mut cmd = match self.build_command(app) {
            Ok(cmd) => cmd,
            Err(e) => {
                log::error!("sidecar 启动失败: {e}");
                self.push_log(format!("[diver] 启动失败: {e}"));
                self.set_state(SidecarState::Crashed);
                return false;
            }
        };

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

        // Windows：把 sidecar 放进 Job Object（KILL_ON_JOB_CLOSE），进程树随
        // Job 一起清理。失败仅告警——stop() 仍有显式 kill 兜底。
        #[cfg(target_os = "windows")]
        {
            let child_guard = self.child.lock();
            if let Some(child) = child_guard.as_ref() {
                match job_object::SidecarJob::assign(child) {
                    Some(job) => {
                        log::info!("sidecar 已纳入 Job Object（KILL_ON_JOB_CLOSE）");
                        *self.job.lock() = Some(job);
                    }
                    None => {
                        log::warn!("sidecar 纳入 Job Object 失败，退出时仅能显式 kill 直系进程");
                    }
                }
            }
        }

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
                        // 后端就绪通知：前端 waitForSidecarReady() 收到该事件后
                        // 即可发起 /api 请求（修复 WebView 先于 sidecar 挂载的启动竞态）。
                        let _ = app_clone.emit("backend://ready", mgr.status());
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

        // 监控线程：进程退出时更新状态（除非是主动停止）。
        // 注意：不能 take() 掉 Child —— stop() 的优雅退出流程需要持有进程句柄
        // 轮询退出；这里只轮询 try_wait()，退出后由 stop() 清理句柄。
        let app_clone = app.clone();
        let stop_flag = stop_flag.clone();
        std::thread::spawn(move || {
            loop {
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                let exited = {
                    let mut guard = mgr.child.lock();
                    match guard.as_mut() {
                        Some(child) => child.try_wait().ok().flatten().is_some(),
                        None => true,
                    }
                };
                if exited {
                    break;
                }
                std::thread::sleep(MONITOR_POLL_INTERVAL);
            }
            if !mgr.stopping.load(Ordering::SeqCst) {
                // backend 请求的业务重启：见 $COS_HOME/restart.requested 则自动再拉起。
                let cos_home = crate::config::cos_home(&app_clone);
                let flag = cos_home.join("restart.requested");
                if flag.exists() {
                    let _ = std::fs::remove_file(&flag);
                    log::info!("sidecar 请求重启（restart.requested）→ 自动再启动");
                    mgr.push_log("[diver] 检测到重启请求，正在拉起 sidecar…".into());
                    std::thread::sleep(Duration::from_millis(300));
                    mgr.start(&app_clone);
                    return;
                }
                log::warn!("sidecar 进程意外退出");
                mgr.push_log("[diver] sidecar 进程退出".into());
                mgr.set_state(SidecarState::Crashed);
                mgr.emit_status(&app_clone);
            }
        });

        true
    }

    /// 停止 sidecar：优先优雅退出（HTTP shutdown 让 Node 走 `settle()` 完整
    /// dispose agent 树），失败/超时再硬杀，最后兜底 Job Object 整树清理。
    pub fn stop(&self) {
        if self.status.lock().state == SidecarState::Stopped {
            return;
        }
        self.stopping.store(true, Ordering::SeqCst);
        log::info!("停止 sidecar …");

        // 用户/壳主动停止：清掉 backend 留下的重启标志（stop 无 AppHandle，
        // 用进程内缓存的 cos_home；缺失则跳过——start 也会再清一次）。
        if let Some(home) = LAST_COS_HOME.get() {
            let _ = std::fs::remove_file(home.join("restart.requested"));
        }

        // 1) 优雅退出：POST /api/shutdown（带令牌）。sidecar 收到后走
        //    companion 的 settle() —— 关闭 HTTP/SSE、dispose 整个 agent 树。
        let requested = self.request_shutdown();

        // 2) 等待进程自然退出（优雅路径下 Node 自己 process.exit(0)）。
        let mut child = self.child.lock().take();
        let graceful = child.as_mut().map_or(false, |c| {
            self.wait_exit(c, GRACEFUL_EXIT_TIMEOUT)
        });

        if !graceful {
            if let Some(child) = child.as_mut() {
                if requested {
                    log::warn!("sidecar 优雅退出超时，强制终止");
                    self.push_log("[diver] sidecar 优雅退出超时，强制终止".into());
                } else {
                    log::warn!("sidecar 未响应 shutdown 请求，强制终止");
                }
                let _ = child.kill();
                self.wait_exit(child, Duration::from_millis(1000));
            }
        }
        // 3) 显式释放 Job（KILL_ON_JOB_CLOSE → 进程树兜底清理）。
        if let Some(job) = self.job.lock().take() {
            drop(job);
        }
        self.set_state(SidecarState::Stopped);
        self.push_log("[diver] sidecar 已停止".into());
        log::info!("sidecar 已停止");
    }

    /// 向 sidecar 发起优雅退出请求。返回是否成功发出（不代表已退出）。
    fn request_shutdown(&self) -> bool {
        let port = self.port();
        let token = shutdown_token();
        let url = format!("http://127.0.0.1:{port}/api/shutdown");
        let body = format!(r#"{{"token":"{token}"}}"#);
        // curl：Windows 10 1803+ 系统自带 curl.exe；NUL 是 Windows 的空设备。
        #[cfg(target_os = "windows")]
        const NULL_DEV: &str = "NUL";
        #[cfg(not(target_os = "windows"))]
        const NULL_DEV: &str = "/dev/null";
        match Command::new("curl")
            .args(["-s", "-o", NULL_DEV, "-w", "%{http_code}", "-m", "2"])
            .arg("-X").arg("POST")
            .arg("-H").arg("Content-Type: application/json")
            .arg("-d").arg(&body)
            .arg(&url)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        {
            Ok(out) => {
                let code = String::from_utf8_lossy(&out.stdout).trim().to_string();
                log::info!("sidecar shutdown 请求返回 HTTP {code}");
                code == "200"
            }
            Err(e) => {
                log::warn!("sidecar shutdown 请求失败: {e}");
                false
            }
        }
    }

    /// 轮询等待子进程退出，超时返回 false。
    fn wait_exit(&self, child: &mut std::process::Child, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) => {}
                Err(_) => return false,
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    /// 重启 sidecar。
    pub fn restart(&self, app: &AppHandle) -> bool {
        self.stop();
        std::thread::sleep(Duration::from_millis(300));
        self.start(app)
    }

    /// Windows: 预检并回收上一会话残留、仍占用 `port` 的自研 cos sidecar。
    ///
    /// 通过 PowerShell 查询端口监听者：命令行匹配 `companion.ts` /
    /// `companion-bundle.ts` 的进程视为本应用的孤儿 sidecar（强杀会话时未被
    /// 回收），杀死后放行启动；端口被其他进程占用时返回 `Some(false)`，由调用方
    /// 中止启动并给出明确日志。端口空闲、非 Windows 或探测失败返回 `None`（放行）。
    #[cfg(target_os = "windows")]
    fn reclaim_stale_sidecar(port: u16) -> Option<bool> {
        let script = format!(
            "$conns = Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue; \
             if (-not $conns) {{ exit 0 }}; \
             $found = $false; \
             foreach ($conn in $conns) {{ \
                 $procId = $conn.OwningProcess; \
                 $proc = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $procId) -ErrorAction SilentlyContinue; \
                 if ($proc -and ($proc.CommandLine -like '*companion.ts*' -or $proc.CommandLine -like '*companion-bundle.ts*')) {{ \
                     Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue; \
                     Write-Output ('RECLAIM ' + $procId); \
                     $found = $true \
                 }} \
             }}; \
             if (-not $found) {{ Write-Output 'FOREIGN' }}"
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.contains("RECLAIM") {
            Some(true)
        } else if stdout.contains("FOREIGN") {
            Some(false)
        } else {
            None
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn reclaim_stale_sidecar(_port: u16) -> Option<bool> {
        None
    }

    fn emit_status(&self, app: &AppHandle) {
        let status = self.status();
        let _ = app.emit("sidecar://status", status);
    }
}

