//! 端口残留 sidecar 回收（Windows）。

/// Windows: 预检并回收上一会话残留、仍占用 `port` 的自研 cos sidecar。
///
/// 通过 PowerShell 查询端口监听者：命令行匹配 `companion.ts` /
/// `companion-bundle.ts` 的进程视为本应用的孤儿 sidecar（强杀会话时未被
/// 回收），杀死后放行启动；端口被其他进程占用时返回 `Some(false)`，由调用方
/// 中止启动并给出明确日志。端口空闲、非 Windows 或探测失败返回 `None`（放行）。
/// Windows: 端口占用时才做残留回收（避免首启弹 PowerShell 黑窗）。
///
/// 端口空闲（bind 成功）→ `None` 放行；被占用 → 尝试按 companion 命令行
/// 回收孤儿 sidecar，否则 `Some(false)` 中止。
#[cfg(target_os = "windows")]
pub(super) fn reclaim_stale_sidecar(port: u16) -> Option<bool> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    // 纯 Rust 探测端口：空闲则绝不起子进程（首启零黑窗）。
    if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
        return None;
    }
    log::warn!("端口 {port} 被占用，尝试回收残留 sidecar");
    let script = format!(
        "$conns = Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue; \
         if (-not $conns) {{ exit 0 }}; \
         $found = $false; \
         foreach ($conn in $conns) {{ \
             $procId = $conn.OwningProcess; \
             $proc = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $procId) -ErrorAction SilentlyContinue; \
             if ($proc -and ($proc.CommandLine -like '*companion.ts*' -or $proc.CommandLine -like '*companion-bundle.ts*')) {{ \
                 Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue; \
                 Write-Output ('RECLAIM ' + $procId); \
                 $found = $true \
             }} \
         }}; \
         if (-not $found) {{ Write-Output 'FOREIGN' }}"
    );
    let mut c = Command::new("powershell");
    {
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = c
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("RECLAIM") {
        Some(true)
    } else if stdout.contains("FOREIGN") {
        Some(false)
    } else {
        Some(false)
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn reclaim_stale_sidecar(_port: u16) -> Option<bool> {
    None
}
