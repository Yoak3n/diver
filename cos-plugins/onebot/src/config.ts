// @diver/onebot — 配置解析（纯函数）。
//
// Config 形状与 configDecl（设置页）字段一一对应（扁平键，列表用逗号/分号分隔），
// resolveConfig 负责归一化与夹紧。安全默认：
// - 未配置 wsUrl → 插件休眠（不连接、不注册任何工具）
// - groups 空 → 不监听任何群（私聊不受此限）
// - OneBot 回合工具白名单基座固定（出话 + 联网检索 + 作用域记忆 + 只读文件
//   四件套 + 自己的笔记追加），allowedTools 只做增量；写入/shell 等本机控制类
//   工具由 sandbox.ts 硬性禁止，只读四件套的目标路径由 fs-jail.ts 囚笼约束，
//   笔记写入由 notes.ts 的作用域/容量规则约束

import type { PluginConfigDecl } from '@cos/plugin-api'
import { isAbsolute } from 'node:path'

import type { VoiceMode } from './voice.ts'

/** 扁平配置（与设置页/patch yml 同形；列表字段为分隔字符串）。 */
export interface Config {
  wsUrl?: string
  token?: string
  /** 主人 QQ 号，逗号分隔；用于提示词、记忆作用域、触发档位与文件囚笼层级。 */
  ownerIds?: string
  /** 群白名单，逗号分隔群号；空 = 不监听任何群。 */
  groups?: string
  /** 昵称/别名（提及检测），逗号分隔。 */
  aliases?: string
  maxMessages?: number
  maxAgeMinutes?: number
  maxChars?: number
  /** 提到别名档回复概率 [0,1]；被 @ 与私聊固定必回，无键。 */
  rateMention?: number
  /** 引用我方消息档回复概率。 */
  rateQuoted?: number
  /** 普通群消息主动插话概率。 */
  ratePlain?: number
  /** 主人在群里未 @/提及/引用时的回应概率（独立于普通档）。 */
  rateOwnerPlain?: number
  /** 每群主动插话冷却（分钟；被 @ / 提及 / 引用不受限）。 */
  cooldownMinutes?: number
  /** 主人普通档的独立冷却（分钟；与普通档互不占用）。 */
  ownerCooldownMinutes?: number
  /** 私聊每用户每小时唤醒上限（0 = 不限制）；超额只记缓冲不回应。 */
  privateMaxPerHour?: number
  /** OneBot 回合在固定基座之上放行的工具名，逗号分隔；硬禁工具会被忽略。 */
  allowedTools?: string
  /** 文件囚笼的额外允许根（绝对路径，逗号分隔）；如 dev 期的插件源码 repo。 */
  fsExtraRoots?: string
  /** 出站遮蔽词条（字面量），逗号分隔。 */
  maskTerms?: string
  /** 出站遮蔽额外正则（JS RegExp source），分号分隔。 */
  extraPatterns?: string
  /** 发送队列相邻两条的最小间隔（毫秒，实现侧风控节流）。 */
  sendIntervalMs?: number
  /** 语音出话：off（默认，配了才开）/ ask（模型显式要求才发）/ auto（另按概率）。 */
  voiceMode?: string
  /** 合成声线覆盖（留空 = 壳层 TTS 配置的全局音色）。 */
  voiceName?: string
  /** 单条语音最大字符数（超出降级文本；QQ 语音上限 60 秒的保守对应）。 */
  voiceMaxChars?: number
  /** auto 模式语音概率。 */
  voiceRate?: number
  /** 同一群/私聊两次语音的最小间隔（分钟）。 */
  voiceCooldownMinutes?: number
  /** 单次合成超时（毫秒；超时降级文本）。 */
  voiceTimeoutMs?: number
}

export interface ResolvedConfig {
  wsUrl: string
  token: string
  ownerIds: string[]
  groups: string[]
  aliases: string[]
  context: { maxMessages: number; maxAgeMinutes: number; maxChars: number }
  rate: { mention: number; quoted: number; plain: number; ownerPlain: number }
  cooldownMinutes: number
  ownerCooldownMinutes: number
  privateMaxPerHour: number
  sandbox: { allowedTools: string[]; fsExtraRoots: string[] }
  privacy: { maskTerms: string[]; extraPatterns: string[] }
  sendIntervalMs: number
  voice: {
    mode: VoiceMode
    name: string
    maxChars: number
    rate: number
    cooldownMinutes: number
    timeoutMs: number
  }
}

/**
 * OneBot 回合的固定基座（见 sandbox.ts）：
 * 出话三件套 + 受控联网 + 作用域记忆 + 只读文件四件套（路径囚笼见 fs-jail.ts）
 * + 自己的笔记追加（作用域/容量见 notes.ts）。
 */
export const BASELINE_TOOLS = [
  'send_qq_group',
  'send_qq_private',
  'stay_silent',
  'web_search',
  'web_explore',
  'recall',
  'remember',
  // 只读环境感知：COS_HOME 囚笼内可读（含 workspace 与 profiles 插件源码），
  // 基线扣会话记录/敏感落盘，主人私聊近全开。
  'read',
  'ls',
  'find',
  'grep',
  // 唯一写入口：只能往当前来源自己的笔记作用域追加，不能覆盖/删除。
  'append_note',
] as const

/** 普通消息唤醒后的群聊静默窗（毫秒）：等话头停了再评估，不打断进行中对话。 */
export const PLAIN_DEBOUNCE_MS = 8_000

/**
 * 归属闸门（纯函数）：壳层把全局单选的 QQ 归属实例经 `DIVER_ONEBOT_OWNER`
 * 下发给所有 sidecar；绑定时仅归属实例可激活，未绑定时保持旧「配置即归属」
 * 行为（单实例零迁移）。`selfId` 为本 sidecar 的 `DIVER_INSTANCE_ID`。
 */
export function ownerGate(owner: string, selfId: string): boolean {
  return owner === '' || owner === selfId
}

/** 连续沉默退避参数（MaiBot no_action_backoff 同值）：基数 15s、上限 300s、第 2 连开始。 */
export const BACKOFF_BASE_MS = 15_000
export const BACKOFF_CAP_MS = 300_000
export const BACKOFF_START_STREAK = 2
/** 退避等待期新消息攒满此数提前重估。 */
export const BACKOFF_BYPASS_COUNT = 6

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function num(value: unknown, fallback: number, lo: number, hi: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback
}

function splitList(value: unknown, sep: string): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 归一化 + 夹紧；非法输入回退默认，不抛（配置错误只降级不断连）。 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  return {
    wsUrl: typeof config.wsUrl === 'string' ? config.wsUrl.trim() : '',
    token: typeof config.token === 'string' ? config.token.trim() : '',
    ownerIds: splitList(config.ownerIds, ',').filter((id) => /^\d+$/.test(id)),
    groups: splitList(config.groups, ','),
    aliases: splitList(config.aliases, ','),
    context: {
      maxMessages: Math.round(num(config.maxMessages, 40, 5, 200)),
      maxAgeMinutes: Math.round(num(config.maxAgeMinutes, 30, 1, 720)),
      maxChars: Math.round(num(config.maxChars, 4000, 500, 20000)),
    },
    rate: {
      mention: num(config.rateMention, 0.9, 0, 1),
      quoted: num(config.rateQuoted, 0.8, 0, 1),
      plain: num(config.ratePlain, 0.05, 0, 1),
      ownerPlain: num(config.rateOwnerPlain, 0.3, 0, 1),
    },
    cooldownMinutes: num(config.cooldownMinutes, 15, 0, 720),
    ownerCooldownMinutes: num(config.ownerCooldownMinutes, 5, 0, 720),
    privateMaxPerHour: Math.round(num(config.privateMaxPerHour, 30, 0, 600)),
    sandbox: {
      allowedTools: splitList(config.allowedTools, ','),
      fsExtraRoots: splitList(config.fsExtraRoots, ',').filter((p) => isAbsolute(p)),
    },
    privacy: {
      maskTerms: splitList(config.maskTerms, ','),
      extraPatterns: splitList(config.extraPatterns, ';'),
    },
    sendIntervalMs: Math.round(num(config.sendIntervalMs, 1500, 200, 60_000)),
    voice: {
      mode: config.voiceMode === 'ask' || config.voiceMode === 'auto' ? config.voiceMode : 'off',
      name: typeof config.voiceName === 'string' ? config.voiceName.trim() : '',
      maxChars: Math.round(num(config.voiceMaxChars, 100, 10, 300)),
      rate: num(config.voiceRate, 0.15, 0, 1),
      cooldownMinutes: num(config.voiceCooldownMinutes, 10, 0, 720),
      timeoutMs: Math.round(num(config.voiceTimeoutMs, 20_000, 3_000, 60_000)),
    },
  }
}

export const configDecl: PluginConfigDecl = {
  title: 'OneBot 11（QQ）',
  fields: [
    {
      key: 'wsUrl',
      label: '正向 WebSocket 地址',
      type: 'text',
      section: '连接',
      description: '如 ws://127.0.0.1:3001；留空 = 插件休眠',
    },
    {
      key: 'token',
      label: 'access token',
      type: 'password',
      secret: true,
      section: '连接',
      description: 'OneBot 实现的 access_token，可留空',
    },
    { key: 'sendIntervalMs', label: '发送间隔（毫秒）', type: 'number', section: '连接', default: 1500, description: '实现侧风控节流' },
    {
      key: 'ownerIds',
      label: '主人 QQ 号',
      type: 'text',
      section: '身份与监听',
      description: '逗号分隔；用于提示词、记忆作用域、触发档位与文件囚笼层级（主人私聊近全开，群内仍走基线）',
    },
    { key: 'groups', label: '监听的群', type: 'text', section: '身份与监听', description: '逗号分隔群号；空 = 不监听任何群' },
    { key: 'aliases', label: '昵称/别名', type: 'text', section: '身份与监听', description: '逗号分隔；群消息提到即高概率回应' },
    { key: 'maxMessages', label: '上下文条数上限', type: 'number', section: '回合上下文', default: 40 },
    { key: 'maxAgeMinutes', label: '上下文时间窗（分钟）', type: 'number', section: '回合上下文', default: 30 },
    { key: 'maxChars', label: '上下文字符上限', type: 'number', section: '回合上下文', default: 4000 },
    { key: 'rateMention', label: '提及回应概率', type: 'number', section: '触发与节流', default: 0.9 },
    { key: 'rateQuoted', label: '被引用回应概率', type: 'number', section: '触发与节流', default: 0.8 },
    {
      key: 'ratePlain',
      label: '主动插话概率',
      type: 'number',
      section: '触发与节流',
      default: 0.05,
      description: '普通群消息经冷却/退避门控后的抽样概率',
    },
    {
      key: 'rateOwnerPlain',
      label: '主人发言回应概率',
      type: 'number',
      section: '触发与节流',
      default: 0.3,
      description: '主人在群里未 @/提及/引用你时的抽样概率；独立于普通群消息，另有独立冷却',
    },
    { key: 'cooldownMinutes', label: '插话冷却（分钟）', type: 'number', section: '触发与节流', default: 15 },
    {
      key: 'ownerCooldownMinutes',
      label: '主人发言冷却（分钟）',
      type: 'number',
      section: '触发与节流',
      default: 5,
      description: '主人普通档两次评估的最小间隔；与普通档冷却分开计，不会被群聊冷却压住',
    },
    {
      key: 'privateMaxPerHour',
      label: '私聊唤醒上限（次/小时）',
      type: 'number',
      section: '触发与节流',
      default: 30,
      description: '每用户每小时最多唤醒的私聊回合；超出只记入缓冲不回应（防刷）。0 = 不限制',
    },
    {
      key: 'allowedTools',
      label: 'OneBot 回合额外放行工具',
      type: 'text',
      section: '工具与文件',
      description: '逗号分隔工具名；基座（出话/联网/记忆/只读文件/笔记追加）之外的白名单。写入/编辑、shell、截图、委派、MCP、web_read 等硬禁名称会被忽略',
    },
    {
      key: 'fsExtraRoots',
      label: '文件囚笼额外根',
      type: 'text',
      section: '工具与文件',
      description: '逗号分隔绝对路径；在 COS_HOME 之外追加可读目录（如开发期的插件源码 repo）。留空 = 仅 COS_HOME',
    },
    { key: 'maskTerms', label: '出站遮蔽词条', type: 'text', section: '出站遮蔽', description: '逗号分隔字面量（如真名/住址），发出前替换为 [已遮蔽]' },
    { key: 'extraPatterns', label: '出站遮蔽正则', type: 'text', section: '出站遮蔽', description: '分号分隔 RegExp source' },
    {
      key: 'voiceMode',
      label: '语音出话',
      type: 'select',
      section: '语音',
      options: [
        { value: 'off', label: '关闭（默认，配了才开）' },
        { value: 'ask', label: '仅在模型要求时' },
        { value: 'auto', label: '按概率自动' },
      ],
      default: 'off',
      description: '需先在「语音」设置里启用在线 TTS；任何合成失败都会降级发文本',
    },
    { key: 'voiceName', label: '语音声线覆盖', type: 'text', section: '语音', description: '留空 = 跟随全局 TTS 音色' },
    { key: 'voiceMaxChars', label: '语音最大字数', type: 'number', section: '语音', default: 100, description: '超出改发文本（QQ 语音上限 60 秒）' },
    { key: 'voiceRate', label: '自动语音概率', type: 'number', section: '语音', default: 0.15, description: '仅 auto 模式生效' },
    { key: 'voiceCooldownMinutes', label: '语音冷却（分钟）', type: 'number', section: '语音', default: 10, description: '同一群/私聊两次语音的最小间隔' },
    { key: 'voiceTimeoutMs', label: '语音合成超时（毫秒）', type: 'number', section: '语音', default: 20000 },
  ],
}
