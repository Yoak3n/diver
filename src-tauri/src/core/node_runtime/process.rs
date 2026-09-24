//! 子进程创建辅助（避免 GUI 父进程弹控制台黑窗）。

use std::process::Command;

/// Windows：子进程不弹控制台黑窗。
#[cfg(target_os = "windows")]
pub(super) fn hidden(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
pub(super) fn hidden(cmd: &mut Command) -> &mut Command {
    cmd
}
