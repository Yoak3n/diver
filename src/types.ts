// Diver 陪伴 UI — 类型定义

export interface HealthInfo {
  ok: boolean;
  persona: string;
  provider: string;
  model: string;
  modelConfigured: boolean;
  memoryPort?: number;
  sessionId: string | null;
  busy: boolean;
}

export interface ModelEntry {
  provider: string;
  id: string;
}

/** provider 插件声明的配置字段（设置面板据此动态渲染）。 */
export interface ConfigFieldDecl {
  key: string;
  label: string;
  type: "password" | "text" | "select";
  secret?: boolean;
  store: "credentials" | "settings";
  credentialRef?: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  options?: string[];
  /** 服务端解析的当前状态（secret 字段只回传布尔）。 */
  configured?: boolean;
}

export interface ProviderConfigDecl {
  provider: string;
  name: string;
  description?: string;
  fields: ConfigFieldDecl[];
}

export interface SettingsInfo {
  modelConfigured: boolean;
  provider: string;
  model: string;
  models: ModelEntry[];
  providers: ProviderConfigDecl[];
  ttsEnabled: boolean;
  ttsVoice: string;
  sidecar: {
    state: "stopped" | "starting" | "running" | "crashed";
    port: number;
  };
}

export interface ChatMessage {
  id: string;
  kind: "user" | "assistant" | "system";
  content: string;
  origin: "user" | "assistant" | "presence";
  time: number;
  streaming?: boolean;
  /** 来自重启后的历史加载（非新到达消息）：气泡/朗读等"到达提示"应跳过。 */
  fromHistory?: boolean;
}

export interface ToolActivity {
  name: string;
  status: "call" | "result";
  summary?: string;
  time: number;
}

/** Rust 侧 sidecar 状态（Tauri 命令 get_sidecar_status 返回）。 */
export interface SidecarStatus {
  state: "stopped" | "starting" | "running" | "crashed";
  port: number;
  logs: string[];
}

// SSE 事件（companion-web 插件协议）
export interface UserQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface UserQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export type StreamEvent =
  | { type: "hello"; persona: string; provider: string; model: string; modelConfigured: boolean; sessionId: string | null; busy: boolean }
  | { type: "message"; kind: "user" | "assistant" | "system"; sessionId: string; messageId: string; turnMessageId?: string; content: string; origin: "user" | "assistant" | "presence"; time: number }
  | { type: "chunk"; messageId: string; delta: string }
  | { type: "tool"; name: string; status: "call" | "result"; summary?: string }
  | { type: "turn"; state: "start" | "end"; reason?: string }
  | { type: "busy"; value: boolean }
  | { type: "question"; requestId: string; questions: UserQuestion[] }
  | { type: "error"; message: string };
