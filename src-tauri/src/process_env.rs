//! 外部工具子进程的环境隔离。
//!
//! AppImage（linuxdeploy 模板）启动时导出
//! `LD_LIBRARY_PATH=<mount>/usr/lib:<mount>/usr/lib/x86_64-linux-gnu:…`，所有子进程
//! 无条件继承。系统二进制于是优先加载 AppImage 自带的旧库，出现符号版本不匹配：
//!
//! - `xz: liblzma.so.5: version 'XZ_5.6.0' not found` → `tar -xf *.tar.xz` 失败
//! - `node: libffi.so.8: version 'LIBFFI_CALL_PLAN_8.4' not found` → 版本探测失败
//!
//! 结果就是「未检测到 Node ≥ 22 → 下载 → 解压失败 → sidecar 启动失败」。
//!
//! 壳自身已加载的库不受影响；这里只给**外部工具**的子进程去掉这两个变量。
//! 仅在 AppImage 环境（`APPDIR` / `APPIMAGE`）内生效，普通安装与开发态行为不变。
//!
//! 另负责 Linux NVIDIA + Wayland 的 WebKitGTK EGL 兼容：必须在 GTK 初始化前
//! 写入 `GDK_BACKEND` / `EGL_PLATFORM`，不能等窗口创建后再补。

use std::process::Command;

/// Linux NVIDIA + Wayland：WebKitGTK 初始化 EGL 时会走
/// `libnvidia-egl-wayland2`，在 `pthread_mutex_lock` 处 SIGSEGV
/// （NVIDIA 615 / Diver 0.2.14-0.2.15 可复现）。在 GTK/WebKit 启动前把
/// GDK 与 EGL 固定到 Xwayland；X11 会话或非 NVIDIA 环境不动。
/// `DIVER_NVIDIA_X11=0` 可显式关闭。
pub(crate) fn apply_linux_nvidia_workaround() {
    #[cfg(target_os = "linux")]
    if linux_nvidia_workaround_needed(
        std::path::Path::new("/proc/driver/nvidia/version").exists(),
        std::env::var_os("WAYLAND_DISPLAY").is_some(),
        std::env::var_os("DISPLAY").is_some(),
        std::env::var_os("DIVER_NVIDIA_X11").is_some_and(|value| value == "0"),
    ) {
        // 必须在 Tauri/GTK 创建线程之前调用。
        std::env::set_var("GDK_BACKEND", "x11");
        std::env::set_var("EGL_PLATFORM", "x11");
    }
}

fn linux_nvidia_workaround_needed(
    nvidia: bool,
    wayland: bool,
    display: bool,
    disabled: bool,
) -> bool {
    nvidia && wayland && display && !disabled
}

/// 剥离 AppImage 注入的动态库搜索路径（Linux AppImage 环境；其它情况原样返回）。
pub(crate) fn strip_appimage_libs(cmd: &mut Command) -> &mut Command {
    let in_appimage =
        std::env::var_os("APPDIR").is_some() || std::env::var_os("APPIMAGE").is_some();
    strip_appimage_libs_with(cmd, in_appimage)
}

/// 决策与执行分离的版本（便于单测，不依赖进程环境）。
fn strip_appimage_libs_with(cmd: &mut Command, in_appimage: bool) -> &mut Command {
    #[cfg(target_os = "linux")]
    if in_appimage {
        cmd.env_remove("LD_LIBRARY_PATH").env_remove("LD_PRELOAD");
    }
    #[cfg(not(target_os = "linux"))]
    let _ = in_appimage;
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_child_drops_dynamic_lib_paths() {
        let mut cmd = Command::new("true");
        strip_appimage_libs_with(&mut cmd, true);
        let cleared: Vec<String> = cmd
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        assert!(cleared.contains(&"LD_LIBRARY_PATH".to_string()));
        assert!(cleared.contains(&"LD_PRELOAD".to_string()));
    }

    #[test]
    fn non_appimage_child_keeps_environment() {
        let mut cmd = Command::new("true");
        strip_appimage_libs_with(&mut cmd, false);
        assert_eq!(cmd.get_envs().count(), 0);
    }

    #[test]
    fn nvidia_wayland_workaround_matrix() {
        assert!(linux_nvidia_workaround_needed(true, true, true, false));
        assert!(!linux_nvidia_workaround_needed(false, true, true, false));
        assert!(!linux_nvidia_workaround_needed(true, false, true, false));
        assert!(!linux_nvidia_workaround_needed(true, true, false, false));
        assert!(!linux_nvidia_workaround_needed(true, true, true, true));
    }
}
