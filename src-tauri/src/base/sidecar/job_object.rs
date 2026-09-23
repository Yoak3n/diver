//! Windows：把子进程放进 Job Object，进程树随 Job 一起被清理。
//!
//! 设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` —— Job 的最后一个句柄关闭时，系统
//! 强制终止 Job 内**全部**进程（含 agent 经 sh 工具拉起的 powershell 等孙进程）。
//! 这样即使应用被强杀（任务管理器结束、崩溃、`ExitRequested` 被跳过），sidecar
//! 进程树也不会变成孤儿常驻内存。
//!
//! 注意：Rust 标准库的 `Child` 在子进程退出时会自动关闭进程句柄，而 Job 句柄
//! 独立持有（存进 `SidecarManager`），只要 Job 句柄未关闭就不会触发误杀。

use std::process::Child;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROCESS_SET_QUOTA;
use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;

pub struct SidecarJob {
    handle: HANDLE,
}

unsafe impl Send for SidecarJob {}
unsafe impl Sync for SidecarJob {}

impl SidecarJob {
    pub fn assign(child: &Child) -> Option<Self> {
        unsafe {
            // 匿名 Job（无名句柄）：避免与系统里其他"同名 Job"（可能来自别的
            // Diver 实例或残留）冲突，也无需跨进程引用该名字。
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            // 先放行所有子进程（含后代）进 Job，再叠加 KILL_ON_JOB_CLOSE。
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return None;
            }
            // 用目标 pid 开一个带权限的句柄（Child 的进程句柄不一定带
            // PROCESS_SET_QUOTA / PROCESS_TERMINATE，Assign 会失败）。
            let pid = child.id() as u32;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                CloseHandle(job);
                return None;
            }
            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assigned == 0 {
                CloseHandle(job);
                return None;
            }
            Some(SidecarJob { handle: job })
        }
    }
}

impl Drop for SidecarJob {
    fn drop(&mut self) {
        // Job 句柄关闭 → 系统按 KILL_ON_JOB_CLOSE 终止 Job 内所有进程。
        unsafe {
            CloseHandle(self.handle);
        }
    }
}
