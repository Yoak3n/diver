// @diver/web-tools — 联网探索工具（Explore 执行面）。
//
// 参照 bladebro（E:\GitVault\bladebro）的正文抽取（findMain / isAd / toMd）
// 与预算截断思路，但**不做** CDP / stealth / 自由浏览：
// 只暴露 3 个可控工具，服务 companion-presence-fsm §7.4 的 web_explore：
//   web_search  — 搜索（ddg/bing HTML，无 API key）
//   web_read    — 读一页正文（markdown，硬预算）
//   web_explore — 搜索 + 读前 N 页 + 汇总卡片（一次调用在预算内结束）
//
// 约束（可控性）：
// - 私网 / 非 http(s) 拒绝；allowHosts / denyHosts 策略过滤
// - maxResults / maxPages / maxCharsPerPage / maxTotalChars / timeoutMs 硬夹紧
// - 不注册点击、填表、任意 JS —— Explore 只向外看，不替用户操作
//
// 接入：bundle-companion cordis.patch.yml insert `{ id: web-tools, name: '@diver/web-tools' }`
// 之后 memory/explore 或对话 agent 均可调用上述工具。

import type { Context } from 'cordis'
import type { PluginConfigDecl } from '@cos/plugin-api'

import { DEFAULT_POLICY, resolvePolicy, WebError, type PolicyOverrides } from './policy.ts'
import { webSearch, formatSearchHits } from './search.ts'
import { exploreTerm, readPage } from './explore.ts'

export const name = 'web-tools'

export const inject = ['tools', 'systemPrompt']

export const configDecl: PluginConfigDecl = {
  title: '联网探索',
  fields: [
    {
      key: 'engine',
      label: '搜索后端',
      type: 'select',
      options: [
        { value: 'ddg', label: 'DuckDuckGo HTML' },
        { value: 'bing', label: 'Bing HTML' },
      ],
      default: 'ddg',
      description: '无 API key 的搜索抓取后端',
    },
    {
      key: 'maxResults',
      label: '搜索条数上限',
      type: 'number',
      default: DEFAULT_POLICY.maxResults,
    },
    {
      key: 'maxPages',
      label: 'Explore 读页上限',
      type: 'number',
      default: DEFAULT_POLICY.maxPages,
    },
    {
      key: 'maxCharsPerPage',
      label: '单页正文字符上限',
      type: 'number',
      default: DEFAULT_POLICY.maxCharsPerPage,
    },
    {
      key: 'maxTotalChars',
      label: 'Explore 总字符预算',
      type: 'number',
      default: DEFAULT_POLICY.maxTotalChars,
    },
    {
      key: 'allowHosts',
      label: '允许的 host（可选）',
      type: 'text',
      description: '逗号分隔；留空 = 公网皆可（仍拦截私网）',
    },
    {
      key: 'denyHosts',
      label: '拒绝的 host（可选）',
      type: 'text',
      description: '逗号分隔，优先于允许列表',
    },
  ],
}

export interface Config {
  engine?: 'ddg' | 'bing'
  maxResults?: number
  maxPages?: number
  maxCharsPerPage?: number
  maxTotalChars?: number
  timeoutMs?: number
  allowHosts?: string | string[]
  denyHosts?: string | string[]
}

function hostList(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  if (Array.isArray(value)) return value.map((s) => s.trim()).filter(Boolean)
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function overridesFromArgs(args: Record<string, unknown>): PolicyOverrides {
  const o: PolicyOverrides = {}
  if (args.maxResults !== undefined) o.maxResults = Number(args.maxResults)
  if (args.maxPages !== undefined) o.maxPages = Number(args.maxPages)
  if (args.maxCharsPerPage !== undefined) o.maxCharsPerPage = Number(args.maxCharsPerPage)
  if (args.maxTotalChars !== undefined) o.maxTotalChars = Number(args.maxTotalChars)
  if (args.timeoutMs !== undefined) o.timeoutMs = Number(args.timeoutMs)
  if (args.allowHosts !== undefined) o.allowHosts = hostList(args.allowHosts as string | string[])
  if (args.denyHosts !== undefined) o.denyHosts = hostList(args.denyHosts as string | string[])
  if (args.engine === 'ddg' || args.engine === 'bing') o.engine = args.engine
  return o
}

function errorContent(error: unknown): { content: string; isError: true } {
  if (error instanceof WebError) {
    return { content: `${error.code}: ${error.message}`, isError: true }
  }
  return { content: (error as Error)?.message ?? String(error), isError: true }
}

export function apply(ctx: Context, config: Config = {}) {
  const base = resolvePolicy(DEFAULT_POLICY, {
    ...config,
    allowHosts: hostList(config.allowHosts),
    denyHosts: hostList(config.denyHosts),
  })

  ctx.systemPrompt.section({
    name: 'tool:web',
    order: 110,
    text: '联网时用 web_search 找线索、web_read 读正文、web_explore 做一次有预算的小探索。不要用 sh 去 curl/爬站。读页结果可能被截断；需要更多时提高 maxCharsPerPage 或分页读。',
  })

  ctx.tools.register(
    'web_search',
    async (args) => {
      try {
        const a = (args ?? {}) as Record<string, unknown>
        const query = String(a.query ?? '').trim()
        const policy = resolvePolicy(base, overridesFromArgs(a))
        const output = await webSearch(query, policy)
        return { content: formatSearchHits(output) }
      } catch (error) {
        return errorContent(error)
      }
    },
    {
      description:
        'Search the web (no API key; DuckDuckGo/Bing HTML). Returns title + URL + snippet list. Use web_read on a hit for full text.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (keywords or a question).' },
          maxResults: { type: 'number', description: 'Max hits (policy-capped).' },
          engine: { type: 'string', enum: ['ddg', 'bing'], description: 'Search backend override.' },
          allowHosts: {
            description: 'Optional host allowlist (string or array).',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          denyHosts: {
            description: 'Optional host denylist (string or array).',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
        },
        required: ['query'],
      },
    },
  )

  ctx.tools.register(
    'web_read',
    async (args) => {
      try {
        const a = (args ?? {}) as Record<string, unknown>
        const url = String(a.url ?? '').trim()
        const policy = resolvePolicy(base, overridesFromArgs(a))
        const outlineOnly = a.outlineOnly === true
        const result = await readPage(url, policy, { outlineOnly })
        if (outlineOnly) {
          return {
            content: `# ${result.title}\nURL: ${url}\n\n${result.outline}\n\n(full length ${result.fullLength}; call web_read without outlineOnly for body)`,
          }
        }
        const foot = result.truncated
          ? `\n\n[truncated: ${result.fullLength} chars total, showed ${policy.maxCharsPerPage}]`
          : ''
        return { content: `# ${result.title}\nURL: ${url}\n\n${result.markdown}${foot}` }
      } catch (error) {
        return errorContent(error)
      }
    },
    {
      description:
        'Fetch one http(s) page and return clean main-content markdown (bladebro-style extraction, budget-capped). outlineOnly=true returns headings only.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL.' },
          outlineOnly: { type: 'boolean', description: 'If true, return title + heading outline only.' },
          maxCharsPerPage: { type: 'number', description: 'Body character budget override.' },
          allowHosts: {
            description: 'Optional host allowlist.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          denyHosts: {
            description: 'Optional host denylist.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
        },
        required: ['url'],
      },
    },
  )

  ctx.tools.register(
    'web_explore',
    async (args) => {
      try {
        const a = (args ?? {}) as Record<string, unknown>
        const term = String(a.term ?? a.query ?? '').trim()
        const hint = typeof a.hint === 'string' ? a.hint : undefined
        const policy = resolvePolicy(base, overridesFromArgs(a))
        const result = await exploreTerm(term, policy, {
          ...overridesFromArgs(a),
          ...(typeof a.query === 'string' ? { query: a.query } : {}),
          ...(hint !== undefined ? { hint } : {}),
        })
        return { content: result.summary }
      } catch (error) {
        return errorContent(error)
      }
    },
    {
      description:
        'One budgeted exploration: search the term, read up to maxPages result pages, return an external-perspective card. Use for companion web_explore / curiosity lookups — not for interactive browsing.',
      parameters: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'Concept / word to explore (from memory or user).' },
          query: { type: 'string', description: 'Optional search query override (default = term).' },
          hint: { type: 'string', description: 'Optional focus hint for what to look for.' },
          maxPages: { type: 'number', description: 'How many result pages to read (default 3).' },
          maxCharsPerPage: { type: 'number', description: 'Per-page body budget.' },
          maxTotalChars: { type: 'number', description: 'Total body budget for this explore.' },
          allowHosts: {
            description: 'Optional host allowlist.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          denyHosts: {
            description: 'Optional host denylist.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
        },
        required: ['term'],
      },
    },
  )

  console.log(
    `[web-tools] 联网探索就绪（engine=${base.engine}, maxPages=${base.maxPages}, maxCharsPerPage=${base.maxCharsPerPage}）`,
  )
}
