//! sidecar 进程退出监控：崩溃落态与 backend 请求的自动重启。
//!
//! 监控线程不能 take() 掉 Child —— stop() 的优雅退出流程需要持有进程句柄
//! 轮询退出；这里只轮询 try_wait()，退出后由 stop() 清理句柄。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;

use super::process::SidecarManager;
use super::status::SidecarState;

/// 监控线程进程退出轮询间隔（不持有 Child，保证 stop() 能拿到句柄）。
const MONITOR_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// 自动重启前的状态收尾：进程已经退出，但监控线程还没把状态落回 Stopped。
/// 不先落状态的话，紧随其后的 `start` 会被 lifecycle 的启动幂等检查拦下，
/// 表现为「backend 请求重启后一直离线」。
pub(super) fn reset_state_before_restart(mgr: &SidecarManager) {
    mgr.set_state(SidecarState::Stopped);
    mgr.registry_gone();
}

/// 启动退出监控线程：进程退出时落态，`restart.requested` 存在则自动再拉起。
pub(super) fn spawn(mgr: &'static SidecarManager, app: AppHandle, stop_flag: Arc<AtomicBool>) {
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
            // P1-2 多实例：重启标志按本实例 COS_HOME 查（不共用 active 的）。
            let cos_home = mgr
                .cos_home()
                .unwrap_or_else(|| crate::config::cos_home(&app));
            let flag = cos_home.join("restart.requested");
            if flag.exists() {
                let _ = std::fs::remove_file(&flag);
                log::info!("sidecar 请求重启（restart.requested）→ 自动再启动");
                mgr.push_log("[diver] 检测到重启请求，正在拉起 sidecar…".into());
                reset_state_before_restart(mgr);
                mgr.emit_status(&app);
                std::thread::sleep(Duration::from_millis(300));
                if !mgr.start(&app) {
                    log::error!("sidecar 重启失败：start() 未拉起进程");
                    mgr.push_log("[diver] sidecar 重启失败，请手动重试".into());
                    mgr.set_state(SidecarState::Crashed);
                    mgr.emit_status(&app);
                }
                return;
            }
            log::warn!("sidecar 进程意外退出");
            mgr.push_log("[diver] sidecar 进程退出".into());
            mgr.registry_gone();
            mgr.set_state(SidecarState::Crashed);
            mgr.emit_status(&app);
        }
    });
}
