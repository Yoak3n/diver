// Explore job manager 冒烟：busy / cancel / pickTerms 过滤（不依赖外网）。
//
// 构建（harness 目录）：
//   node_modules/.bin/esbuild.cmd ../cos-plugins/memory/scripts/smoke-explore.ts --bundle --platform=node --format=esm --tsconfig=../cos-plugins/memory/tsconfig.json --outfile=memory-explore-smoke.bundle.mjs
//   node memory-explore-smoke.bundle.mjs

import { ExploreJobManager, pickTerms, type ExploreCandidate } from '../src/explore.ts'
import type { MemoryStore, TopicRow } from '../src/store-rpc.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ok  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name} ${detail}`)
  }
}

function fakeStore(topics: TopicRow[]): MemoryStore {
  return {
    listTopics: async () => topics,
  } as unknown as MemoryStore
}

const now = Date.now()
const topics: TopicRow[] = [
  {
    id: 't1',
    canonicalName: 'MXene',
    aliases: [],
    stateSummary: '二维材料',
    weight: 1,
    tier: 'trivia',
    activationCount: 3,
    createdAt: now,
    lastDiscussedAt: now - 3600_000,
    nTimes: 5,
    uncertain: false,
  },
  {
    id: 't2',
    canonicalName: '会话',
    aliases: [],
    stateSummary: '寒暄',
    weight: 1,
    tier: 'episodic',
    activationCount: 9,
    createdAt: now,
    lastDiscussedAt: now,
    nTimes: 20,
    uncertain: false,
  },
  {
    id: 't3',
    canonicalName: 'MXene合成路径',
    aliases: [],
    stateSummary: '不确定',
    weight: 0.5,
    tier: 'trivia',
    activationCount: 1,
    createdAt: now,
    lastDiscussedAt: now - 2 * 24 * 3600_000,
    nTimes: 2,
    uncertain: true,
  },
  {
    id: 't4',
    canonicalName: 'x',
    aliases: [],
    stateSummary: '太短',
    weight: 1,
    tier: 'trivia',
    activationCount: 1,
    createdAt: now,
    lastDiscussedAt: now,
    nTimes: 5,
    uncertain: false,
  },
]

const picked = await pickTerms(fakeStore(topics), 5)
check('pickTerms 排除元话题/过短', !picked.some((c: ExploreCandidate) => c.term === '会话' || c.term === 'x'))
check('pickTerms 保留 MXene', picked.some((c) => c.term === 'MXene'))
check('pickTerms uncertain 优先', picked[0]?.term === 'MXene合成路径' || picked.some((c) => c.reason === 'uncertain'))

const mgr = new ExploreJobManager()
// 用会立刻 resolve 的假 store；exploreTerm 会真联网 —— 这里只测状态机 busy/cancel。
const store = fakeStore(topics)

// cancel 空闲
check('cancel idle false', mgr.cancel() === false)

// 启动后立刻 cancel（abort exploreTerm）
const job = mgr.start(store, { term: 'MXene', reason: 'manual', policy: { maxPages: 1, maxCharsPerPage: 400, maxTotalChars: 400 } })
check('job running', job.state === 'running')
check('activeJobId set', mgr.activeJobId === job.jobId)
check('cancel active true', mgr.cancel(job.jobId) === true)
check('status cancelled', mgr.status(job.jobId)?.state === 'cancelled')

// busy：cancelled 后 running 已清，可再 start
try {
  const j2 = mgr.start(store, { term: 'graphene', policy: { maxPages: 1 } })
  check('restart after cancel', j2.state === 'running')
  mgr.cancel(j2.jobId)
} catch (e) {
  check('restart after cancel', false, String(e))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
