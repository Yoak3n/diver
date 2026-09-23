//! Node 运行时解析：优先本机 / 应用缓存，缺失时下载官方 zip 到用户数据目录。
//!
//! 安装包不随包 node.exe（体积从 ~70MB 降到 ~15–25MB）。启动 sidecar 前按
//! 下列顺序解析：
//! 1. `DIVER_NODE_BIN` 显式指定
//! 2. 旧版随包 `resources/sidecar/node.exe`（兼容已解压目录）
//! 3. 应用缓存 `%LOCALAPPDATA%/Diver/runtime/node-*/node.exe`
//! 4. PATH / 常见安装目录中的系统 Node（要求 ≥ MIN_NODE_MAJOR）
//! 5. 下载官方发行包到应用缓存（首次需网络；失败给出可操作错误）

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Manager;

/// Windows：子进程不弹控制台黑窗。
#[cfg(target_os = "windows")]
fn hidden(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn hidden(cmd: &mut Command) -> &mut Command {
    cmd
}

/// sidecar（tsx + companion-bundle）要求的最低 Node 主版本。
pub const MIN_NODE_MAJOR: u32 = 22;

/// 首次下载的 Node 版本（Windows/macOS/Linux 官方二进制）。
const NODE_DIST_VERSION: &str = "22.20.0";

/// 解析结果。
#[derive(Debug, Clone)]
pub struct NodeRuntime {
    pub node_exe: PathBuf,
    pub source: &'static str,
}

impl NodeRuntime {
    /// `node --version` 解析出的主版本号。
    pub fn major(&self) -> Option<u32> {
        node_major(&self.node_exe)
    }
}

/// 解析可用的 Node；必要时下载到缓存。`push` 用于 UI 日志。
pub fn resolve_node(app: &tauri::AppHandle, push: &mut dyn FnMut(String)) -> Result<NodeRuntime, String> {
    // 1) 显式覆盖
    if let Ok(bin) = std::env::var("DIVER_NODE_BIN") {
        let p = PathBuf::from(&bin);
        if is_usable_node(&p) {
            return Ok(NodeRuntime { node_exe: p, source: "env:DIVER_NODE_BIN" });
        }
        return Err(format!(
            "DIVER_NODE_BIN 指向的 Node 不可用或版本过低（需 ≥ {MIN_NODE_MAJOR}）: {bin}"
        ));
    }

    // 2) 旧版随包 node.exe（升级后 resources 里可能仍在）
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("resources").join("sidecar").join(node_file_name());
        if bundled.is_file() && is_usable_node(&bundled) {
            return Ok(NodeRuntime { node_exe: bundled, source: "bundled" });
        }
    }

    // 3) 应用缓存
    let cache_root = runtime_cache_dir(app);
    if let Some(p) = find_cached_node(&cache_root) {
        return Ok(NodeRuntime { node_exe: p, source: "cache" });
    }

    // 4) 系统 Node
    if let Some(p) = find_system_node() {
        if is_usable_node(&p) {
            return Ok(NodeRuntime { node_exe: p, source: "system" });
        }
    }

    // 5) 下载到缓存
    push(format!(
        "[diver] 未检测到 Node ≥ {MIN_NODE_MAJOR}，正在下载 Node {NODE_DIST_VERSION} …"
    ));
    let node_exe = download_and_extract(app, &cache_root, push)?;
    if !is_usable_node(&node_exe) {
        return Err(format!(
            "下载的 Node 仍不可用: {}（需 ≥ {MIN_NODE_MAJOR}）",
            node_exe.display()
        ));
    }
    Ok(NodeRuntime { node_exe, source: "downloaded" })
}

fn node_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}

/// 运行时缓存目录（安装目录外，升级不丢；可手动删除强制重下）。
fn runtime_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    // LOCALAPPDATA/Diver/runtime（Windows）或 ~/.local/share/Diver/runtime 等
    let base = dirs::data_local_dir()
        .or_else(|| dirs::data_dir())
        .unwrap_or_else(std::env::temp_dir);
    let _ = app; // 保留 AppHandle 便于日后绑定 app 标识目录
    base.join("Diver").join("runtime")
}

fn find_cached_node(cache_root: &Path) -> Option<PathBuf> {
    let name = node_file_name();
    if cache_root.is_dir() {
        if let Ok(rd) = std::fs::read_dir(cache_root) {
            let mut dirs: Vec<PathBuf> = rd
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            dirs.reverse(); // 版本目录名形如 node-v22.20.0-win-x64，倒序取更新
            for dir in dirs {
                // zip 解压后是 node-vX-win-x64/node.exe；也兼容直接放在 runtime/
                let direct = dir.join(name);
                if direct.is_file() && is_usable_node(&direct) {
                    return Some(direct);
                }
                // 再向下一层（有时多一层目录）
                if let Ok(rd) = std::fs::read_dir(&dir) {
                    for e in rd.filter_map(|e| e.ok()) {
                        let p = e.path().join(name);
                        if p.is_file() && is_usable_node(&p) {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }
    None
}

fn find_system_node() -> Option<PathBuf> {
    // 解析 PATH，避免再 spawn `where`（GUI 父进程下会闪黑窗）。
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(node_file_name());
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // 常见 Windows 安装位置兜底
    if cfg!(target_os = "windows") {
        let candidates = [
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files (x86)\nodejs\node.exe",
        ];
        for c in candidates {
            let p = PathBuf::from(c);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn is_usable_node(node_exe: &Path) -> bool {
    if !node_exe.is_file() {
        return false;
    }
    node_major(node_exe).map(|m| m >= MIN_NODE_MAJOR).unwrap_or(false)
}

fn node_major(node_exe: &Path) -> Option<u32> {
    let mut cmd = Command::new(node_exe);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    hidden(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_major(&String::from_utf8_lossy(&out.stdout))
}

fn parse_major(version_line: &str) -> Option<u32> {
    let s = version_line.trim().trim_start_matches('v');
    let major = s.split('.').next()?;
    major.parse().ok()
}

fn dist_archive_name() -> String {
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

fn download_and_extract(
    app: &tauri::AppHandle,
    cache_root: &Path,
    push: &mut dyn FnMut(String),
) -> Result<PathBuf, String> {
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

fn locate_node_in(dir: &Path) -> Option<PathBuf> {
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

fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
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
