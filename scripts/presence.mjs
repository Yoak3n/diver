// 观察 presence 主动问候：连接 SSE 流 30 秒，打印 presence 相关事件
const BASE = 'http://127.0.0.1:3620'
const controller = new AbortController()
setTimeout(() => controller.abort(), 30000)

const res = await fetch(`${BASE}/api/stream`, { signal: controller.signal })
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
        if (ev.type === 'message' && (ev.origin === 'presence' || ev.kind === 'system')) {
          console.log(`[presence] ${ev.kind}/${ev.origin}: ${ev.content.slice(0, 80)}`)
        } else if (ev.type === 'chunk') {
          // 流式回复节选
          process.stdout.write('·')
        } else if (ev.type === 'turn' && ev.state === 'end') {
          console.log(`\n[turn-end] ${ev.reason}`)
        } else if (ev.type === 'busy') {
          console.log(`[busy] ${ev.value}`)
        }
      } catch { /* ignore */ }
    }
  }
}
console.log(`\n[done] total events observed: ${count}`)
process.exit(0)
