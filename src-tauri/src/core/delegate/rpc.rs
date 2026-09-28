//! `delegate::*` RPC 分发（services 经注入闭包到达；身份头定位发起实例）。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::config::delegate::{self, TextVia};
use crate::config::instances::cos_home_for;
use crate::config::tasks;

use super::manager::Manager;
use super::process;
use super::resolve;
use super::supervise::{self, SuperviseCtx};
use super::types::{Paths, DEFAULT_TIMEOUT_SECS};

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
