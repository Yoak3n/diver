//! Sidecar 生命周期管理：负责启动/监控/停止 Node harness 子进程。
//!
//! sidecar 是 Node 进程，运行自研 cos harness（diver path 直连 `cos-plugins/bundle-companion`），
//! 通过 `DIVER_READY` 标志行报告就绪，随后由 WebView 通过
//! `http://127.0.0.1:{port}` 访问其自有的 HTTP/SSE 服务。
//! agent 常驻于 sidecar：窗口隐藏/销毁（轻量模式）不影响它持续运行。
//!
//! 两种形态：
//! - dev（debug 构建）：`node --import tsx <repo>/harness/packages/sidecar/src/companion.ts`，
//!   仓库内 harness 直连（cos-plugins 路径解析依赖仓库布局）。
//! - release：打包进 bundle 的 SEA 单文件 `resources/sidecar/cos-sidecar.exe`（Node 运行时 +
//!   全部插件烘焙进二进制，companion-sea 入口），cwd = resources/sidecar，
//!   COS_HOME = 用户数据目录（与安装目录隔离，升级不丢数据）。

use std::io::{BufRead, BufReader};
#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
#[cfg(not(debug_assertions))]
use tauri::Manager;

/// sidecar HTTP 服务默认端口（可用环境变量 DIVER_PORT 覆盖）。
///
/// 高位端口（动态/私有区间 49152–65535）：本服务非常驻、使用频率低，
/// 低位段易与常用服务冲突，故迁到高位；53620 取"5 + 旧 3620"便于记忆。
pub const DEFAULT_PORT: u16 = 53620;

/// 日志环形缓冲上限。
const LOG_CAPACITY: usize = 300;

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
    /// - dev（debug 构建）：`node --import tsx <repo>/harness/packages/sidecar/src/companion.ts`，
    ///   仓库内 harness（cos-plugins 路径直连依赖仓库布局），COS_HOME = harness/.cos-home。
    /// - release：打包的 SEA 单文件 `resources/sidecar/cos-sidecar.exe --bundles
    ///   resources/sidecar/bundles/bundle-companion`，cwd = resources/sidecar（cordis.yml /
    ///   secrets.yml 从那里读），COS_HOME = 用户数据目录（升级不丢数据）。
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
                .env("COS_HOME", &cos_home)
                .env("DIVER_PORT", self.port().to_string())
                .env("DIVER_UI_DIST", &ui_dist)
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
            // ── dev：仓库内 harness + node/tsx ───────────────────────────
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
            if !entry.exists() {
                return Err(format!(
                    "sidecar 入口不存在: {}（请先在根目录执行 pnpm install）",
                    entry.display()
                ));
            }

            log::info!(
                "启动 sidecar: node --import tsx {}（diver path: cos-plugins/bundle-companion, COS_HOME={}）",
                entry.display(),
                cos_home.display()
            );
            self.push_log(format!(
                "[diver] 启动: {}（diver path 直连）",
                entry.display()
            ));

            let mut cmd = Command::new(&self.node_bin);
            cmd.arg("--import")
                .arg("tsx")
                .arg("--expose-internals")
                .arg(&entry)
                .env("COS_HOME", &cos_home)
                .env("DIVER_PORT", self.port().to_string())
                .env(
                    "DIVER_MCP_CONFIG_FILE",
                    crate::config::mcp::config_path(app).to_string_lossy().to_string(),
                )
                .env(
                    "DIVER_MEMORY_PORT",
                    std::env::var("DIVER_MEMORY_PORT").unwrap_or_default(),
                )
                .current_dir(&self.harness_dir)
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
        // 命中自研 cos 入口（companion.ts / cos-sidecar.exe）的先回收再启动；
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

        // 构建启动命令：release 用打包的 SEA 单文件（cos-sidecar.exe），
        // dev 用仓库内 harness + node/tsx。
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

