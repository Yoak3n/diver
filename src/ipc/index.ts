// IPC 域模块聚合出口。业务侧可直接从 `./ipc/<domain>` 引入，
// 或经 `../tauri` 兼容桶（历史 import 路径保持不变）。

export * from "./core";
export * from "./tts";
export * from "./sidecar";
export * from "./plugins";
export * from "./petWindow";
export * from "./shortcuts";
export * from "./window";
export * from "./mcp";
export * from "./presence";
