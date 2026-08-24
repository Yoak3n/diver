// opencode-go provider E2E：切换 provider → 对话 → 工具调用验证
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

/** 发送消息并等待 turn 结束，返回最终文本 + 工具调用记录。 */
async function chat(content, waitMs = 60000) {
  await post('/api/chat', { content })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), waitMs)
  const tools = []
  let final = ''
  try {
    const res = await fetch(`${BASE}/api/stream`, { signal: controller.signal })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
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
            if (ev.type === 'tool') tools.push(`${ev.status}:${ev.name}`)
            if (ev.type === 'turn' && ev.state === 'end') {
              clearTimeout(timer)
              return { final, tools }
            }
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* timeout */ }
  clearTimeout(timer)
  return { final, tools }
}

// 1) 切到 opencode-go / glm-5.3
let r = await post('/api/settings', { provider: 'opencode-go', model: 'glm-5.3' })
console.log(`[switch] ${r.status} ${r.text}`)
await new Promise((res) => setTimeout(res, 800))

// 2) 对话（应走 opencode-go chat/completions）
r = await chat('你好！简单介绍一下你自己，然后告诉我现在的心情。')
console.log(`[glm-5.3 对话] tools=${JSON.stringify(r.tools)}`)
console.log(`[回复] ${r.final.slice(0, 200)}`)

// 3) 工具调用验证（记忆 remember）
r = await chat('帮我记住：我下周三有个重要面试。')
console.log(`[remember 工具] tools=${JSON.stringify(r.tools)}`)
console.log(`[回复] ${r.final.slice(0, 200)}`)

// 4) 切回 deepseek 确认无影响
r = await post('/api/settings', { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
console.log(`[switch back] ${r.status} ${r.text}`)
await new Promise((res) => setTimeout(res, 800))
r = await chat('现在用你原来的模型回我一个字：好')
console.log(`[deepseek 回切] tools=${JSON.stringify(r.tools)} 回复=${r.final.slice(0, 100)}`)
process.exit(0)
