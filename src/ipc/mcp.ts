// MCP 服务配置 IPC。

import { invoke } from "./core";

/** MCP 服务配置（设置面板「MCP 服务」页直接编辑的文件，见 config/mcp.rs）。 */
export interface McpServerConfig {
  transport: "stdio";
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  toolCallTimeoutMs: number;
}

export interface McpConfig {
  servers: McpServerConfig[];
}

/** 读取 MCP 服务配置。 */
export function getMcpConfig(): Promise<McpConfig> {
  return invoke<McpConfig>("get_mcp_config");
}

/** 保存 MCP 服务配置，返回是否成功。 */
export function saveMcpConfig(config: McpConfig): Promise<boolean> {
  return invoke<boolean>("save_mcp_config", { config });
}
