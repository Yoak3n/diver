// @diver/memory — B 站发现面：排行榜/热门/匿名搜索（只读）。
//
// 搜索结果只带匿名 buvid3，不带 SESSDATA；排行榜也不带登录态，
// 避免把“大家在看什么”变成个人推荐流。

import { BilibiliError } from './curiosity-bilibili-error.ts'
import { parsePopular, parseRanking, parseSearch, type BiliCandidate } from './curiosity-bilibili-parse.ts'
import { signWbiQuery } from './curiosity-bilibili-wbi.ts'

export interface BilibiliDiscoverResult {
  candidates: BiliCandidate[]
  /** 搜索/排行命中风控：本次仍可用兜底数据，但下次会话应退避。 */
  risk: boolean
}

export interface BilibiliDiscoverDeps {
  getJson: <T>(
    url: string,
    headers?: Record<string, string>,
    useAuth?: boolean,
  ) => Promise<T>
  wbiMixin: () => Promise<string>
  buvidCookie: () => Promise<string>
  now: () => number
  log: (message: string) => void
  searchEnabled: boolean
}

const RANKING_URL = 'https://api.bilibili.com/x/web-interface/ranking/v2'
const POPULAR_URL = 'https://api.bilibili.com/x/web-interface/popular'
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type'

export async function discoverBilibili(
  deps: BilibiliDiscoverDeps,
  queries: readonly string[],
  rids: readonly number[] = [0],
): Promise<BilibiliDiscoverResult> {
  const candidates: BiliCandidate[] = []
  let risk = false
  const wanted = rids.length > 0 ? rids.slice(0, 2) : [0]
  let rankingOk = false
  for (const rid of wanted) {
    try {
      candidates.push(...parseRanking(await deps.getJson<unknown>(`${RANKING_URL}?rid=${rid}&type=all`)))
      rankingOk = true
    } catch (err) {
      if (err instanceof BilibiliError && err.risk) risk = true
      deps.log(`排行榜 rid=${rid} 失败: ${(err as Error)?.message ?? err}`)
    }
  }
  if (!rankingOk) {
    try {
      candidates.push(...parsePopular(await deps.getJson<unknown>(`${POPULAR_URL}?pn=1&ps=20`)))
    } catch (err) {
      if (err instanceof BilibiliError && err.risk) risk = true
      deps.log(`热门失败: ${(err as Error)?.message ?? err}`)
    }
  }

  if (deps.searchEnabled) {
    for (const raw of [...queries].slice(0, 2)) {
      const query = raw.trim()
      if (query === '') continue
      try {
        candidates.push(...(await search(deps, query)))
      } catch (err) {
        if (err instanceof BilibiliError && err.risk) {
          risk = true
          deps.log(`搜索风控，回退排行榜: ${err.message}`)
          break
        }
        deps.log(`搜索「${query}」失败: ${(err as Error)?.message ?? err}`)
      }
    }
  }
  return { candidates: dedupe(candidates), risk }
}

async function search(deps: BilibiliDiscoverDeps, query: string): Promise<BiliCandidate[]> {
  const cookies = await deps.buvidCookie()
  const mixin = await deps.wbiMixin()
  const signed = signWbiQuery(
    { search_type: 'video', keyword: query, page: 1, order: 'totalrank' },
    mixin,
    Math.floor(deps.now() / 1000),
  )
  return parseSearch(
    await deps.getJson<unknown>(`${SEARCH_URL}?${signed}`, { cookie: cookies }),
  )
}

function dedupe(items: readonly BiliCandidate[]): BiliCandidate[] {
  const seen = new Set<string>()
  const out: BiliCandidate[] = []
  for (const item of items) {
    if (item.bvid === '' || seen.has(item.bvid)) continue
    seen.add(item.bvid)
    out.push(item)
  }
  return out
}
