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
  /** 非 secret 的 settings 字段当前值（供回填/清空；secret 不回传）。 */
  value?: string;
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
  /** 桌宠互动感知（事件上行 / 闲时门控）。 */
  petInteraction?: PetInteractionSettings;
  sidecar: {
    state: "stopped" | "starting" | "running" | "crashed";
    port: number;
  };
}

/** 桌宠互动感知设置（与 backend interaction.ts 对齐）。 */
export interface PetInteractionSettings {
  mode: "off" | "events" | "context";
  quietMs: number;
  cooldownMs: number;
  maxTriggers: number;
  longHoldMs: number;
}

export interface ChatMessage {
  id: string;
  kind: "user" | "assistant" | "system" | "activity-summary";
  content: string;
  origin: "user" | "assistant" | "presence" | "interaction" | "proactive";
  time: number;
  streaming?: boolean;
  /** 用户消息附带图片（mime + base64，不含 data: 前缀）。 */
  images?: ChatImage[];
  /** 深度思考（reasoning CoT）全文；UI 默认折叠展示。 */
  thinking?: string;
  /** 思考是否仍在流式生成中。 */
  thinkingStreaming?: boolean;
  /** 本步工具调用记录（按发生顺序）。 */
  tools?: ToolActivity[];
  /** kind=activity-summary：折叠「N 次工具调用 · M 条消息」。 */
  toolCount?: number;
  messageCount?: number;
  activityExpanded?: boolean;
  /** 归属活动组 id；组收起时隐藏这些成员消息。 */
  activityGroupId?: string;
  /** 来自重启后的历史加载（非新到达消息）：气泡/朗读等"到达提示"应跳过。 */
  fromHistory?: boolean;
}

export interface ToolActivity {
  name: string;
  status: "call" | "result";
  summary?: string;
  time: number;
  callId?: string;
  isError?: boolean;
}

/** 图片附件（发送/历史/消息气泡共用）。data 为 base64，不含 data: 前缀。 */
export interface ChatImage {
  mime: string;
  data: string;
  name?: string;
}

/** 输入框里待发送的附件（含本地预览 URL）。 */
export interface ComposerAttachment extends ChatImage {
  id: string;
  previewUrl: string;
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
  | { type: "message"; kind: "user" | "assistant" | "system"; sessionId: string; messageId: string; turnMessageId?: string; content: string; origin: "user" | "assistant" | "presence" | "interaction" | "proactive"; time: number; images?: ChatImage[] }
  | { type: "chunk"; messageId: string; delta: string }
  | { type: "thinking"; messageId: string; delta: string }
  | { type: "tool"; name: string; status: "call" | "result"; summary?: string; messageId?: string; callId?: string; isError?: boolean }
  | { type: "turn"; state: "start" | "end"; reason?: string }
  | { type: "busy"; value: boolean }
  | { type: "question"; requestId: string; questions: UserQuestion[] }
  | { type: "error"; message: string };

/** 在线 TTS 声线。 */
export interface TtsVoice {
  id: string;
  name: string;
  lang: string;
}

/** 在线 TTS 配置视图（secret 只回 has_* 布尔）。 */
export interface TtsConfigView {
  enabled: boolean;
  provider: string;
  providerLabel: string;
  voice: string;
  model: string;
  speed: number;
  apiHost: string;
  hasApiKey: boolean;
  resourceId: string;
  styleInstruction: string;
  format: string;
  customVoices: string[];
}

/** 保存 TTS 配置时的补丁（secret 空串 = 留空不改）。 */
export interface TtsConfigPatch {
  enabled?: boolean;
  provider?: string;
  voice?: string;
  model?: string;
  speed?: number;
  apiKey?: string;
  apiHost?: string;
  resourceId?: string;
  styleInstruction?: string;
  format?: string;
  customVoices?: string[];
}

/** 合成结果（base64 音频）。 */
export interface TtsAudio {
  base64: string;
  mime: string;
}