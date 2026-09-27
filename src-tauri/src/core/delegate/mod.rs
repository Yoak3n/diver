//! 任务委派监督（0.2.0 codingagent 任务委派，拍板：壳层 Rust）。
//!
//! 职责：解析适配器 → spawn CLI → 监督（见 supervise.rs：相变 + 45s 尾部摘要，
//! inject 收听不吵；终态 next-turn 唤醒回报）。回报经实例注册表端口注入发起
//! 实例的 session inbox（与 peer 消息同一根管）。tasks.json 按实例 `$COS_HOME`
//! 落盘；壳重启后 running 记录清扫为 `unknown`（明示不可知，不自动重发）。

pub mod digest;
pub mod process;
pub mod resolve;
pub mod supervise;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use crate::config::delegate::{self, TextVia};
use crate::config::instances::cos_home_for;
use crate::config::tasks;
use crate::core::instance_registry;

use supervise::SuperviseCtx;

/// 摘要节拍（拍板：相变 + 45s 周期摘要）。
pub const DIGEST_INTERVAL: Duration = Duration::from_secs(45);
/// 任务超时缺省（超时 → stuck，求援不静默）。
pub const DEFAULT_TIMEOUT_SECS: u64 = 1800;

/// 分发所需路径（app/setup 注入；core 不摸 AppHandle）。
#[derive(Debug, Clone)]
pub struct Paths {
    /// `app_data_dir`（`cos_home_for` 基座）。
    pub data_dir: std::path::PathBuf,
    /// 实例注册表目录（回报寻址）。
    pub registry_dir: std::path::PathBuf,
}

/// 运行中任务的取消旗标（层内进程级单例：cancel 需跨线程触达监督线程）。
struct Manager {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Manager {
    fn global() -> &'static Manager {
        static MANAGER: OnceLock<Manager> = OnceLock::new();
        MANAGER.get_or_init(|| Manager {
            running: Mutex::new(HashMap::new()),
        })
    }

    fn register(&self, id: &str, flag: Arc<AtomicBool>) {
        self.running.lock().unwrap().insert(id.to_string(), flag);
    }

    fn remove(&self, id: &str) {
        self.running.lock().unwrap().remove(id);
    }

    fn has(&self, id: &str) -> bool {
        self.running.lock().unwrap().contains_key(id)
    }

    fn request_cancel(&self, id: &str) -> bool {
        match self.running.lock().unwrap().get(id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

/// 监督线程结束时注销旗标（supervise.rs 经此门面访问）。
pub(crate) fn remove_running(id: &str) {
    Manager::global().remove(id);
}

/// `delegate::*` RPC 分发（services 经注入闭包到达；身份头定位发起实例）。
pub fn dispatch_rpc(
    paths: &Paths,
    instance_id: Option<&str>,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let instance = instance_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("delegate 需要实例身份（X-Diver-Instance）")?;
    match method {
        "delegate::spawn" => spawn(paths, instance, params),
        "delegate::list" => list(paths, instance, params),
        "delegate::cancel" => cancel(paths, instance, params),
        other => Err(format!("未知 delegate 方法：{other}")),
    }
}

fn text_param(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

/// 清扫跨壳残留：running 且不在本壳监督表 → unknown（明示不可知）。
fn sweep_stale(paths: &Paths, instance: &str) {
    let home = cos_home_for(&paths.data_dir, instance);
    let mut file = tasks::load_at(&home);
    let stale: Vec<String> = file
        .tasks
        .iter()
        .filter(|t| t.status == tasks::STATUS_RUNNING && !Manager::global().has(&t.id))
        .map(|t| t.id.clone())
        .collect();
    if stale.is_empty() {
        return;
    }
    for id in &stale {
        let _ = tasks::mark_unknown(&mut file, id);
    }
    tasks::save_at(&home, &file);
    log::info!("委派任务恢复清扫（{instance}）：{} 项 → unknown", stale.len());
}

fn spawn(paths: &Paths, instance: &str, params: &Value) -> Result<Value, String> {
    let task_text = text_param(params, "task");
    if task_text.is_empty() {
        return Err("task 必填".to_string());
    }
    let agent_param = text_param(params, "agent");
    let timeout_secs = params
        .get("timeoutSecs")
        .and_then(Value::as_u64)
        .filter(|s| *s >= 30)
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    sweep_stale(paths, instance);

    let home = cos_home_for(&paths.data_dir, instance);
    let cfg = delegate::load_or_seed_at(&home);
    let (agent, adapter) = delegate::resolve(&cfg, &agent_param)?;

    let workspace = home.join("workspace");
    let _ = std::fs::create_dir_all(&workspace);
    // argv 首项为裸 `dsh` 时走探测链解析启动前缀（PATH shim → Harness Desktop →
    // 捆绑 CLI 直启）；用户显式填写的其它形式原样使用（兜底）。
    let (full_argv, spawn_envs) = if resolve::needs_resolution(&adapter.argv) {
        let resolved = resolve::resolve()?;
        let mut full = resolved.launcher;
        full.extend(adapter.argv.iter().skip(1).cloned());
        (full, resolved.envs)
    } else {
        (adapter.argv.clone(), Vec::new())
    };
    let mut file = tasks::load_at(&home);
    let record = tasks::create(
        &mut file,
        instance,
        &agent,
        &task_text,
        &full_argv.join(" "),
        Some(timeout_secs),
    );
    tasks::save_at(&home, &file);

    let proc = match process::spawn(&full_argv, &workspace, &spawn_envs) {
        Ok(proc) => proc,
        Err(err) => {
            // spawn 失败留痕（queued → failed），并把失败直接还给工头。
            let mut file = tasks::load_at(&home);
            let _ = tasks::finish(&mut file, &record.id, tasks::STATUS_FAILED, None, &err);
            tasks::save_at(&home, &file);
            return Err(err);
        }
    };
    let pid = proc.child.id();
    // 先登记取消旗标再落 running（并发 list 的 sweep 只认旗标在册的任务）。
    let flag = Arc::new(AtomicBool::new(false));
    Manager::global().register(&record.id, flag.clone());
    let mut file = tasks::load_at(&home);
    tasks::mark_running(&mut file, &record.id, pid)?;
    tasks::save_at(&home, &file);
    let ctx = SuperviseCtx {
        paths: paths.clone(),
        instance: instance.to_string(),
        record: record.clone(),
        proc,
        cancel: flag,
        timeout: Duration::from_secs(timeout_secs),
        write_stdin: adapter.text_via == TextVia::Stdin,
    };
    std::thread::spawn(move || supervise::supervise(ctx));
    Ok(json!({
        "taskId": record.id,
        "agent": agent,
        "timeoutSecs": timeout_secs,
        "note": "任务已受理。进度摘要与终态会自动回报进本会话，不要轮询等待；期间可 cancel_task 取消。",
    }))
}

fn list(paths: &Paths, instance: &str, params: &Value) -> Result<Value, String> {
    sweep_stale(paths, instance);
    let home = cos_home_for(&paths.data_dir, instance);
    let file = tasks::load_at(&home);
    let want = text_param(params, "status");
    let items: Vec<Value> = file
        .tasks
        .iter()
        .filter(|t| want.is_empty() || t.status == want)
        .map(supervise::task_view)
        .collect();
    Ok(json!({ "tasks": items }))
}

fn cancel(paths: &Paths, instance: &str, params: &Value) -> Result<Value, String> {
    let id = text_param(params, "taskId");
    if id.is_empty() {
        return Err("taskId 必填".to_string());
    }
    if Manager::global().request_cancel(&id) {
        return Ok(json!({ "taskId": id, "ok": true, "note": "已请求取消，终态回报稍后自动到达。" }));
    }
    // 不在监督表：要么已终态，要么是跨壳残留（running）——后者直接写 cancelled。
    let home = cos_home_for(&paths.data_dir, instance);
    let mut file = tasks::load_at(&home);
    let record = file.tasks.iter().find(|t| t.id == id).cloned();
    match record {
        Some(t) if t.status == tasks::STATUS_RUNNING => {
            tasks::finish(
                &mut file,
                &id,
                tasks::STATUS_CANCELLED,
                None,
                "壳层无法再触达进程，已按取消归档。",
            )?;
            tasks::save_at(&home, &file);
            Ok(json!({ "taskId": id, "ok": true, "note": "跨壳残留任务已按取消归档。" }))
        }
        Some(t) => Err(format!("任务「{id}」已是终态（{}），无需取消", t.status)),
        None => Err(format!("未找到任务「{id}」")),
    }
}

/// 回报注入：注册表寻址发起实例 → POST /api/inbox（Bearer，P2-1 同闸）。
pub fn notify(paths: &Paths, instance: &str, text: &str, target: &str) -> Result<(), String> {
    let rows = instance_registry::list_at(&paths.registry_dir);
    let rec = rows
        .iter()
        .find(|r| r.id == instance)
        .ok_or_else(|| format!("实例「{instance}」不在注册表，无法回报"))?;
    let body = json!({
        "text": text,
        "from": { "id": "delegate", "name": "任务委派" },
        "target": target,
        "kind": "peer",
    });
    let url = format!("http://127.0.0.1:{}/api/inbox", rec.port);
    let resp = reqwest::blocking::Client::new()
        .post(&url)
        .bearer_auth(crate::core::sidecar::service_token())
        .timeout(Duration::from_secs(5))
        .json(&body)
        .send()
        .map_err(|err| format!("回报投递失败（{url}）：{err}"))?;
    if !resp.status().is_success() {
        return Err(format!("回报被拒（{}）", resp.status()));
    }
    Ok(())
}
