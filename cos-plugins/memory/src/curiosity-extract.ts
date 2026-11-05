// @diver/memory — 好奇心取词（纯函数，无 IO）。
//
// 目标是把「生活里反复出现的词」变成候选，而不是做通用分词：
// - 引号/书名号/反引号里的内容：用户明确点名，最高优先级
// - Latin 专名（含大写/数字/.-_）：DeepSeek、MXene、v0.2.13
// - 中文 2–4 字 n-gram：必须重复出现 ≥2 次，且不能以虚词起止
// - 笔记：标题/列表项/「待查」行直接取，不要求重复
//
// 噪声控制交给上层：每轮入队上限、30 天过期、UI 可见、总开关可关。

export type CuriosityReason =
  | 'chat_mention'
  | 'note_pending'
  | 'note'
  | 'entity'
  | 'release'
  | 'watch'
  | 'topic'
  | 'manual'
  | 'platform_trend'

export interface ExtractedTerm {
  /** 展示词（保留原文大小写）。 */
  term: string
  reason: CuriosityReason
  /** 来源基础权重：引号 2.2 / 笔记待查 2.6 / Latin 1.4–1.8 / 中文重复 1.2。 */
  priority: number
  /** 扫描窗口内出现次数（笔记为 1）。 */
  count: number
}

export interface ChatLine {
  text: string
  userId?: string
}

/** 中文虚词/寒暄：整词命中直接丢。 */
const CJK_STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '它们', '这个', '那个', '哪个', '什么', '怎么', '为什么',
  '可以', '就是', '还是', '但是', '因为', '所以', '如果', '然后', '现在', '今天', '明天',
  '昨天', '时候', '感觉', '觉得', '知道', '没有', '不是', '有点', '一点', '真的', '可能',
  '应该', '已经', '自己', '大家', '东西', '事情', '问题', '地方', '方法', '这样', '那样',
  '这里', '那里', '一下', '一直', '一起', '出来', '起来', '下来', '上来', '过去', '回来',
  '看到', '听到', '说到', '想到', '做到', '哈哈', '呵呵', '嘿嘿', '嗯嗯', '好的', '收到',
  '谢谢', '没事', '行吧', '好吧', '对的', '是啊', '对啊', '不过', '而且', '或者', '还有',
  '比较', '非常', '特别', '其实', '反正', '居然', '竟然', '突然', '马上', '刚刚', '刚才',
  '不知道', '有没有', '是不是', '能不能', '会不会', '要不要', '怎么样', '什么样',
  '项目', '功能', '内容', '部分', '情况', '工作', '时间', '现在', '开始', '结束',
])

/** 虚词边界：n-gram 以这些字开头/结尾基本不是实体。 */
const CJK_BAD_EDGE = new Set('的了是在和就都也还很吗呢吧啊这那有我没你他她它们个一不把被让给对从向于与或而且所以因为如果然后们哈呵嘿嗯啊呀哦真今昨明说讲聊讨问答')

/** 英文通用词：全小写且命中则丢（除非在引号里）。 */
const LATIN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'your', 'you',
  'are', 'was', 'were', 'has', 'had', 'not', 'but', 'can', 'all', 'any', 'how', 'why',
  'what', 'when', 'where', 'who', 'use', 'using', 'used', 'new', 'now', 'get', 'got',
  'make', 'made', 'just', 'like', 'one', 'two', 'also', 'more', 'most', 'some', 'such',
  'than', 'then', 'them', 'they', 'there', 'here', 'into', 'over', 'under', 'out',
  'off', 'on', 'in', 'at', 'to', 'of', 'is', 'it', 'as', 'be', 'or', 'by', 'do',
  'does', 'did', 'so', 'if', 'my', 'me', 'we', 'our', 'us', 'he', 'she', 'his', 'her',
  'its', 'up', 'down', 'about', 'after', 'before', 'again', 'very', 'much', 'many',
  'well', 'good', 'great', 'best', 'top', 'vs', 'etc', 'http', 'https', 'www', 'com',
  'org', 'html', 'php', 'true', 'false', 'null', 'none', 'yes', 'no', 'ok', 'okay',
])

const PLACEHOLDER = /\[(图|图片|表情|语音|视频|文件|动画表情|链接|卡片|回复)\]/g
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi
const MENTION_RE = /@[^\s]+/g
const COMMAND_RE = /^\s*[/!！][^\s]*\s*/g

/** 归一化去重键：小写、压空白、去尾部标点。 */
export function normalizeTerm(term: string): string {
  return term
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[.,;:!?。，；：！？、~～…]+$/g, '')
    .trim()
}

/** 清洗一行聊天文本：去掉占位符/URL/@/命令。 */
export function cleanChatText(text: string): string {
  return text
    .replace(PLACEHOLDER, ' ')
    .replace(URL_RE, ' ')
    .replace(MENTION_RE, ' ')
    .replace(COMMAND_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface TermSink {
  add(term: string, reason: CuriosityReason, priority: number, count?: number): void
}

function makeSink(): TermSink & { values(): ExtractedTerm[] } {
  const map = new Map<string, ExtractedTerm>()
  return {
    add(term, reason, priority, count = 1) {
      const trimmed = term.trim().replace(/^[「」“”《》`'"]+|[「」“”《》`'"]+$/g, '').trim()
      if (trimmed.length < 2 || trimmed.length > 40) return
      const key = normalizeTerm(trimmed)
      if (key.length < 2) return
      const prev = map.get(key)
      if (prev === undefined) {
        map.set(key, { term: trimmed, reason, priority, count })
        return
      }
      // 同一词保留更高优先级；展示形式优先保留大小写更丰富的一次。
      prev.count = Math.max(prev.count, count)
      if (priority > prev.priority) {
        prev.priority = priority
        prev.reason = reason
        prev.term = trimmed
      } else if (priority === prev.priority && trimmed.length > prev.term.length) {
        prev.term = trimmed
      }
    },
    values() {
      return [...map.values()].sort((a, b) => b.priority - a.priority || b.count - a.count || a.term.length - b.term.length)
    },
  }
}

/** 引号/书名号/反引号内容：用户明确点名的词。 */
function collectQuoted(text: string, sink: TermSink): void {
  const patterns = [/「([^」\n]{2,40})」/g, /“([^”\n]{2,40})”/g, /《([^》\n]{2,40})》/g, /`([^`\n]{2,40})`/g]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]
      if (value !== undefined && !/^(?:https?:\/\/|www\.)/i.test(value)) {
        sink.add(value, 'chat_mention', 2.2)
      }
    }
  }
}

/** Latin 专名：大写/数字/连接符优先；全小写要求重复出现。 */
function collectLatin(text: string, sink: TermSink): void {
  const tokens = new Map<string, { display: string; count: number }>()
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9._+#-]{1,30}/g)) {
    const raw = match[0].replace(/[._+#-]+$/, '')
    if (raw.length < 2) continue
    const key = raw.toLowerCase()
    if (LATIN_STOPWORDS.has(key)) continue
    const prev = tokens.get(key)
    if (prev === undefined) tokens.set(key, { display: raw, count: 1 })
    else {
      prev.count += 1
      if (raw.length > prev.display.length) prev.display = raw
    }
  }
  for (const { display, count } of tokens.values()) {
    const strong = /[A-Z]/.test(display) || /\d/.test(display) || /[._+#-]/.test(display)
    if (!strong && count < 2) continue
    sink.add(display, 'chat_mention', strong ? 1.8 : 1.4, count)
  }
}

/** 中文 n-gram：重复 ≥2 次；优先保长词，去掉被长词覆盖的短词。 */
function collectCjk(text: string, sink: TermSink): void {
  const counts = new Map<string, number>()
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = match[0].slice(0, 40)
    for (let size = 2; size <= Math.min(6, run.length); size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) {
        const gram = run.slice(start, start + size)
        if (CJK_STOPWORDS.has(gram)) continue
        if (/^(.)\1+$/.test(gram)) continue // 哈哈哈 / 嗯嗯嗯
        if (CJK_BAD_EDGE.has(gram[0]!) || CJK_BAD_EDGE.has(gram[gram.length - 1]!)) continue
        counts.set(gram, (counts.get(gram) ?? 0) + 1)
      }
    }
  }
  const repeated = [...counts.entries()].filter(([, n]) => n >= 2)
  repeated.sort((a, b) => b[0].length - a[0].length || b[1] - a[1])
  const kept: Array<[string, number]> = []
  for (const [gram, count] of repeated) {
    // 长词已经覆盖、且出现次数不低 → 短词是碎片，丢掉。
    if (kept.some(([long, longCount]) => long.includes(gram) && longCount >= count)) continue
    kept.push([gram, count])
  }
  for (const [gram, count] of kept.slice(0, 8)) sink.add(gram, 'chat_mention', 1.2, count)
}

/**
 * 群聊取词：对扫描窗口内的所有行做一次性聚合。
 * @param lines 已按时间升序的消息；`cleanChatText` 在内部调用。
 */
export function extractChatTerms(lines: readonly ChatLine[]): ExtractedTerm[] {
  const sink = makeSink()
  const cleaned = lines.map((line) => cleanChatText(line.text)).filter((text) => text !== '')
  for (const text of cleaned) collectQuoted(text, sink)
  // Latin / n-gram 需要跨行统计：把窗口合并成一段（换行保留，避免跨行造词）。
  const joined = cleaned.join('\n')
  collectLatin(joined, sink)
  collectCjk(joined, sink)
  return sink.values()
}

/** 笔记里取词：标题/列表项/待查行直接取，Latin 与引号内容照常。 */
export function extractNoteTerms(text: string): ExtractedTerm[] {
  const sink = makeSink()
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const pending = /(待查|想查|待研究|回头查|查一下|查下|去查|要查|没搞懂|没看懂|没明白|TODO|FIXME|[?？])/i.test(trimmed)
    const priority = pending ? 2.6 : 1.8
    const reason: CuriosityReason = pending ? 'note_pending' : 'note'

    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed)
    if (heading !== null) sink.add(leadPhrase(heading[1]!), 'note', 2.2)
    const bullet = /^[-*+]\s+(.+)$/.exec(trimmed)
    if (bullet !== null) sink.add(leadPhrase(bullet[1]!), reason, priority)
    if (pending) sink.add(leadPhrase(trimmed), 'note_pending', 2.6)

    collectQuoted(trimmed, sink)
    collectLatin(trimmed, sink)
  }
  return sink.values()
}

/** 取一行里第一个短句作为词（标题/列表项/待查行用）。 */
function leadPhrase(line: string): string {
  const cleaned = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^(待查|想查|待研究|回头查|没搞懂|没看懂|没明白|TODO|FIXME)[：:\s-]+/i, '')
    .trim()
  const first = cleaned.split(/[：:，,。；;（(、]/)[0] ?? cleaned
  return first.trim().slice(0, 40)
}
