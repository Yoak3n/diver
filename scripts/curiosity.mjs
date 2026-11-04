// 好奇心清单只读 dump：计数 + 待探索/已完成明细 + state.json 位点。
// 用法：node scripts/curiosity.mjs [--open] [--limit=20]
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { authHeaders } from './service-auth.mjs'

const args = process.argv.slice(2)
const onlyOpen = args.includes('--open')
const limitArg = args.find((a) => a.startsWith('--limit='))
const limit = Number(limitArg?.split('=')[1]) || 20

const BASE = process.env.DIVER_PORT
  ? `http://127.0.0.1:${process.env.DIVER_PORT}`
  : 'http://127.0.0.1:53620'

async function rpc(method, params = {}) {
  const res = await fetch(`http://127.0.0.1:${memoryPort}/rpc`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ method, params }),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(body.error ?? `rpc ${method} failed`)
  return body.data
}

const health = await (await fetch(`${BASE}/api/health`)).json()
const memoryPort = Number(process.env.DIVER_MEMORY_PORT) || Number(health.memoryPort) || 0
if (!memoryPort) {
  console.error('未发现 Rust memory RPC 端口（DIVER_MEMORY_PORT / /api/health.memoryPort）')
  process.exit(1)
}

const counts = await rpc('curiosity_counts')
console.log(
  `[curiosity] open=${counts.open} claimed=${counts.claimed} done=${counts.done}` +
    ` skipped=${counts.skipped} expired=${counts.expired}`,
)

const statuses = onlyOpen ? ['open'] : ['open', 'done']
for (const status of statuses) {
  const rows = await rpc('curiosity_list', { status, limit })
  console.log(`\n== ${status} (${rows.length}) ==`)
  for (const row of rows) {
    const score = status === 'open' ? ` score=${row.score.toFixed(2)}` : ''
    const note = row.note ? ` — ${row.note.slice(0, 60)}` : ''
    console.log(`- [${row.reason}] ${row.term}  (${row.source}, x${row.occurrences})${score}${note}`)
  }
}

const cosHome =
  process.env.COS_HOME || join(process.env.APPDATA ?? homedir(), 'com.diver.companion', 'cos')
const statePath = join(cosHome, 'curiosity', 'state.json')
if (existsSync(statePath)) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    console.log(`\n== state.json ==`)
    console.log(JSON.stringify({
      lastScanAt: state.lastScanAt,
      report: state.report ?? null,
      repos: state.repos ?? [],
      repoScanAt: state.repoScanAt ?? 0,
      subscriptions: state.subscriptions ?? {},
    }, null, 2))
  } catch (err) {
    console.warn(`state.json 读取失败: ${err}`)
  }
}
