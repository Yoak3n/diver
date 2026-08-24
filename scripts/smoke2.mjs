// Diver E2E 第二轮：工具调用闭环 + 历史验证
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

async function run() {
  // 1) 发一条会触发工具调用的消息
  const r = await post('/api/chat', { content: '帮我搜索一下：最近有什么值得关注的 AI 新闻？' })
  console.log(`[chat] ${r.status} ${r.text.slice(0, 120)}`)

  // 2) 监听事件直到 turn/end
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90000)
  const res = await fetch(`${BASE}/api/stream`, { signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let sawTool = false
  let sawAssistant = false
  let chunks = 0
  let finalText = ''
  const print = (ev) => {
    if (ev.type === 'tool') { sawTool = true; console.log(`[tool] ${ev.status} ${ev.name}`) }
    if (ev.type === 'chunk') { chunks++ }
    if (ev.type === 'message' && ev.kind === 'assistant') { sawAssistant = true; finalText = ev.content }
    if (ev.type === 'turn' && ev.state === 'end') { console.log(`[turn-end] reason=${ev.reason}`) }
  }
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
        try { print(JSON.parse(data)) } catch { /* ignore */ }
      }
    }
    if (sawAssistant) break // 收到最终消息即可
  }
  clearTimeout(timer)
  console.log(`[summary] tool=${sawTool} assistant=${sawAssistant} chunks=${chunks}`)
  console.log(`[final] ${finalText.slice(0, 300)}`)

  // 3) 历史接口
  const h = await fetch(`${BASE}/api/history`)
  const hist = await h.json()
  console.log(`[history] ${hist.messages.length} 条消息，最后一条: ${hist.messages.at(-1)?.content.slice(0, 60)}`)
  process.exit(0)
}

run()
