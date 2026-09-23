//! 首启运行时准备：进程内解压依赖归档 + Node 解析/下载，并向 UI 广播进度。
//!
//! 不弹控制台窗口：解压在 Rust 内完成（`tar` crate），下载走 HTTP；
//! 进度经 Tauri 事件 `setup://progress` 推给前端首启遮罩。

use std::fs::{self, File};
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

/// 解压清单：与 `scripts/extract-deps.mjs` 保持一致（marker 幂等，成功后删归档）。
const MARKER: &str = ".deps-extracted";

fn archives(sidecar_dir: &Path) -> Vec<(PathBuf, PathBuf)> {
    vec![
        (
            sidecar_dir.join("harness").join("node_modules.tar"),
            sidecar_dir.join("harness").join("node_modules"),
        ),
        (
            sidecar_dir.join("plugins").join("node_modules.tar"),
            sidecar_dir.join("plugins").join("node_modules"),
        ),
    ]
}

/// 首次启动解压 `*.tar`（无子进程、无黑窗）。已解压则秒过。
///
/// 升级安装时 NSIS 可能留下旧的 `.deps-extracted` 与旧 `node_modules`，
/// 而新的 `node_modules.tar` 并未解开 —— 必须在 **tar 比 marker 新** 时重解压。
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
    for (i, (archive, dest)) in pending.iter().enumerate() {
        let label = dest
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "node_modules".into());
        let base = 8.0 + (i as f32) * 42.0;
        emit_progress(
            app,
            "extract",
            format!("解压 {label} …"),
            base,
            false,
        );
        // 升级：清掉旧解压结果，避免新旧文件混杂
        if dest.exists() {
            let _ = fs::remove_dir_all(dest);
        }
        extract_tar(app, archive, dest, &label, base, 42.0)?;
        fs::write(dest.join(MARKER), chrono::Utc::now().to_rfc3339())
            .map_err(|e| format!("写入解压标记失败: {e}"))?;
        // 归档只用于首启解压，成功后删除以省磁盘
        let _ = fs::remove_file(archive);
    }
    emit_progress(app, "extract", "依赖解压完成", 100.0, true);
    Ok(())
}

fn extract_tar(
    app: &AppHandle,
    archive: &Path,
    dest: &Path,
    label: &str,
    base: f32,
    span: f32,
) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("创建 {}: {e}", dest.display()))?;
    emit_progress(app, "extract", format!("扫描 {label} 归档…"), base + 1.0, false);

    // 先数条目，便于百分比（两遍读同一归档，避免一次性占内存）
    let total = {
        let file = File::open(archive).map_err(|e| format!("打开 {}: {e}", archive.display()))?;
        let mut ar = tar::Archive::new(file);
        ar.entries()
            .map_err(|e| format!("读取 tar: {e}"))?
            .filter_map(|e| e.ok())
            .count() as f32
    }
    .max(1.0);

    let file = File::open(archive).map_err(|e| format!("打开 {}: {e}", archive.display()))?;
    let mut ar = tar::Archive::new(file);
    let mut n = 0u32;
    for entry in ar.entries().map_err(|e| format!("读取 tar: {e}"))? {
        let mut entry = entry.map_err(|e| format!("tar 条目: {e}"))?;
        entry
            .unpack_in(dest)
            .map_err(|e| format!("解压到 {}: {e}", dest.display()))?;
        n += 1;
        // 小归档也要有进度；大归档每 40 项推一次
        if n % 40 == 0 || n == total as u32 {
            let p = base + 4.0 + (span - 4.0) * (n as f32 / total);
            emit_progress(app, "extract", format!("{label}: {n}/{total:.0} 项"), p, false);
        }
    }
    emit_progress(app, "extract", format!("{label} 解压完成"), base + span, false);
    Ok(())
}

/// 解析 / 下载 Node，并广播进度（封装 `node_runtime::resolve_node`）。
pub fn ensure_node_ready(
    app: &AppHandle,
    push: &mut dyn FnMut(String),
) -> Result<crate::base::node_runtime::NodeRuntime, String> {
    emit_progress(app, "node", "正在准备 Node 运行时…", 0.0, false);
    let mut last = String::new();
    let result = crate::base::node_runtime::resolve_node(app, &mut |line: String| {
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
