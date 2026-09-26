//! pid 存活判定（注册表僵尸清扫用）。

/// 进程是否存活。
///
/// - Windows：`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`；
///   打开失败但 `ERROR_ACCESS_DENIED`（存在但非本用户）视为存活。
/// - Linux：`/proc/<pid>` 存在性；无 `/proc` 的 Unix 保守视为存活（不误删）。
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if !handle.is_null() {
            unsafe { CloseHandle(handle) };
            return true;
        }
        return unsafe { GetLastError() } == ERROR_ACCESS_DENIED;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let proc_dir = std::path::Path::new("/proc");
        if proc_dir.exists() {
            proc_dir.join(pid.to_string()).exists()
        } else {
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_process_is_alive() {
        assert!(pid_alive(std::process::id()));
    }

    #[test]
    fn bogus_pids_are_dead() {
        assert!(!pid_alive(0));
        assert!(!pid_alive(0x7FFF_FFFF));
    }
}
