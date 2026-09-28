//! Explore job 生命周期：启动后的后台等待（轮询）与取消（USER_CHAT 打断）。

use std::time::Duration;

use diver_presence::Event;
use serde_json::json;

use crate::core::presence::PresenceHandle;

use super::log_fmt;
use super::rpc::{api_base, http_json};

/// 取消当前 explore job（USER_CHAT / 壳侧打断）。
pub fn cancel_active_job() {
    let job_id = PresenceHandle::active().with(|p| {
        let id = p.explore_policy().job_id().map(|s| s.to_string());
        p.explore_policy().release();
        id
    });
    if let Some(job_id) = job_id {
        let base = api_base();
        tauri::async_runtime::spawn(async move {
            let url = format!("{base}/api/memory/explore/{job_id}/cancel");
            match http_json("POST", &url, Some(json!({}))).await {
                Ok(_) => log::info!("[explore] 已取消 job {job_id}"),
                Err(e) => log::warn!("[explore] 取消 job 失败: {e}"),
            }
        });
    }
}

/// 后台等待 job 完成 / 被打断（2s 轮询，最多约 3 分钟；超时取消兜底）。
pub(super) fn spawn_waiter(job_id: String) {
    tauri::async_runtime::spawn(async move {
        let base = api_base();
        let url = format!("{base}/api/memory/explore/{job_id}");
        let mut poll_fails = 0u32;
        for _ in 0..180 {
            // 最多约 3 分钟
            tokio::time::sleep(Duration::from_secs(2)).await;
            // 被壳 release（USER_CHAT）则停等，job 已 cancel
            let still = PresenceHandle::active().with(|p| p.explore_policy().job_id() == Some(job_id.as_str()));
            if !still {
                return;
            }
            match http_json("GET", &url, None).await {
                Ok(val) => {
                    let state = val.get("state").and_then(|v| v.as_str()).unwrap_or("");
                    if state == "done" || state == "error" || state == "cancelled" {
                        log::info!("[explore] job {job_id} → {}", log_fmt::job_summary(state, &val));
                        PresenceHandle::active().with(|p| p.explore_policy().release());
                        PresenceHandle::active().apply_event(Event::ExploreEnd);
                        return;
                    }
                }
                Err(e) => {
                    poll_fails += 1;
                    // 只告警首次，避免 2s 轮询刷屏
                    if poll_fails == 1 {
                        log::warn!("[explore] 轮询 job {job_id} 失败: {e}");
                    } else {
                        log::debug!("[explore] 轮询失败（第 {poll_fails} 次）: {e}");
                    }
                }
            }
        }
        // 超时兜底
        log::warn!("[explore] job {job_id} 等待超时（3min），取消");
        cancel_active_job();
        PresenceHandle::active().apply_event(Event::ExploreEnd);
    });
}
