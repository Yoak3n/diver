// Diver E2E 冒烟测试：连接 SSE 流 → 发消息 → 打印事件序列（60s 超时）。
const BASE = 'http://127.0.0.1:3620'

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  console.log(`[http] POST ${path} -> ${res.status}: ${text.slice(0, 200)}`)
  return { status: res.status, text }
}

function main() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)

  fetch(`${BASE}/api/stream`, { signal: controller.signal }).then(async (res) => {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let count = 0
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
            count++
            const brief =
              ev.type === 'chunk' ? `chunk(${ev.messageId}, "${ev.delta.slice(0, 40)}")`
              : ev.type === 'message' ? `message(${ev.kind}, ${ev.origin}, ${ev.content.slice(0, 60)})`
              : ev.type === 'hello' ? `hello(model=${ev.model}, configured=${ev.modelConfigured}, busy=${ev.busy})`
              : JSON.stringify(ev)
            console.log(`[sse#${count}] ${brief}`)
          } catch { /* ignore */ }
        }
      }
    }
    console.log(`[sse] stream closed, total events: ${count}`)
    process.exit(0)
  })

  // 等 SSE 连上后发消息
  setTimeout(async () => {
    await post('/api/chat', { content: '你好！简单介绍一下你自己吧。' })
  }, 1500)
}

main()
