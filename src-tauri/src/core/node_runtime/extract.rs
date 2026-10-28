//! Node 发行包解压与可执行文件定位。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use super::process::hidden;
use super::types::node_file_name;

pub(super) fn locate_node_in(dir: &Path) -> Option<PathBuf> {
    let name = node_file_name();
    let direct = dir.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.is_dir() {
                if let Some(f) = locate_node_in(&p) {
                    return Some(f);
                }
            }
        }
    }
    None
}

pub(super) fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let a = archive.display().to_string();
    let d = dest.display().to_string();
    if cfg!(target_os = "windows") {
        // tar.exe（Win10+）可直接解 zip；失败再走 PowerShell Expand-Archive
        if tar_extract(&a, &d).is_ok() {
            return Ok(());
        }
        powershell_extract(&a, &d)
    } else {
        tar_extract(&a, &d)
    }
}

fn tar_extract(archive: &str, dest: &str) -> Result<(), String> {
    let mut tar = Command::new("tar");
    tar.args(["-xf", archive, "-C", dest])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    crate::process_env::strip_appimage_libs(&mut tar);
    hidden(&mut tar);
    let out = tar.output().map_err(|e| format!("tar: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!(
        "解压 Node 发行包失败（tar）: {}",
        failure_detail(&out)
    ))
}

fn powershell_extract(archive: &str, dest: &str) -> Result<(), String> {
    let mut ps = Command::new("powershell");
    ps.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &format!(
            "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
            archive.replace('\'', "''"),
            dest.replace('\'', "''")
        ),
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped());
    crate::process_env::strip_appimage_libs(&mut ps);
    hidden(&mut ps);
    let out = ps.output().map_err(|e| format!("Expand-Archive 失败: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!(
        "解压 Node 发行包失败（Expand-Archive）: {}",
        failure_detail(&out)
    ))
}

/// 压缩器的真实报错只在 stderr（如 `xz: version XZ_5.6.0 not found`），
/// 带上尾部几行，启动失败遮罩里才能看出根因。
fn failure_detail(out: &Output) -> String {
    let code = out
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "被信号终止".to_string());
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        return format!("退出码 {code}");
    }
    let lines: Vec<&str> = stderr.lines().rev().take(4).collect();
    format!(
        "退出码 {code}: {}",
        lines.into_iter().rev().collect::<Vec<_>>().join(" | ")
    )
}
