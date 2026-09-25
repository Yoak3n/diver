//! ExplorePolicy 壳驱动（设计 §7.4 / 切片 4）。
//!
//! 控制面：何时探索、探索哪个词 —— 本模块 tick 裁决 + L1/L2 request。
//! 执行面：sidecar `POST /api/memory/explore`（memory.explore → web-tools）。
//! 打断：USER_CHAT → 取消 job + EXPLORE_END（FSM T13 已迁 Listening）。

use std::time::Duration;

use diver_presence::{Event, RequestResult, WebExploreReason};
use serde_json::{json, Value};

use crate::core::presence::PresenceHandle;

mod log_fmt;

fn api_base() -> String {
    crate::core::sidecar::SidecarManager::global().api_base_url()
}

async fn http_json(method: &str, url: &str, body: Option<Value>) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let builder = match method {
        "GET" => client.get(url),
        "POST" => client.post(url),
        other => return Err(format!("unsupported method: {other}")),
    };
    let builder = match body {
        Some(b) => builder.json(&b),
        None => builder,
    };
    let res = builder
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let val = res
        .json::<Value>()
        .await
        .map_err(|e| format!("response parse failed: {e}"))?;
    if !status.is_success() && status.as_u16() != 202 {
        return Err(format!("HTTP {status}: {val}"));
    }
    Ok(val)
}

/// 取消当前 explore job（USER_CHAT / 壳侧打断）。
pub fn cancel_active_job() {
    let job_id = PresenceHandle::global().with(|p| {
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

/// 拉候选词并尝试启动一次探索。
async fn try_start_explore() {
    let base = api_base();

    // 1) 壳策略：到点了吗？
    let now = diver_presence::types::now_ms();
    let wake = PresenceHandle::global().with(|p| p.explore_should_wake(now));
    if !wake {
        log::debug!("[explore] tick：未到点，跳过");
        return;
    }
    log::info!("[explore] 到点，拉取候选词");

    // 2) 记忆只读取词
    let terms_val = match http_json("GET", &format!("{base}/api/memory/pick-terms?limit=5"), None).await
    {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[explore] pick-terms 失败: {e}");
            return;
        }
    };
    let Some(terms) = terms_val.get("terms").and_then(|t| t.as_array()) else {
        log::warn!("[explore] pick-terms 响应缺少 terms 字段");
        return;
    };
    if terms.is_empty() {
        log::info!("[explore] 无候选词，本次跳过");
        return;
    }
    log::info!("[explore] 候选 {}: {}", terms.len(), log_fmt::candidates_line(terms));

    // 3) 逐个候选走 L1+L2（TermRepeat 会跳过）
    for item in terms {
        let term = item.get("term").and_then(|v| v.as_str()).unwrap_or("").trim();
        if term.is_empty() {
            continue;
        }
        let from_memory_id = item
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let now = diver_presence::types::now_ms();
        let sleep = PresenceHandle::global().with(|p| p.snapshot(now).regime == "sleep");
        let reason = if sleep {
            WebExploreReason::Sleep
        } else {
            WebExploreReason::LongIdle
        };

        let (result, job) = PresenceHandle::global().with(|p| {
            p.request_web_explore(term, reason, from_memory_id.clone(), now)
        });
        if !result.is_ok() {
            log::info!("[explore] 跳过「{term}」: {result:?}");
            continue;
        }
        let Some(job) = job else { continue };

        // L0：EXPLORE_START → Solitary/Exploring（T20）
        PresenceHandle::global().apply_event(Event::ExploreStart);

        let body = json!({
            "term": job.term,
            "reason": job.reason.as_str(),
            "fromMemoryId": job.from_memory_id,
            "hint": job.hint,
        });
        match http_json("POST", &format!("{base}/api/memory/explore"), Some(body)).await {
            Ok(val) => {
                let job_id = val
                    .get("jobId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                log::info!(
                    "[explore] 启动 job {job_id} term={} reason={}",
                    job.term,
                    job.reason.as_str()
                );
                PresenceHandle::global().with(|p| p.explore_policy().set_job_id(job_id.clone()));
                // 后台等待完成 / 被打断
                spawn_waiter(job_id);
                return; // 一次只起一个
            }
            Err(e) => {
                log::warn!("[explore] POST /api/memory/explore 失败: {e}");
                PresenceHandle::global().with(|p| p.explore_policy().release());
                PresenceHandle::global().apply_event(Event::ExploreEnd);
            }
        }
    }
}

fn spawn_waiter(job_id: String) {
    tauri::async_runtime::spawn(async move {
        let base = api_base();
        let url = format!("{base}/api/memory/explore/{job_id}");
        let mut poll_fails = 0u32;
        for _ in 0..180 {
            // 最多约 3 分钟
            tokio::time::sleep(Duration::from_secs(2)).await;
            // 被壳 release（USER_CHAT）则停等，job 已 cancel
            let still = PresenceHandle::global().with(|p| p.explore_policy().job_id() == Some(job_id.as_str()));
            if !still {
                return;
            }
            match http_json("GET", &url, None).await {
                Ok(val) => {
                    let state = val.get("state").and_then(|v| v.as_str()).unwrap_or("");
                    if state == "done" || state == "error" || state == "cancelled" {
                        log::info!("[explore] job {job_id} → {}", log_fmt::job_summary(state, &val));
                        PresenceHandle::global().with(|p| p.explore_policy().release());
                        PresenceHandle::global().apply_event(Event::ExploreEnd);
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
        PresenceHandle::global().apply_event(Event::ExploreEnd);
    });
}

/// 启动 Explore 壳调度（进程级 tick，与 presence_schedule 同风格）。
pub fn spawn_explore_scheduler() {
    std::thread::spawn(|| {
        log::info!("[explore] 壳端 ExplorePolicy 调度启动（45s tick）");
        loop {
            let _ = tauri::async_runtime::block_on(async {
                try_start_explore().await
            });
            std::thread::sleep(Duration::from_secs(45));
        }
    });
}

/// 调试：当前策略快照。
pub fn snapshot_json() -> Value {
    PresenceHandle::global().with(|p| {
        let s = p.explore_policy().snapshot();
        json!({
            "lastExploreAt": s.last_explore_at,
            "dailyUsed": s.daily_used,
            "maxPerDay": s.max_per_day,
            "active": s.active,
            "pendingTerm": s.pending_term,
            "recentTerms": s.recent_terms,
            "jobId": p.explore_policy().job_id(),
        })
    })
}

/// 调试/手动触发：强制启动一次（仍走 L1+L2）。
pub async fn trigger_manual(term: &str, reason: &str) -> Result<Value, String> {
    let now = diver_presence::types::now_ms();
    let reason = match reason {
        "curiosity" => WebExploreReason::Curiosity,
        "sleep" => WebExploreReason::Sleep,
        _ => WebExploreReason::LongIdle,
    };
    log::info!("[explore] 手动触发「{term}」 reason={}", reason.as_str());
    let (result, job) = PresenceHandle::global().with(|p| {
        p.request_web_explore(term, reason, None, now)
    });
    let mut body = serde_json::to_value(&result).map_err(|e| e.to_string())?;
    if !matches!(result, RequestResult::Ok { .. }) {
        return Ok(body);
    }
    let Some(job) = job else {
        return Ok(body);
    };
    PresenceHandle::global().apply_event(Event::ExploreStart);
    let base = api_base();
    let payload = json!({
        "term": job.term,
        "reason": job.reason.as_str(),
    });
    match http_json("POST", &format!("{base}/api/memory/explore"), Some(payload)).await {
        Ok(val) => {
            if let Some(job_id) = val.get("jobId").and_then(|v| v.as_str()) {
                log::info!("[explore] 启动 job {job_id} term={}（手动）", job.term);
                PresenceHandle::global().with(|p| p.explore_policy().set_job_id(job_id));
                spawn_waiter(job_id.to_string());
            }
            body["dispatch"] = val;
        }
        Err(e) => {
            log::warn!("[explore] 手动触发 dispatch 失败: {e}");
            PresenceHandle::global().with(|p| p.explore_policy().release());
            PresenceHandle::global().apply_event(Event::ExploreEnd);
            body["dispatchError"] = json!(e);
        }
    }
    Ok(body)
}
