//! sidecar 启动 / 停止 / 监控线程。

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::process::SidecarManager;
use super::reclaim::reclaim_stale_sidecar;
use super::shutdown::{request_shutdown, wait_exit, GRACEFUL_EXIT_TIMEOUT};
use super::status::SidecarState;
use super::SidecarJob;

/// 监控线程进程退出轮询间隔（不持有 Child，保证 stop() 能拿到句柄）。
const MONITOR_POLL_INTERVAL: Duration = Duration::from_millis(200);

pub(super) fn start_impl(mgr: &SidecarManager, app: &AppHandle) -> bool {
    {
        let status = mgr.status.lock();
        if status.state == SidecarState::Running || status.state == SidecarState::Starting {
            return false;
        }
    }

    // 预检：上一会话可能留下仍然占用端口的孤儿 sidecar（强杀会话时未被回收）。
    // 命中自研 cos 入口（companion.ts / companion-bundle.ts）的先回收再启动；
    // 被其他进程占用则中止并给出明确提示。
    match reclaim_stale_sidecar(mgr.port()) {
        Some(true) => {
            log::warn!("端口 {} 被残留 sidecar 占用，已回收后继续启动", mgr.port());
            mgr.push_log(format!("[diver] 回收残留 sidecar (port {})", mgr.port()));
        }
        Some(false) => {
            log::error!("端口 {} 被其他进程占用，无法启动 sidecar", mgr.port());
            mgr.push_log(format!(
                "[diver] 端口 {} 被其他进程占用（非本应用 sidecar），请释放后重试",
                mgr.port()
            ));
            mgr.set_state(SidecarState::Crashed);
            return false;
        }
        None => {}
    }

    // P3 preflight：布局/profile 补丁检查；companion 失败时自动降级 safe 一次。
    let mut report = crate::plugins::preflight(app);
    if let Some(bak) = &report.quarantined {
        mgr.push_log(format!("[diver] profile 补丁已隔离: {bak}"));
    }
    if !report.ok {
        for p in &report.problems {
            log::warn!("sidecar preflight: {p}");
        }
        if !report.safe_mode {
            log::warn!("sidecar preflight 失败，自动切换 safe profile 后重试");
            mgr.push_log(
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
            mgr.push_log(format!("[diver] preflight: {:?}", report.problems));
        }
    }
    mgr.push_log(format!(
        "[diver] profile={} safe={}",
        report.profile, report.safe_mode
    ));

    // 构建启动命令：dev 用仓库内 companion.ts；release 用随包 Node +
    // companion-bundle.ts（开放 plugins/ 目录，非 SEA）。
    let mut cmd = match mgr.build_command(app) {
        Ok(cmd) => cmd,
        Err(e) => {
            log::error!("sidecar 启动失败: {e}");
            mgr.push_log(format!("[diver] 启动失败: {e}"));
            mgr.set_state(SidecarState::Crashed);
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
            mgr.push_log(format!("[diver] 启动失败: {e}"));
            mgr.set_state(SidecarState::Crashed);
            return false;
        }
    };

    mgr.stopping.store(false, Ordering::SeqCst);
    mgr.set_state(SidecarState::Starting);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *mgr.child.lock() = Some(child);

    // Windows：把 sidecar 放进 Job Object（KILL_ON_JOB_CLOSE），进程树随
    // Job 一起清理。失败仅告警——stop() 仍有显式 kill 兜底。
    #[cfg(target_os = "windows")]
    {
        let child_guard = mgr.child.lock();
        if let Some(child) = child_guard.as_ref() {
            match SidecarJob::assign(child) {
                Some(job) => {
                    log::info!("sidecar 已纳入 Job Object（KILL_ON_JOB_CLOSE）");
                    *mgr.job.lock() = Some(job);
                }
                None => {
                    log::warn!("sidecar 纳入 Job Object 失败，退出时仅能显式 kill 直系进程");
                }
            }
        }
    }

    let app_clone = app.clone();
    // 线程需要 'static 引用：单例实例经 global() 获取。
    let mgr: &'static SidecarManager = SidecarManager::global();
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

pub(super) fn stop_impl(mgr: &SidecarManager) {
    if mgr.status.lock().state == SidecarState::Stopped {
        return;
    }
    mgr.stopping.store(true, Ordering::SeqCst);
    log::info!("停止 sidecar …");

    // 用户/壳主动停止：清掉 backend 留下的重启标志（stop 无 AppHandle，
    // 用进程内缓存的 cos_home；缺失则跳过——start 也会再清一次）。
    if let Some(home) = super::paths::LAST_COS_HOME.get() {
        let _ = std::fs::remove_file(home.join("restart.requested"));
    }

    // 1) 优雅退出：POST /api/shutdown（带令牌）。sidecar 收到后走
    //    companion 的 settle() —— 关闭 HTTP/SSE、dispose 整个 agent 树。
    let requested = request_shutdown(mgr);

    // 2) 等待进程自然退出（优雅路径下 Node 自己 process.exit(0)）。
    let mut child = mgr.child.lock().take();
    let graceful = child.as_mut().map_or(false, |c| {
        wait_exit(c, GRACEFUL_EXIT_TIMEOUT)
    });

    if !graceful {
        if let Some(child) = child.as_mut() {
            if requested {
                log::warn!("sidecar 优雅退出超时，强制终止");
                mgr.push_log("[diver] sidecar 优雅退出超时，强制终止".into());
            } else {
                log::warn!("sidecar 未响应 shutdown 请求，强制终止");
            }
            let _ = child.kill();
            wait_exit(child, Duration::from_millis(1000));
        }
    }
    // 3) 显式释放 Job（KILL_ON_JOB_CLOSE → 进程树兜底清理）。
    if let Some(job) = mgr.job.lock().take() {
        drop(job);
    }
    mgr.set_state(SidecarState::Stopped);
    mgr.push_log("[diver] sidecar 已停止".into());
    log::info!("sidecar 已停止");
}
