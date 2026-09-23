//! presence 日程调度（壳端控制面）。
//!
//! 配置仍存 `$COS_HOME/presence-schedule.json`（UI 经 backend `/api/presence` CRUD）。
//! 到点：原生通知 + `request(proactive_inject, source=presence)` → L3 inject。
//! 不再由 sidecar 自跑门控（companion-presence-fsm.md §11）。

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::base::presence::request_and_inject;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PresenceEntry {
    pub id: String,
    /// "HH:mm"（24 小时制，本地时区）。
    pub time: String,
    pub prompt: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PresenceConfig {
    #[serde(default)]
    pub entries: Vec<PresenceEntry>,
}

fn schedule_path() -> PathBuf {
    let home = if let Some(app) = crate::base::handle::Handle::global().app_handle() {
        crate::config::cos_home(&app)
    } else if let Ok(home) = std::env::var("COS_HOME") {
        PathBuf::from(home)
    } else {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest
            .parent()
            .unwrap_or(&manifest)
            .join("harness")
            .join(".cos-home")
    };
    home.join("presence-schedule.json")
}

pub fn load_schedule() -> PresenceConfig {
    let path = schedule_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return PresenceConfig { entries: vec![] };
    };
    if let Ok(list) = serde_json::from_str::<Vec<PresenceEntry>>(&raw) {
        return PresenceConfig { entries: list };
    }
    serde_json::from_str(&raw).unwrap_or(PresenceConfig { entries: vec![] })
}

fn local_hhmm_and_day() -> (String, String) {
    let now = chrono::Local::now();
    (
        now.format("%H:%M").to_string(),
        now.format("%Y-%m-%d").to_string(),
    )
}

/// 返回是否已成功占坑注入（裁决拒绝 → false，同分钟下轮再试）。
async fn fire_entry(entry: &PresenceEntry) -> bool {
    log::info!("[presence] 触发日程 {} @ {}: {}", entry.id, entry.time, entry.prompt);

    // 原生通知（失败可丢）
    if let Some(app) = crate::base::handle::Handle::global().app_handle() {
        crate::base::notify::show(&app, "Diver", &entry.prompt);
    }

    // 主动问候：已裁决路径 request → /api/inject
    let text = format!("[presence] {}", entry.prompt);
    let base = crate::base::sidecar::SidecarManager::global().api_base_url();
    match request_and_inject(&base, "presence", &text).await {
        Ok(body) => {
            let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            if !ok {
                let reason = body
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("rejected");
                log::info!("[presence] 跳过（裁决）: {reason}");
                return false;
            }
            true
        }
        Err(e) => {
            log::warn!("[presence] inject 失败: {e}");
            // 网络失败不记 fired，避免整分钟丢失
            false
        }
    }
}

fn should_fire(entry: &PresenceEntry, hhmm: &str, day: &str, fired: &HashSet<String>) -> bool {
    if !entry.enabled || entry.time.is_empty() || entry.prompt.is_empty() {
        return false;
    }
    if entry.time != hhmm {
        return false;
    }
    !fired.contains(&format!("{}@{} {}", entry.id, day, hhmm))
}

/// 启动 30s tick 调度线程（进程级，一次即可）。
pub fn spawn_scheduler() {
    std::thread::spawn(|| {
        let mut fired: HashSet<String> = HashSet::new();
        let mut fired_day = String::new();
        log::info!("[presence] 壳端调度器启动（30s tick）");
        loop {
            let (hhmm, day) = local_hhmm_and_day();
            if fired_day != day {
                fired.clear();
                fired_day = day.clone();
            }
            for entry in load_schedule().entries {
                let key = format!("{}@{} {}", entry.id, day, hhmm);
                if !should_fire(&entry, &hhmm, &day, &fired) {
                    continue;
                }
                let ok = tauri::async_runtime::block_on(async {
                    fire_entry(&entry).await
                });
                // 成功才占坑；裁决/网络失败 → 同分钟下轮 tick 再试
                if ok {
                    fired.insert(key);
                }
            }
            std::thread::sleep(Duration::from_secs(30));
        }
    });
}

/// 供 RPC/调试读日程。
pub fn schedule_json() -> Value {
    serde_json::to_value(load_schedule()).unwrap_or(Value::Null)
}
