//! 本地 TTS：通过 Windows PowerShell + System.Speech (SAPI) 实现，零新增依赖。

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use tauri::Manager as TauriManager;

/// 定位 speak.ps1 资源文件。
/// - dev：`src-tauri/resources/speak.ps1`
/// - release：打包进 bundle 的 resources 目录
pub fn speak_script_path(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/speak.ps1");
        if dev.exists() {
            return dev;
        }
    }
    // release：尝试 bundle resources
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("resources/speak.ps1");
        if bundled.exists() {
            return bundled;
        }
        let flat = dir.join("speak.ps1");
        if flat.exists() {
            return flat;
        }
    }
    // 兜底：dev 布局
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/speak.ps1")
}

/// 异步朗读文本（不阻塞调用线程）。返回是否成功发起。
pub fn speak(app: &tauri::AppHandle, text: &str, voice: Option<&str>) -> bool {
    let script = speak_script_path(app);
    if !script.exists() {
        log::error!("speak.ps1 不存在: {}", script.display());
        return false;
    }
    let mut cmd = Command::new("powershell.exe");
    cmd.arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Some(voice) = voice {
        if !voice.is_empty() {
            cmd.arg("-Voice").arg(voice);
        }
    }

    match cmd.spawn() {
        Ok(mut child) => {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
                drop(stdin);
            }
            // 不等待：异步朗读
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(e) => {
            log::error!("TTS 启动失败: {e}");
            false
        }
    }
}

/// 列出系统已安装的语音（同步，可能耗时数百毫秒）。
pub fn list_voices(app: &tauri::AppHandle) -> Vec<String> {
    let script = speak_script_path(app);
    if !script.exists() {
        return Vec::new();
    }
    let mut cmd = Command::new("powershell.exe");
    cmd.arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script)
        .arg("-ListVoices")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.output() {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            text.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        }
        Err(e) => {
            log::error!("列出语音失败: {e}");
            Vec::new()
        }
    }
}
