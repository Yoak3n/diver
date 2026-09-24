//! Node 发行包解压与可执行文件定位。

use std::path::{Path, PathBuf};
use std::process::Command;

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
        let mut tar = Command::new("tar");
        tar.args(["-xf", &a, "-C", &d])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        hidden(&mut tar);
        if matches!(tar.status(), Ok(s) if s.success()) {
            return Ok(());
        }
        let mut ps = Command::new("powershell");
        ps.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                a.replace('\'', "''"),
                d.replace('\'', "''")
            ),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
        hidden(&mut ps);
        let ps_status = ps.status().map_err(|e| format!("Expand-Archive 失败: {e}"))?;
        if ps_status.success() {
            Ok(())
        } else {
            Err("解压 Node 发行包失败（tar / Expand-Archive）".into())
        }
    } else {
        let mut tar = Command::new("tar");
        tar.args(["-xf", &a, "-C", &d])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        hidden(&mut tar);
        let st = tar.status().map_err(|e| format!("tar: {e}"))?;
        if st.success() {
            Ok(())
        } else {
            Err("解压 Node 发行包失败".into())
        }
    }
}
