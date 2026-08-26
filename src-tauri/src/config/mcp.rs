//! MCP 服务配置：`mcp-servers.json`（app 配置目录）。
//!
//! 该文件是 MCP 客户端（sidecar 内 `@diver/mcp` registry 插件）连接哪些
//! 外部 MCP server 的唯一来源。Tauri 壳负责读写本文件，并在启动 sidecar 时
//! 以 `DIVER_MCP_CONFIG_FILE` 环境变量把绝对路径注入 sidecar 进程；
//! 插件读取该文件、逐个连接，UI 保存后热重载生效（无需重启 sidecar）。
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

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{config_dir, load, save};

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

/// 配置文件绝对路径：`<app_config_dir>/mcp-servers.json`。
pub fn config_path(app: &AppHandle) -> PathBuf {
    config_dir(app).join(FILE_NAME)
}

/// 读取 MCP 配置（文件缺失/解析失败返回空配置，保证应用始终可用）。
pub fn load_config(app: &AppHandle) -> McpConfig {
    load(app, FILE_NAME)
}

/// 保存 MCP 配置，返回是否写盘成功。
pub fn save_config(app: &AppHandle, config: &McpConfig) -> bool {
    save(app, FILE_NAME, config)
}

/// 首次运行初始化：文件不存在时写入默认配置（work-review 示例），
/// 使 sidecar 的 registry 插件在启动时就有可读的 server 列表。
pub fn ensure_initial(app: &AppHandle) {
    let path = config_path(app);
    if path.exists() {
        return;
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
    if !save_config(app, &config) {
        log::error!("初始化 MCP 服务配置失败: {}", path.display());
    }
}
