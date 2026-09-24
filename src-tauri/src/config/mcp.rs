//! MCP 服务配置：`mcp-servers.json`（cos 数据家园 `$COS_HOME` 下）。
//!
//! 该文件是 MCP 客户端（sidecar 内 `@diver/mcp` registry 插件）连接哪些
//! 外部 MCP server 的唯一来源。Tauri 壳负责读写本文件，并在启动 sidecar 时
//! 以 `DIVER_MCP_CONFIG_FILE` 环境变量把绝对路径注入 sidecar 进程；
//! 插件读取该文件、逐个连接，UI 保存后热重载生效（无需重启 sidecar）。
//!
//! 文件必须放在 `$COS_HOME`（与 `diver-settings.json` 同目录）下：sidecar 插件
//! 默认按 `$COS_HOME/mcp-servers.json` 解析（见 `@diver/mcp` 的
//! `config-file.ts`），Tauri 壳的 [cos_home] 与 sidecar 注入的 `COS_HOME` 完全一致。
//! 早期版本误写在 `app_config_dir`（`$COS_HOME` 的父目录），已提供迁移
//! （见 [ensure_initial]）。
//!
//! 文件格式：
//! ```json
//! {
//!   "servers": [
//!     {
//!       "transport": "stdio",
//!       "serverName": "work-review",
//!       "command": "E:\\...\\server.exe",
//!       "args": [],
//!       "env": { "KEY": "value" },
//!       "cwd": "",
//!       "toolCallTimeoutMs": 30000
//!     }
//!   ]
//! }
//! ```

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{config_dir, cos_home, load_at, save_at};

/// 配置文件名称。
pub const FILE_NAME: &str = "mcp-servers.json";

/// 单个 MCP server 配置（与 sidecar `@diver/mcp` 的 StdioConfig 对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// stdio transport（当前唯一支持）。
    #[serde(default = "default_transport")]
    pub transport: String,
    /// 唯一标识（字母数字/下划线/连字符，≤32）。
    pub server_name: String,
    /// 启动命令（可执行文件路径或 shell 命令）。
    pub command: String,
    /// 启动参数。
    #[serde(default)]
    pub args: Vec<String>,
    /// 注入的环境变量（叠加父进程环境）。
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// 工作目录（空 = 继承 sidecar 进程）。
    #[serde(default)]
    pub cwd: String,
    /// 单次工具调用超时（毫秒）。
    #[serde(default = "default_tool_call_timeout")]
    pub tool_call_timeout_ms: u64,
}

fn default_transport() -> String {
    "stdio".into()
}

fn default_tool_call_timeout() -> u64 {
    60_000
}

/// MCP 配置文件内容。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpConfig {
    #[serde(default)]
    pub servers: Vec<McpServerConfig>,
}

/// 纯路径：配置文件绝对路径 `<cos_home>/mcp-servers.json`。
pub fn config_path_at(cos_home: &Path) -> PathBuf {
    cos_home.join(FILE_NAME)
}

/// 配置文件绝对路径：`<cos_home>/mcp-servers.json`（与 `diver-settings.json` 同目录）。
pub fn config_path(app: &AppHandle) -> PathBuf {
    config_path_at(&cos_home(app))
}

/// 纯路径读取 MCP 配置（文件缺失/解析失败返回空配置）。
pub fn load_config_at(cos_home: &Path) -> McpConfig {
    load_at(cos_home, FILE_NAME)
}

/// 纯路径保存 MCP 配置，返回是否写盘成功。
pub fn save_config_at(cos_home: &Path, config: &McpConfig) -> bool {
    save_at(cos_home, FILE_NAME, config)
}

/// 读取 MCP 配置（文件缺失/解析失败返回空配置，保证应用始终可用）。
pub fn load_config(app: &AppHandle) -> McpConfig {
    load_config_at(&cos_home(app))
}

/// 保存 MCP 配置，返回是否写盘成功。
pub fn save_config(app: &AppHandle, config: &McpConfig) -> bool {
    save_config_at(&cos_home(app), config)
}

/// 纯路径：首次运行初始化 + 旧位置迁移。
///
/// `cos_home`：目标目录；`shell_config_dir`：旧位置（`app_config_dir`）迁移来源。
pub fn ensure_initial_at(cos_home: &Path, shell_config_dir: &Path) {
    let path = config_path_at(cos_home);
    if path.exists() {
        return;
    }

    // 旧位置迁移：`<app_config_dir>/mcp-servers.json` → `<cos_home>/mcp-servers.json`。
    let legacy = shell_config_dir.join(FILE_NAME);
    if legacy.exists() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match std::fs::rename(&legacy, &path) {
            Ok(()) => {
                log::info!("已迁移 MCP 配置文件: {} -> {}", legacy.display(), path.display());
                return;
            }
            Err(e) => {
                log::warn!("迁移 MCP 配置文件失败（保留旧文件，将写入默认配置）: {e}");
            }
        }
    }

    let config = McpConfig {
        servers: vec![McpServerConfig {
            transport: "stdio".into(),
            server_name: "work-review".into(),
            command: r"E:\Utils\Work Review\work-review-mcp-server.exe".into(),
            args: vec![],
            env: std::collections::BTreeMap::from([
                (
                    "WORK_REVIEW_DB_PATH".into(),
                    r"E:\Utils\Work Review\cache\workreview.db".into(),
                ),
                (
                    "WORK_REVIEW_CONFIG_PATH".into(),
                    r"E:\Utils\Work Review\cache\config.json".into(),
                ),
            ]),
            cwd: String::new(),
            tool_call_timeout_ms: 30_000,
        }],
    };
    if !save_config_at(cos_home, &config) {
        log::error!("初始化 MCP 服务配置失败: {}", path.display());
    }
}

/// 首次运行初始化 + 旧位置迁移。
///
/// 早期版本把 `mcp-servers.json` 写在 `app_config_dir`（`$COS_HOME` 的父目录），
/// 而 sidecar 插件按 `$COS_HOME/mcp-servers.json` 读取，导致 registry 读到空列表。
/// 这里把既有文件迁移到新位置（仅当目标缺失时，避免覆盖已有配置）；
/// 目标存在或迁移失败时，若仍无配置则写入默认示例（work-review），
/// 使 sidecar 的 registry 插件在启动时就有可读的 server 列表。
pub fn ensure_initial(app: &AppHandle) {
    ensure_initial_at(&cos_home(app), &config_dir(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("diver-mcp-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn load_save_at_roundtrip() {
        let home = tmp("rt");
        let cfg = McpConfig {
            servers: vec![McpServerConfig {
                transport: "stdio".into(),
                server_name: "demo".into(),
                command: "cmd".into(),
                args: vec!["-c".into()],
                env: Default::default(),
                cwd: String::new(),
                tool_call_timeout_ms: 1000,
            }],
        };
        assert!(save_config_at(&home, &cfg));
        let loaded = load_config_at(&home);
        assert_eq!(loaded.servers.len(), 1);
        assert_eq!(loaded.servers[0].server_name, "demo");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn ensure_initial_migrates_legacy() {
        let home = tmp("mig-home");
        let shell = tmp("mig-shell");
        let cfg = McpConfig {
            servers: vec![McpServerConfig {
                transport: "stdio".into(),
                server_name: "legacy".into(),
                command: "x".into(),
                args: vec![],
                env: Default::default(),
                cwd: String::new(),
                tool_call_timeout_ms: 1000,
            }],
        };
        assert!(save_config_at(&shell, &cfg));
        ensure_initial_at(&home, &shell);
        assert!(config_path_at(&home).is_file());
        assert!(!config_path_at(&shell).is_file());
        assert_eq!(load_config_at(&home).servers[0].server_name, "legacy");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&shell);
    }

    #[test]
    fn ensure_initial_writes_default_when_missing() {
        let home = tmp("init");
        let shell = tmp("init-shell");
        ensure_initial_at(&home, &shell);
        let cfg = load_config_at(&home);
        assert_eq!(cfg.servers.len(), 1);
        assert_eq!(cfg.servers[0].server_name, "work-review");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&shell);
    }
}
