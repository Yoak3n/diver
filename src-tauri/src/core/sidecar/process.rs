//! SidecarManager：进程生命周期（启动/停止/重启/监控）。

use std::io::{BufRead, BufReader};
#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::process::Child;
#[cfg(target_os = "windows")]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use super::paths::{shutdown_token, DEFAULT_PORT, LAST_COS_HOME};
use super::status::{SidecarState, SidecarStatus, LOG_CAPACITY};
use super::SidecarJob;

/// 优雅退出等待上限：POST /api/shutdown 后轮询进程退出的最长时间。
const GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_millis(2500);

/// stop() 优雅等待阶段进程退出轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 监控线程进程退出轮询间隔（不持有 Child，保证 stop() 能拿到句柄）。
const MONITOR_POLL_INTERVAL: Duration = Duration::from_millis(200);

pub struct SidecarManager {
    child: Mutex<Option<Child>>,
    status: Mutex<SidecarStatus>,
    /// Windows：sidecar 进程树所在的 Job Object（KILL_ON_JOB_CLOSE）。
    /// 持有句柄期间不触发清理；应用退出 / Job 句柄 drop 时整树被终止。
    /// 非 Windows 平台为单元类型占位。
    job: Mutex<Option<SidecarJob>>,
    #[cfg(debug_assertions)]
    pub(super) harness_dir: PathBuf,
    #[cfg(debug_assertions)]
    pub(super) node_bin: String,
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

    pub(super) fn push_log(&self, line: String) {
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
                match SidecarJob::assign(child) {
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
    ///
    /// 纯 TCP HTTP POST：不依赖 curl（部分 Windows 无 curl.exe），也不起
    /// 子进程（避免 GUI 下弹控制台黑窗），与 `init.rs` 健康探测同一思路。
    fn request_shutdown(&self) -> bool {
        use std::io::{Read, Write};
        use std::net::TcpStream;

        let port = self.port();
        let token = shutdown_token();
        let body = format!(r#"{{"token":"{token}"}}"#);
        let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
            log::warn!("sidecar shutdown 请求失败: 无法连接 127.0.0.1:{port}");
            return false;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
        let req = format!(
            "POST /api/shutdown HTTP/1.1\r\n\
             Host: 127.0.0.1:{port}\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             \r\n\
             {body}",
            body.len()
        );
        if stream.write_all(req.as_bytes()).is_err() {
            log::warn!("sidecar shutdown 请求失败: 写入失败");
            return false;
        }
        let mut buf = [0u8; 512];
        let n = stream.read(&mut buf).unwrap_or(0);
        let text = String::from_utf8_lossy(&buf[..n]);
        let ok = text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200");
        if ok {
            log::info!("sidecar shutdown 请求返回 HTTP 200");
        } else {
            let status = text.lines().next().unwrap_or("").to_string();
            log::warn!("sidecar shutdown 请求返回: {status}");
        }
        ok
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
    /// Windows: 端口占用时才做残留回收（避免首启弹 PowerShell 黑窗）。
    ///
    /// 端口空闲（bind 成功）→ `None` 放行；被占用 → 尝试按 companion 命令行
    /// 回收孤儿 sidecar，否则 `Some(false)` 中止。
    #[cfg(target_os = "windows")]
    fn reclaim_stale_sidecar(port: u16) -> Option<bool> {
        // 纯 Rust 探测端口：空闲则绝不起子进程（首启零黑窗）。
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return None;
        }
        log::warn!("端口 {port} 被占用，尝试回收残留 sidecar");
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
        let mut c = Command::new("powershell");
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let output = c
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
            Some(false)
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
