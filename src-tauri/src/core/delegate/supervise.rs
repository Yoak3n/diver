//! 单任务监督线程：1s 轮询取消/退出/超时，45s 节拍发尾部摘要（inject 不吵），
//! 终态（done/failed/stuck/cancelled）写 tasks.json 并 next-turn 唤醒工头回报。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::config::tasks;

use super::{digest, notify, Paths};
use super::process::{ChildProc, OutputBuf};

/// 摘要与终态摘要的尾部字符上限。
const DIGEST_TAIL_CHARS: usize = 400;
const FINAL_TAIL_CHARS: usize = 800;

pub struct SuperviseCtx {
    pub paths: Paths,
    pub instance: String,
    pub record: tasks::TaskRecord,
    pub proc: ChildProc,
    pub cancel: Arc<AtomicBool>,
    pub timeout: Duration,
    /// 适配器正文走 stdin（arg 通道绝不写 stdin——对端不读会撑爆管道）。
    pub write_stdin: bool,
}

/// 任务视图（工具返回面）：正文截断，监督细节保留诊断。
pub fn task_view(t: &tasks::TaskRecord) -> serde_json::Value {
    const TEXT_MAX: usize = 200;
    let mut text = t.task_text.clone();
    if text.chars().count() > TEXT_MAX {
        text = text.chars().take(TEXT_MAX).collect::<String>() + "…";
    }
    json!({
        "id": t.id,
        "agent": t.agent,
        "status": t.status,
        "task": text,
        "exitCode": t.exit_code,
        "summary": t.summary,
        "createdAt": t.created_at,
        "endedAt": t.ended_at,
    })
}

/// 监督主循环（独立线程；进程级 Manager 在结束时移除旗标）。
pub fn supervise(mut ctx: SuperviseCtx) {
    let id = ctx.record.id.clone();
    let agent = ctx.record.agent.clone();
    if ctx.write_stdin {
        if let Err(err) = ctx.proc.write_stdin(&ctx.record.task_text) {
            // stdin 写失败（对端不读/管道早闭）：进程多半立即退出，交给主循环按退出码收尾。
            log::warn!("任务 {id} 正文写入失败：{err}");
        }
    }
    let started = Instant::now();
    let mut last_digest_at = Instant::now();
    let mut last_digest = String::new();
    loop {
        if ctx.cancel.load(Ordering::Relaxed) {
            ctx.proc.kill_tree();
            let _ = ctx.proc.child.wait();
            finish_and_notify(&mut ctx, tasks::STATUS_CANCELLED, None, "已按请求取消。".into());
            break;
        }
        match ctx.proc.child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code();
                let stdout_text = lock_text(&ctx.proc.stdout);
                let stderr_text = lock_text(&ctx.proc.stderr);
                let succeeded = code == Some(0);
                let summary_src = if succeeded || stderr_text.is_empty() {
                    stdout_text
                } else {
                    stderr_text
                };
                let summary = digest::tail(&summary_src, FINAL_TAIL_CHARS);
                let (final_status, text) = if succeeded {
                    (tasks::STATUS_DONE, format!("完成（退出码 0）：{summary}"))
                } else {
                    let code_text = code
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "信号".to_string());
                    (tasks::STATUS_FAILED, format!("失败（退出码 {code_text}）：{summary}"))
                };
                finish_and_notify(&mut ctx, final_status, code, text);
                break;
            }
            Ok(None) => {}
            Err(err) => {
                log::error!("任务 {id} wait 失败：{err}");
                finish_and_notify(&mut ctx, tasks::STATUS_FAILED, None, format!("监督 wait 失败：{err}"));
                break;
            }
        }
        if started.elapsed() >= ctx.timeout {
            let minutes = ctx.timeout.as_secs() / 60;
            ctx.proc.kill_tree();
            let _ = ctx.proc.child.wait();
            finish_and_notify(
                &mut ctx,
                tasks::STATUS_STUCK,
                None,
                format!("超时（{minutes} 分钟）未完成，已终止进程树。请判断是否调整任务后重派。"),
            );
            break;
        }
        if last_digest_at.elapsed() >= super::DIGEST_INTERVAL {
            last_digest_at = Instant::now();
            let tail_now = digest::tail(&lock_text(&ctx.proc.stdout), DIGEST_TAIL_CHARS);
            if !tail_now.is_empty() && tail_now != last_digest {
                last_digest = tail_now.clone();
                let text = format!("任务 {id}（{agent}）进行中，最新输出：{tail_now}");
                if let Err(err) = notify(&ctx.paths, &ctx.instance, &text, "inject") {
                    log::warn!("任务 {id} 摘要投递失败：{err}");
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    super::remove_running(&id);
}

/// 写终态 + next-turn 唤醒回报（投递失败仅记日志，状态不回退）。
fn finish_and_notify(ctx: &mut SuperviseCtx, status: &str, exit_code: Option<i32>, summary: String) {
    let home = crate::config::instances::cos_home_for(&ctx.paths.data_dir, &ctx.instance);
    let mut file = tasks::load_at(&home);
    let id = ctx.record.id.clone();
    let agent = ctx.record.agent.clone();
    match tasks::finish(&mut file, &id, status, exit_code, &summary) {
        Ok(_) => {
            tasks::save_at(&home, &file);
            let text = format!("任务 {id}（{agent}）{summary}");
            if let Err(err) = notify(&ctx.paths, &ctx.instance, &text, "next-turn") {
                log::warn!("任务 {id} 终态回报投递失败：{err}");
            }
        }
        Err(err) => log::error!("任务 {id} 写终态失败：{err}"),
    }
}

fn lock_text(buf: &Mutex<OutputBuf>) -> String {
    buf.lock().map(|b| b.text()).unwrap_or_default()
}
