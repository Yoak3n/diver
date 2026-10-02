//! 委派子进程：argv 直启（不经 shell 拼接）+ 树杀 Job + 输出双管收集。
//!
//! Windows 必须把子进程放进 Job Object（KILL_ON_JOB_CLOSE）：dsh 经 cmd shim
//! 拉起 node，只杀 cmd 外壳杀不到 node 整树——cancel/超时靠 drop Job 句柄整树终止。
//!
//! 两管同时 tee 落盘（原始字节，`.out`/`.err`）：内存尾部只为摘要服务，
//! 落盘文件是「多通道取消息」的通道一——进程死了照样能读（见 `events.rs`）。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::core::sidecar::SidecarJob;

/// 输出 tee 落盘路径（`<cos_home>/tasks/<id>.out|.err`）。
pub struct TeePaths {
    pub out: PathBuf,
    pub err: PathBuf,
}

/// 输出环形尾部：只保留末尾 `cap` 字符（长流任务内存有界）。
#[derive(Default)]
pub struct OutputBuf {
    buf: String,
    total: u64,
}

impl OutputBuf {
    const CAP: usize = 32_000;

    fn push(&mut self, chunk: &str) {
        self.total += chunk.chars().count() as u64;
        self.buf.push_str(chunk);
        if self.buf.chars().count() > Self::CAP {
            let skip = self.buf.chars().count() - Self::CAP;
            let cut = self
                .buf
                .char_indices()
                .nth(skip)
                .map(|(i, _)| i)
                .unwrap_or(self.buf.len());
            self.buf = self.buf[cut..].to_string();
        }
    }

    pub fn text(&self) -> String {
        self.buf.clone()
    }

    #[allow(dead_code)]
    pub fn total(&self) -> u64 {
        self.total
    }
}

/// 运行中的委派子进程：句柄 + 输出收集句柄。
pub struct ChildProc {
    pub child: Child,
    /// Windows 树杀句柄（Drop 即终止整树）；非 Windows 为 None。
    pub job: Option<SidecarJob>,
    pub stdout: Arc<Mutex<OutputBuf>>,
    pub stderr: Arc<Mutex<OutputBuf>>,
    stdin: Option<std::process::ChildStdin>,
}

impl ChildProc {
    /// 写入任务正文并关闭 stdin（`text_via: stdin` 通道）。
    pub fn write_stdin(&mut self, text: &str) -> Result<(), String> {
        if let Some(mut stdin) = self.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("任务正文写入 stdin 失败：{e}"))?;
            stdin.flush().ok();
        }
        Ok(())
    }

    /// 终止进程树（drop Job 句柄触发 KILL_ON_JOB_CLOSE）。
    pub fn kill_tree(&mut self) {
        self.job.take();
    }
}

/// argv 直启 + 双管后台收集（tee 落盘）+ 定制 env。`argv[0]` 为程序名（探测链产出的
/// `cmd /C shim`、`node + bin.js`、用户显式命令等形态都直接表达在 argv 里）。
pub fn spawn(
    argv: &[String],
    cwd: &Path,
    envs: &[(String, String)],
    tee: &TeePaths,
) -> Result<ChildProc, String> {
    let (program, args) = argv.split_first().ok_or("适配器 argv 为空")?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in envs {
        command.env(key, value);
    }
    let mut child = command.spawn().map_err(|e| format!("spawn {program} 失败：{e}"))?;
    let job = SidecarJob::assign(&mut child);

    let stdout = Arc::new(Mutex::new(OutputBuf::default()));
    let stderr = Arc::new(Mutex::new(OutputBuf::default()));
    spawn_reader(child.stdout.take(), Arc::clone(&stdout), &tee.out);
    spawn_reader(child.stderr.take(), Arc::clone(&stderr), &tee.err);
    let stdin = child.stdin.take();
    Ok(ChildProc {
        child,
        job,
        stdout,
        stderr,
        stdin,
    })
}

fn spawn_reader<R: Read + Send + 'static>(pipe: Option<R>, sink: Arc<Mutex<OutputBuf>>, tee: &Path) {
    let Some(mut pipe) = pipe else { return };
    // tee 打不开只丢通道一，不拦收集（内存尾部仍然可用）。
    let mut tee_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(tee)
        .ok();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Some(file) = tee_file.as_mut() {
                        let _ = file.write_all(&buf[..n]);
                    }
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    if let Ok(mut tail) = sink.lock() {
                        tail.push(&chunk);
                    }
                }
            }
        }
        if let Some(mut file) = tee_file {
            let _ = file.flush();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// tee 落盘：子进程输出既进内存尾部，也逐字节落 `.out` 文件（死后可读）。
    #[cfg(windows)]
    #[test]
    fn spawn_tees_output_to_files() {
        let dir = std::env::temp_dir().join(format!("diver-tee-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let tee = TeePaths {
            out: dir.join("t.out"),
            err: dir.join("t.err"),
        };
        let argv = ["cmd", "/C", "echo tee-marker-42"]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        let mut proc = spawn(&argv, &dir, &[], &tee).unwrap();
        let _ = proc.child.wait();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let out = std::fs::read_to_string(&tee.out).unwrap();
        assert!(out.contains("tee-marker-42"), "tee 文件含子进程输出：{out:?}");
        assert!(lock_text(&proc.stdout).contains("tee-marker-42"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn lock_text(buf: &Mutex<OutputBuf>) -> String {
        buf.lock().map(|b| b.text()).unwrap_or_default()
    }
}
