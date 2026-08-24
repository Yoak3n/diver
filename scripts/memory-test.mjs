// Diver memory E2E：喂事实 → 问 recall 型问题 → 调 /rpc 验证 SQLite 落库
const BASE = process.env.DIVER_PORT
  ? `http://127.0.0.1:${process.env.DIVER_PORT}`
  : 'http://127.0.0.1:3620'

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, text: await res.text() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 发送消息并等待 turn 结束（读 SSE 直到 turn/end）。 */
async function chat(content, waitMs = 30000) {
  await post('/api/chat', { content })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), waitMs)
  try {
    const res = await fetch(`${BASE}/api/stream`, { signal: controller.signal })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let final = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          try {
            const ev = JSON.parse(data)
            if (ev.type === 'message' && ev.kind === 'assistant') final = ev.content
            if (ev.type === 'tool') console.log(`   [tool] ${ev.status} ${ev.name}`)
            if (ev.type === 'turn' && ev.state === 'end') {
              clearTimeout(timer)
              return final
            }
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* timeout */ }
  clearTimeout(timer)
  return final
}

console.log('=== 1. 喂事实（通过 remember 工具写入 SQLite） ===')
let r = await chat('请用 remember 工具记住：我叫小明，是一名 Rust 工程师，喜欢晚上写代码。')
console.log(`[turn1] ${r.slice(0, 80)}`)
await sleep(4000) // 等待 agent 处理

r = await chat('请用 remember 工具记住：我不吃香菜，以后点菜记得帮我避开。')
console.log(`[turn2] ${r.slice(0, 80)}`)
await sleep(4000)

r = await chat('请用 remember 工具记住：我最近开始学吉他了，每天练 20 分钟。')
console.log(`[turn3] ${r.slice(0, 80)}`)
await sleep(5000)

console.log('\n=== 2. 问 recall 型问题 ===')
r = await chat('你还记得我叫什么名字、做什么工作吗？')
console.log(`[名字/工作] ${r.slice(0, 200)}`)

r = await chat('我们聊过吉他吗？')
console.log(`[吉他] ${r.slice(0, 200)}`)

r = await chat('我的饮食有什么忌口？')
console.log(`[忌口] ${r.slice(0, 200)}`)

console.log('\n=== 3. 验证 SQLite 落库（/rpc） ===')
const health = await (await fetch(`${BASE}/api/health`)).json()
const memoryPort = Number(process.env.DIVER_MEMORY_PORT) || Number(health.memoryPort) || 0
if (!memoryPort) {
  console.log('未发现 Rust memory RPC 端口（DIVER_MEMORY_PORT / /api/health.memoryPort），跳过 /rpc 验证')
  process.exit(0)
}

async function rpc(method, params = {}) {
  const res = await fetch(`http://127.0.0.1:${memoryPort}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(body.error ?? `rpc ${method} failed`)
  return body.data
}

// 写一条测试话题，确认 Rust SQLite 后端真实落库，然后清理。
const topicId = await rpc('create_topic', {
  canonicalName: '__memory_test__',
  stateSummary: 'memory-test RPC 冒烟验证',
  tier: 'episodic',
  uncertain: false,
})
const snap = await rpc('snapshot')
const created = snap.topics.some((t) => t.id === topicId)
console.log(`[rpc] create_topic=${topicId} snapshot.topics=${snap.topics.length} events=${snap.events.length}`)
if (!created) {
  console.error('[memory-test] FAIL: 创建的话题未出现在 snapshot 中')
  process.exit(1)
}
await rpc('delete_topic', { id: topicId })
const after = await rpc('snapshot')
console.log(`[rpc] delete_topic 后 snapshot.topics=${after.topics.length}`)
console.log('[memory-test] OK: /rpc 读写正常，SQLite 落库验证通过')
process.exit(0)
