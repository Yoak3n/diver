// Diver memory E2E：喂事实 → 等提取 → 问 recall 型问题 → 检查存储文件
const BASE = 'http://127.0.0.1:3620'

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

console.log('=== 1. 喂事实 ===')
let r = await chat('你好，我叫小明，是一名 Rust 工程师，喜欢晚上写代码。')
console.log(`[turn1] ${r.slice(0, 80)}`)
await sleep(4000) // 等提取

r = await chat('对了，我不吃香菜，以后点菜记得帮我避开。')
console.log(`[turn2] ${r.slice(0, 80)}`)
await sleep(4000)

r = await chat('我最近开始学吉他了，每天练 20 分钟。')
console.log(`[turn3] ${r.slice(0, 80)}`)
await sleep(5000)

console.log('\n=== 2. 问 recall 型问题 ===')
r = await chat('你还记得我叫什么名字、做什么工作吗？')
console.log(`[名字/工作] ${r.slice(0, 200)}`)

r = await chat('我们聊过吉他吗？')
console.log(`[吉他] ${r.slice(0, 200)}`)

r = await chat('我的饮食有什么忌口？')
console.log(`[忌口] ${r.slice(0, 200)}`)

console.log('\n=== 3. 存储文件 ===')
process.exit(0)
