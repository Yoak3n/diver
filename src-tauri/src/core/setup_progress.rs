//! 首启运行时准备：进程内解压依赖归档 + Node 解析/下载，并向 UI 广播进度。
//!
//! 不弹控制台窗口：解压在 Rust 内完成（`tar` crate），下载走 HTTP；
//! 进度经 Tauri 事件 `setup://progress` 推给前端首启遮罩。

use std::fs;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 前端首启遮罩订阅的进度事件。
#[derive(Debug, Clone, Serialize)]
pub struct SetupProgress {
    /// `extract` | `node` | `start` | `ready` | `error`
    pub phase: String,
    pub message: String,
    /// 0–100；不确定时为 0。
    pub percent: f32,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 最近一次进度（WebView 晚挂载时经 `get_setup_progress` 回放，避免卡在 0%）。
static LAST: Mutex<Option<SetupProgress>> = Mutex::new(None);

/// 供前端轮询/挂载时拉取当前进度。
pub fn last_progress() -> Option<SetupProgress> {
    LAST.lock().clone()
}

pub fn emit_progress(app: &AppHandle, phase: &str, message: impl Into<String>, percent: f32, done: bool) {
    let payload = SetupProgress {
        phase: phase.into(),
        message: message.into(),
        percent: percent.clamp(0.0, 100.0),
        done,
        error: None,
    };
    *LAST.lock() = Some(payload.clone());
    let _ = app.emit("setup://progress", payload);
}

pub fn emit_error(app: &AppHandle, message: impl Into<String>) {
    let msg = message.into();
    let payload = SetupProgress {
        phase: "error".into(),
        message: msg.clone(),
        percent: 0.0,
        done: true,
        error: Some(msg),
    };
    *LAST.lock() = Some(payload.clone());
    let _ = app.emit("setup://progress", payload);
}

/// 解压清单（marker 幂等，成功后删归档）；并行解压实现在 `core::setup_extract`。
const MARKER: &str = ".deps-extracted";

/// 归档 → 解压目标。优先 `node_modules.tar.zst`（zstd），兼容旧 `node_modules.tar`；
/// 两者都不存在时无任务。
fn archives(sidecar_dir: &Path) -> Vec<(PathBuf, PathBuf)> {
    [("harness", "node_modules"), ("plugins", "node_modules")]
        .iter()
        .filter_map(|(dir, name)| {
            let parent = sidecar_dir.join(dir);
            let zst = parent.join(format!("{name}.tar.zst"));
            let plain = parent.join(format!("{name}.tar"));
            let archive = if zst.is_file() {
                zst
            } else if plain.is_file() {
                plain
            } else {
                return None;
            };
            Some((archive, parent.join(name)))
        })
        .collect()
}

/// 是否仍有归档待解压（纯路径判断；与 `ensure_deps_extracted` 的 pending 过滤一致）。
pub fn has_pending_archives(sidecar_dir: &Path) -> bool {
    archives(sidecar_dir).iter().any(|(archive, dest)| {
        if !archive.is_file() {
            return false;
        }
        let marker = dest.join(MARKER);
        if !marker.exists() {
            return true;
        }
        // tar 比 marker 新 → 升级安装，强制重解压
        match (fs::metadata(archive), fs::metadata(&marker)) {
            (Ok(a), Ok(m)) => a
                .modified()
                .ok()
                .zip(m.modified().ok())
                .map(|(at, mt)| at > mt)
                .unwrap_or(true),
            _ => true,
        }
    })
}

/// 是否仍需首启准备（归档解压 / Node 下载）。
///
/// 仅当需要向用户展示准备进度时才应强制弹出主窗口；**不得**用进程内
/// `last_progress()` 判断（每次启动都是 `None`，会旁路「启动时打开主窗口」配置）。
pub fn needs_bootstrap(app: &AppHandle) -> bool {
    // dev：依赖走本地 pnpm，不走归档解压 / Node 下载
    #[cfg(debug_assertions)]
    {
        let _ = app;
        false
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri::Manager;
        // 与 core/sidecar/command.rs release 路径同一布局
        let Ok(res) = app.path().resource_dir() else {
            return true;
        };
        let sidecar_dir = res.join("resources").join("sidecar");
        if has_pending_archives(&sidecar_dir) {
            return true;
        }
        !crate::core::node_runtime::node_available_locally(app)
    }
}

/// 首次启动解压 `*.tar.zst` / `*.tar`（无子进程、无黑窗）。已解压则秒过。
///
/// 升级安装时 NSIS 可能留下旧的 `.deps-extracted` 与旧 `node_modules`，
/// 而新的归档并未解开 —— 必须在 **归档比 marker 新** 时重解压。
pub fn ensure_deps_extracted(app: &AppHandle, sidecar_dir: &Path) -> Result<(), String> {
    let jobs = archives(sidecar_dir);
    let pending: Vec<_> = jobs
        .iter()
        .filter(|(archive, dest)| {
            if !archive.is_file() {
                return false;
            }
            let marker = dest.join(MARKER);
            if !marker.exists() {
                return true;
            }
            // tar 比 marker 新 → 升级安装，强制重解压
            match (fs::metadata(archive), fs::metadata(&marker)) {
                (Ok(a), Ok(m)) => a
                    .modified()
                    .ok()
                    .zip(m.modified().ok())
                    .map(|(at, mt)| at > mt)
                    .unwrap_or(true),
                _ => true,
            }
        })
        .cloned()
        .collect();
    if pending.is_empty() {
        emit_progress(app, "extract", "依赖已就绪", 100.0, true);
        return Ok(());
    }

    emit_progress(app, "extract", "正在解压运行依赖…", 3.0, false);
    // 归档之间目录互不相交：并行解压（各归档内部再并行写盘，见 setup_extract）
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    let slots: Arc<Vec<(AtomicU32, AtomicU32)>> = Arc::new(
        pending
            .iter()
            .map(|_| (AtomicU32::new(0), AtomicU32::new(0)))
            .collect(),
    );
    let mut handles = Vec::new();
    for (i, (archive, dest)) in pending.iter().enumerate() {
        let archive = archive.clone();
        let dest = dest.clone();
        let label = dest
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "node_modules".into());
        let slots = Arc::clone(&slots);
        let app = app.clone();
        handles.push(std::thread::spawn(move || -> Result<(), String> {
            // 升级：清掉旧解压结果，避免新旧文件混杂
            if dest.exists() {
                let _ = fs::remove_dir_all(&dest);
            }
            crate::core::setup_extract::extract_archive(&archive, &dest, &mut |n, total| {
                slots[i].0.store(n, Ordering::SeqCst);
                slots[i].1.store(total, Ordering::SeqCst);
                let (sum_done, sum_total) = slots
                    .iter()
                    .map(|(d, t)| (d.load(Ordering::SeqCst), t.load(Ordering::SeqCst)))
                    .fold((0u32, 0u32), |(ad, at), (d, t)| (ad + d, at + t));
                let p = 8.0 + 84.0 * (sum_done as f32 / sum_total.max(1) as f32);
                emit_progress(&app, "extract", format!("{label}: {n}/{total} 项"), p, false);
            })?;
            fs::write(dest.join(MARKER), chrono::Utc::now().to_rfc3339())
                .map_err(|e| format!("写入解压标记失败: {e}"))?;
            // 归档只用于首启解压，成功后删除以省磁盘
            let _ = fs::remove_file(&archive);
            Ok(())
        }));
    }
    let mut first_err: Option<String> = None;
    for h in handles {
        match h.join() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
            Err(_) => {
                if first_err.is_none() {
                    first_err = Some("解压线程异常退出".into());
                }
            }
        }
    }
    if let Some(e) = first_err {
        return Err(e);
    }
    emit_progress(app, "extract", "依赖解压完成", 100.0, true);
    Ok(())
}

/// 解析 / 下载 Node，并广播进度（封装 `node_runtime::resolve_node`）。
pub fn ensure_node_ready(
    app: &AppHandle,
    push: &mut dyn FnMut(String),
) -> Result<crate::core::node_runtime::NodeRuntime, String> {
    emit_progress(app, "node", "正在准备 Node 运行时…", 0.0, false);
    let mut last = String::new();
    let result = crate::core::node_runtime::resolve_node(app, &mut |line: String| {
        emit_progress(app, "node", line.clone(), 30.0, false);
        if line != last {
            last = line.clone();
        }
        push(line);
    });
    match result {
        Ok(rt) => {
            emit_progress(
                app,
                "node",
                format!("Node 就绪（{}）", rt.source),
                100.0,
                true,
            );
            Ok(rt)
        }
        Err(e) => {
            emit_error(app, e.clone());
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_archives_false_when_no_tar() {
        let dir = std::env::temp_dir().join(format!("diver-arch-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!has_pending_archives(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_archives_detects_missing_marker() {
        let dir = std::env::temp_dir().join(format!("diver-arch-{}", std::process::id()));
        let archive = dir.join("harness").join("node_modules.tar");
        std::fs::create_dir_all(archive.parent().unwrap()).unwrap();
        std::fs::write(&archive, b"x").unwrap();
        assert!(has_pending_archives(&dir));
        let dest = dir.join("harness").join("node_modules");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join(MARKER), "ok").unwrap();
        assert!(!has_pending_archives(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
