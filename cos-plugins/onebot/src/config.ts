// @diver/onebot — 配置解析（纯函数）。
//
// Config 形状与 configDecl（设置页）字段一一对应（扁平键，列表用逗号/分号分隔），
// resolveConfig 负责归一化与夹紧。安全默认：
// - 未配置 wsUrl → 插件休眠（不连接、不注册任何工具）
// - groups 空 → 不监听任何群（私聊不受此限）
// - OneBot 回合工具白名单基座固定为出话三件套，allowedTools 只做增量

import type { PluginConfigDecl } from '@cos/plugin-api'

/** 扁平配置（与设置页/patch yml 同形；列表字段为分隔字符串）。 */
export interface Config {
  wsUrl?: string
  token?: string
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
  /** 每群主动插话冷却（分钟；被 @ / 提及 / 引用不受限）。 */
  cooldownMinutes?: number
  /** OneBot 回合在基座（出话三件套）之上放行的工具名，逗号分隔。 */
  allowedTools?: string
  /** 出站遮蔽词条（字面量），逗号分隔。 */
  maskTerms?: string
  /** 出站遮蔽额外正则（JS RegExp source），分号分隔。 */
  extraPatterns?: string
  /** 发送队列相邻两条的最小间隔（毫秒，实现侧风控节流）。 */
  sendIntervalMs?: number
}

export interface ResolvedConfig {
  wsUrl: string
  token: string
  groups: string[]
  aliases: string[]
  context: { maxMessages: number; maxAgeMinutes: number; maxChars: number }
  rate: { mention: number; quoted: number; plain: number }
  cooldownMinutes: number
  sandbox: { allowedTools: string[] }
  privacy: { maskTerms: string[]; extraPatterns: string[] }
  sendIntervalMs: number
}

/** 出话三件套：OneBot 回合的固定基座（见 sandbox.ts）。 */
export const BASELINE_TOOLS = ['send_qq_group', 'send_qq_private', 'stay_silent'] as const

/** 普通消息唤醒后的群聊静默窗（毫秒）：等话头停了再评估，不打断进行中对话。 */
export const PLAIN_DEBOUNCE_MS = 8_000

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
    },
    cooldownMinutes: num(config.cooldownMinutes, 15, 0, 720),
    sandbox: { allowedTools: splitList(config.allowedTools, ',') },
    privacy: {
      maskTerms: splitList(config.maskTerms, ','),
      extraPatterns: splitList(config.extraPatterns, ';'),
    },
    sendIntervalMs: Math.round(num(config.sendIntervalMs, 1500, 200, 60_000)),
  }
}

export const configDecl: PluginConfigDecl = {
  title: 'OneBot 11（QQ）',
  fields: [
    {
      key: 'wsUrl',
      label: '正向 WebSocket 地址',
      type: 'text',
      description: '如 ws://127.0.0.1:3001；留空 = 插件休眠',
    },
    { key: 'token', label: 'access token', type: 'password', description: 'OneBot 实现的 access_token，可留空' },
    { key: 'groups', label: '监听的群', type: 'text', description: '逗号分隔群号；空 = 不监听任何群' },
    { key: 'aliases', label: '昵称/别名', type: 'text', description: '逗号分隔；群消息提到即高概率回应' },
    { key: 'maxMessages', label: '上下文条数上限', type: 'number', default: 40 },
    { key: 'maxAgeMinutes', label: '上下文时间窗（分钟）', type: 'number', default: 30 },
    { key: 'maxChars', label: '上下文字符上限', type: 'number', default: 4000 },
    { key: 'rateMention', label: '提及回应概率', type: 'number', default: 0.9 },
    { key: 'rateQuoted', label: '被引用回应概率', type: 'number', default: 0.8 },
    { key: 'ratePlain', label: '主动插话概率', type: 'number', default: 0.05, description: '普通群消息经冷却/退避门控后的抽样概率' },
    { key: 'cooldownMinutes', label: '插话冷却（分钟）', type: 'number', default: 15 },
    {
      key: 'allowedTools',
      label: 'OneBot 回合额外放行工具',
      type: 'text',
      description: '逗号分隔工具名；基座（send_qq_group/send_qq_private/stay_silent）之外的白名单，建议只放 web_search 这类只读工具',
    },
    { key: 'maskTerms', label: '出站遮蔽词条', type: 'text', description: '逗号分隔字面量（如真名/住址），发出前替换为 [已遮蔽]' },
    { key: 'extraPatterns', label: '出站遮蔽正则', type: 'text', description: '分号分隔 RegExp source' },
    { key: 'sendIntervalMs', label: '发送间隔（毫秒）', type: 'number', default: 1500, description: '实现侧风控节流' },
  ],
}
