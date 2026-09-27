//! dsh 启动方式探测（0.2.0 委派）：dsh 不是二进制——官方形态是 pnpm 工作区脚本，
//! 本机由 Harness Desktop 生成 cmd shim 兜住。适配器 argv 首项为裸 `dsh` 时，
//! 每次 spawn 走探测链解析启动前缀（自愈）；首项是任何其他形式（用户显式填写）
//! 则原样使用。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 捆绑 CLI 的 bin.js 相对位置（dsh-tauri 桌面端依赖目录）。
const BUNDLED_BIN_RELATIVE: &str = r"dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js";
/// Harness Desktop shim 固定安装位置。
const DESKTOP_SHIM: &str = r"deepseek-harness\bin\dsh.cmd";

/// 是否需要探测：argv 首项是裸 `dsh`（出厂形态）即需要；用户显式填写的
/// 其它形式（node+bin.js / pnpm --dir / 绝对路径）原样使用。
pub fn needs_resolution(argv: &[String]) -> bool {
    argv.first().map(String::as_str) == Some("dsh")
}

/// 由探测到的可执行文件构建启动前缀：`.cmd`/`.bat` 必须 `cmd /C` 包一层
/// （Windows CreateProcess 不能直接执行批处理），其余直启。
fn launcher_for(path: &Path) -> Vec<String> {
    let is_script = matches!(
        path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("cmd") | Some("bat")
    );
    if cfg!(windows) && is_script {
        vec!["cmd".into(), "/C".into(), path.to_string_lossy().into_owned()]
    } else {
        vec![path.to_string_lossy().into_owned()]
    }
}

/// 探测链解析结果：启动前缀 + 需要注入子进程的 env（直启捆绑 CLI 时补 DSH_HOME）。
pub struct Resolved {
    pub launcher: Vec<String>,
    pub envs: Vec<(String, String)>,
}

/// 探测链（命中即返回）：
/// 1. PATH 里的 `dsh`（shim 或真实可执行）
/// 2. Harness Desktop shim（`%LOCALAPPDATA%\deepseek-harness\bin\dsh.cmd`）
/// 3. dsh-tauri 捆绑 CLI 直启（`node.exe + bin.js`，env 补 `DSH_HOME`）
pub fn resolve() -> Result<Resolved, String> {
    if let Some(path) = on_path("dsh") {
        return Ok(Resolved {
            launcher: launcher_for(&path),
            envs: Vec::new(),
        });
    }
    if let Some(shim) = desktop_shim() {
        return Ok(Resolved {
            launcher: launcher_for(&shim),
            envs: Vec::new(),
        });
    }
    if let Some(resolved) = bundled_cli() {
        return Ok(resolved);
    }
    Err(probe_failed_message())
}

fn on_path(name: &str) -> Option<PathBuf> {
    let (program, arg) = if cfg!(windows) { ("where", name) } else { ("which", name) };
    let output = Command::new(program).arg(arg).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())?
        .to_string();
    let path = PathBuf::from(&first);
    path.is_file().then_some(path)
}

fn desktop_shim() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let path = PathBuf::from(base).join(DESKTOP_SHIM);
    path.is_file().then_some(path)
}

/// dsh-tauri 捆绑 CLI：bin.js 固定相对位置；node 优先捆绑 runtime，缺则系统
/// `node` 兜底（shim 同序；版本过老时 CLI 自身报错、走 failed 语义）。
fn bundled_cli() -> Option<Resolved> {
    let roaming = std::env::var_os("APPDATA")?;
    let root = PathBuf::from(roaming).join("dsh-tauri");
    let bin = root.join(BUNDLED_BIN_RELATIVE);
    if !bin.is_file() {
        return None;
    }
    let bundled_node = root.join(r"runtime\node.exe");
    let node = if bundled_node.is_file() {
        bundled_node
    } else {
        on_path("node")?
    };
    let mut envs = Vec::new();
    if std::env::var_os("DSH_HOME").is_none() {
        // shim 同款缺省：CLI 靠 DSH_HOME 找 profiles。
        if let Some(home) = dirs_home() {
            envs.push(("DSH_HOME".to_string(), home.join(".dsh").to_string_lossy().into_owned()));
        }
    }
    Some(Resolved {
        launcher: vec![node.to_string_lossy().into_owned(), bin.to_string_lossy().into_owned()],
        envs,
    })
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn probe_failed_message() -> String {
    format!(
        "未找到可用的 dsh 启动方式。已探测：PATH 中的 dsh、Harness Desktop shim（%LOCALAPPDATA%\\{DESKTOP_SHIM}）、\
dsh-tauri 捆绑 CLI（%APPDATA%\\dsh-tauri）。兜底：编辑 delegate.json，把 agents.dsh.argv 的首项 \"dsh\" \
换成明确启动命令，例如 [\"<node.exe>\", \"<dsh>/lib/bin.js\", \"--profile\", \"headless\", \"--json\", \"-\"] \
或 [\"pnpm\", \"--dir\", \"<harness 工作区>\", \"dsh\", \"--profile\", \"headless\", \"--json\", \"-\"]。"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_dsh_needs_resolution_user_form_does_not() {
        assert!(needs_resolution(&["dsh".into(), "--profile".into(), "headless".into()]));
        // 用户显式形态：node 直启 / pnpm --dir / 绝对路径 shim
        assert!(!needs_resolution(&["C:\\node.exe".into(), "bin.js".into()]));
        assert!(!needs_resolution(&["pnpm".into(), "--dir".into(), "harness".into(), "dsh".into()]));
        assert!(!needs_resolution(&["cmd".into(), "/C".into(), r"C:\x\dsh.cmd".into()]));
        assert!(!needs_resolution(&[]));
    }

    #[test]
    #[cfg(windows)]
    fn cmd_scripts_get_cmd_c_wrapper() {
        let launcher = launcher_for(Path::new(r"C:\x\dsh.cmd"));
        assert_eq!(launcher, vec!["cmd", "/C", r"C:\x\dsh.cmd"]);
        let exe = launcher_for(Path::new(r"C:\x\dsh.exe"));
        assert_eq!(exe, vec![r"C:\x\dsh.exe"]);
    }

    #[test]
    #[cfg(not(windows))]
    fn non_windows_direct_launch() {
        let launcher = launcher_for(Path::new("/usr/local/bin/dsh"));
        assert_eq!(launcher, vec!["/usr/local/bin/dsh"]);
    }
}
