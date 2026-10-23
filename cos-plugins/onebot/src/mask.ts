// @diver/onebot — 出站隐私遮蔽（纯函数）。
//
// 出话工具是发往 QQ 的唯一出口，maskOutbound 是硬兜底总闸：本地路径/凭据/
// 联系方式在离开本机前替换为占位标记。只遮「陪伴自己说出的话」——入站群友
// 消息是他们在群里公开发的内容，不在此处理。
//
// 设计约束：幂等（遮蔽结果再过一遍不变，占位词不得再命中）；误报从宽
// （宁可漏遮短数字，不可把普通句子打碎）。遮蔽统计回给模型与本地日志，
// 被遮原文不出本机。

import type { ResolvedConfig } from './config.ts'

export type MaskKind = 'path' | 'credential' | 'email' | 'phone' | 'idcard' | 'term' | 'custom'

export interface MaskHit {
  kind: MaskKind
  count: number
}

export interface MaskResult {
  text: string
  masked: MaskHit[]
}

const PLACEHOLDER: Record<MaskKind, string> = {
  path: '[路径]',
  credential: '[凭据]',
  email: '[邮箱]',
  phone: '[手机号]',
  idcard: '[证件号]',
  term: '[已遮蔽]',
  custom: '[已遮蔽]',
}

/** Windows 盘符路径（C:\...，含反斜杠链）。 */
const WIN_PATH = /[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']*/g
/** 常见 Unix 根下的绝对路径（/home /Users /root /mnt /media /data /tmp + ~）。 */
const UNIX_PATH = /(?:~|\/(?:home|Users|root|mnt|media|data|tmp)(?:\/[^\s"'`，。；、）】]+)+)/g
/** 有前缀语义的凭据（sk-/ak-/ghp-/xox… 等；HTTP Bearer 头按空格形态）。 */
const CRED_PREFIXED = /\b(?:Bearer\s+|(?:sk|ak|rk|pk|ghp|gho|ghu|ghs|xoxb|xoxp|xoxa)[-_])[A-Za-z0-9_-]{8,}/g
/** 长 hex（32+，如 API key 摘要、token）。 */
const HEX_RUN = /\b[A-Fa-f0-9]{32,}\b/g
/** 长 base64 风格串（40+，混合大小写数字）。 */
const B64_RUN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g
const IDCARD = /(?<!\d)\d{17}[\dXx](?!\d)/g

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function applyRule(text: string, source: RegExp, kind: MaskKind, masked: Map<MaskKind, number>): string {
  let count = 0
  const out = text.replace(source, () => {
    count += 1
    return PLACEHOLDER[kind]
  })
  if (count > 0) masked.set(kind, (masked.get(kind) ?? 0) + count)
  return out
}

/**
 * 出站遮蔽。规则按误报风险升序（词条/正则最后），全局共享替换产物，
 * 前面规则替换出的占位词不会被后面规则二次命中。
 */
export function maskOutbound(text: string, cfg: ResolvedConfig['privacy']): MaskResult {
  const masked = new Map<MaskKind, number>()
  let out = text

  out = applyRule(out, CRED_PREFIXED, 'credential', masked)
  out = applyRule(out, WIN_PATH, 'path', masked)
  out = applyRule(out, UNIX_PATH, 'path', masked)
  out = applyRule(out, HEX_RUN, 'credential', masked)
  out = applyRule(out, B64_RUN, 'credential', masked)
  out = applyRule(out, EMAIL, 'email', masked)
  out = applyRule(out, PHONE, 'phone', masked)
  out = applyRule(out, IDCARD, 'idcard', masked)

  for (const term of cfg.maskTerms) {
    // 词条动态构造，不能用共享 RegExp（lastIndex 状态）
    out = applyRule(out, new RegExp(escapeRegex(term), 'g'), 'term', masked)
  }
  for (const pattern of cfg.extraPatterns) {
    try {
      out = applyRule(out, new RegExp(pattern, 'g'), 'custom', masked)
    } catch {
      // 坏正则跳过（resolveConfig 已尽力，运行期仍防御）
    }
  }

  return { text: out, masked: [...masked].map(([kind, count]) => ({ kind, count })) }
}
