//! Node 发行包下载与 SHA256 尽力校验。

use std::path::Path;
use std::process::Command;

use super::extract::{extract_archive, locate_node_in};
use super::{hidden, NODE_DIST_VERSION, MIN_NODE_MAJOR};

pub(super) fn dist_archive_name() -> String {
    let platform = if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win-x64"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "win-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "linux-arm64"
    } else {
        "win-x64"
    };
    let ext = if cfg!(target_os = "windows") { "zip" } else { "tar.xz" };
    format!("node-v{NODE_DIST_VERSION}-{platform}.{ext}")
}

fn dist_urls() -> Vec<String> {
    let name = dist_archive_name();
    let ver = NODE_DIST_VERSION;
    vec![
        format!("https://nodejs.org/dist/v{ver}/{name}"),
        format!("https://npmmirror.com/mirrors/node/v{ver}/{name}"),
    ]
}

pub(super) fn download_and_extract(
    app: &tauri::AppHandle,
    cache_root: &Path,
    push: &mut dyn FnMut(String),
) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(cache_root)
        .map_err(|e| format!("创建运行时缓存目录失败 {}: {e}", cache_root.display()))?;

    let archive_name = dist_archive_name();
    let archive_path = cache_root.join(&archive_name);
    let mut last_err = String::from("无可用下载源");

    for url in dist_urls() {
        push(format!("[diver] 下载 {url}"));
        match download_file(&url, &archive_path) {
            Ok(()) => {
                last_err = String::new();
                break;
            }
            Err(e) => {
                log::warn!("下载 Node 失败 ({url}): {e}");
                last_err = e;
            }
        }
    }
    if !last_err.is_empty() {
        return Err(format!(
            "下载 Node 失败: {last_err}。可手动安装 Node ≥ {MIN_NODE_MAJOR} 后重试，\
             或设置环境变量 DIVER_NODE_BIN 指向 node 可执行文件。\
             离线环境也可将官方 zip 解压到 {}",
            cache_root.display()
        ));
    }

    // 校验：至少应是合法压缩包且体积合理（官方 win-x64 zip ~30MB+）
    let size = std::fs::metadata(&archive_path).map(|m| m.len()).unwrap_or(0);
    if size < 5_000_000 {
        let _ = std::fs::remove_file(&archive_path);
        return Err(format!("下载的 Node 包过小（{size} bytes），可能不是完整发行包"));
    }
    let _ = verify_sha256(&archive_path, push); // 失败仅告警：镜像偶发 SHASUMS 不可用

    push("[diver] 解压 Node 运行时 …".into());
    let extract_dir = cache_root.join(format!(
        "node-v{NODE_DIST_VERSION}-{}",
        dist_archive_name()
            .trim_end_matches(".zip")
            .trim_end_matches(".tar.xz")
            .rsplit_once('-')
            .map(|(_, plat)| plat)
            .unwrap_or("portable")
    ));
    // 先清掉半截目录
    let _ = std::fs::remove_dir_all(&extract_dir);
    std::fs::create_dir_all(&extract_dir)
        .map_err(|e| format!("创建解压目录失败: {e}"))?;
    extract_archive(&archive_path, &extract_dir)?;
    let _ = std::fs::remove_file(&archive_path);

    let node_exe = locate_node_in(&extract_dir).ok_or_else(|| {
        format!("解压后未找到 node 可执行文件: {}", extract_dir.display())
    })?;
    let _ = app;
    push(format!("[diver] Node 就绪: {}", node_exe.display()));
    Ok(node_exe)
}

fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("读取响应: {e}"))?;
        std::fs::write(dest, &bytes).map_err(|e| format!("写入 {}: {e}", dest.display()))?;
        Ok(())
    })
}

/// 尽力校验 SHASUMS256.txt（失败不阻断，仅日志）。
fn verify_sha256(archive: &Path, push: &mut dyn FnMut(String)) -> Option<()> {
    let hash = file_sha256(archive)?;
    let ver = NODE_DIST_VERSION;
    let sums_url = format!("https://nodejs.org/dist/v{ver}/SHASUMS256.txt");
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().ok()?;
    let text = rt
        .block_on(async {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .ok()?;
            let resp = client.get(&sums_url).send().await.ok()?;
            resp.text().await.ok()
        })?;
    let name = dist_archive_name();
    let expect = text
        .lines()
        .find(|l| l.trim_end().ends_with(&name))
        .and_then(|l| l.split_whitespace().next())?;
    if !expect.eq_ignore_ascii_case(&hash) {
        push("[diver] 警告：Node 包 SHA256 与官方 SHASUMS 不一致（继续尝试解压）".into());
        log::warn!("sha256 mismatch: expect={expect} actual={hash}");
    } else {
        push("[diver] Node 包 SHA256 校验通过".into());
    }
    Some(())
}

fn file_sha256(path: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "(Get-FileHash -Algorithm SHA256 -Path '{}').Hash",
                path.display().to_string().replace('\'', "''")
            ),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
        hidden(&mut cmd);
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_lowercase())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let out = hidden(&mut Command::new("sha256sum")).arg(path).output().ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .next()
            .map(|s| s.to_lowercase())
    }
}
