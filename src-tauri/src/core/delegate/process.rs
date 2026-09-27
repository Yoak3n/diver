//! 委派子进程：argv 直启（不经 shell 拼接）+ 树杀 Job + 输出双管收集。
//!
//! Windows 必须把子进程放进 Job Object（KILL_ON_JOB_CLOSE）：dsh 经 cmd shim
//! 拉起 node，只杀 cmd 外壳杀不到 node 整树——cancel/超时靠 drop Job 句柄整树终止。

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::core::sidecar::SidecarJob;

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

/// argv 直启 + 双管后台收集 + 定制 env。`argv[0]` 为程序名（探测链产出的
/// `cmd /C shim`、`node + bin.js`、用户显式命令等形态都直接表达在 argv 里）。
pub fn spawn(argv: &[String], cwd: &Path, envs: &[(String, String)]) -> Result<ChildProc, String> {
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
    spawn_reader(child.stdout.take(), Arc::clone(&stdout));
    spawn_reader(child.stderr.take(), Arc::clone(&stderr));
    let stdin = child.stdin.take();
    Ok(ChildProc {
        child,
        job,
        stdout,
        stderr,
        stdin,
    })
}

fn spawn_reader<R: Read + Send + 'static>(pipe: Option<R>, sink: Arc<Mutex<OutputBuf>>) {
    let Some(mut pipe) = pipe else { return };
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    if let Ok(mut tail) = sink.lock() {
                        tail.push(&chunk);
                    }
                }
            }
        }
    });
}
