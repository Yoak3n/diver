//! ExplorePolicy 控制面：tick 裁决（何时探索、探索哪个词）+ 手动触发 + 调度线程。
//! 启动后 job 的等待/取消在 jobs.rs；HTTP 传输在 rpc.rs。

use std::time::Duration;

use diver_presence::{Event, RequestResult, WebExploreReason};
use serde_json::{json, Value};

use crate::core::presence::PresenceHandle;

use super::jobs::spawn_waiter;
use super::log_fmt;
use super::rpc::http_json;

/// 拉候选词并尝试启动一次探索。
async fn try_start_explore() {
    let base = super::rpc::api_base();

    // 1) 壳策略：到点了吗？
    let now = diver_presence::types::now_ms();
    let wake = PresenceHandle::active().with(|p| p.explore_should_wake(now));
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
        let sleep = PresenceHandle::active().with(|p| p.snapshot(now).regime == "sleep");
        let reason = if sleep {
            WebExploreReason::Sleep
        } else {
            WebExploreReason::LongIdle
        };

        let (result, job) = PresenceHandle::active().with(|p| {
            p.request_web_explore(term, reason, from_memory_id.clone(), now)
        });
        if !result.is_ok() {
            log::info!("[explore] 跳过「{term}」: {result:?}");
            continue;
        }
        let Some(job) = job else { continue };

        // L0：EXPLORE_START → Solitary/Exploring（T20）
        PresenceHandle::active().apply_event(Event::ExploreStart);

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
                PresenceHandle::active().with(|p| p.explore_policy().set_job_id(job_id.clone()));
                // 后台等待完成 / 被打断
                spawn_waiter(job_id);
                return; // 一次只起一个
            }
            Err(e) => {
                log::warn!("[explore] POST /api/memory/explore 失败: {e}");
                PresenceHandle::active().with(|p| p.explore_policy().release());
                PresenceHandle::active().apply_event(Event::ExploreEnd);
            }
        }
    }
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
    PresenceHandle::active().with(|p| {
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
    let (result, job) = PresenceHandle::active().with(|p| {
        p.request_web_explore(term, reason, None, now)
    });
    let mut body = serde_json::to_value(&result).map_err(|e| e.to_string())?;
    if !matches!(result, RequestResult::Ok { .. }) {
        return Ok(body);
    }
    let Some(job) = job else {
        return Ok(body);
    };
    PresenceHandle::active().apply_event(Event::ExploreStart);
    let base = super::rpc::api_base();
    let payload = json!({
        "term": job.term,
        "reason": job.reason.as_str(),
    });
    match http_json("POST", &format!("{base}/api/memory/explore"), Some(payload)).await {
        Ok(val) => {
            if let Some(job_id) = val.get("jobId").and_then(|v| v.as_str()) {
                log::info!("[explore] 启动 job {job_id} term={}（手动）", job.term);
                PresenceHandle::active().with(|p| p.explore_policy().set_job_id(job_id));
                spawn_waiter(job_id.to_string());
            }
            body["dispatch"] = val;
        }
        Err(e) => {
            log::warn!("[explore] 手动触发 dispatch 失败: {e}");
            PresenceHandle::active().with(|p| p.explore_policy().release());
            PresenceHandle::active().apply_event(Event::ExploreEnd);
            body["dispatchError"] = json!(e);
        }
    }
    Ok(body)
}
