// 读取会话 JSONL，统计事件类型
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function findJsonl(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findJsonl(p)
      if (found) return found
    } else if (entry.name.endsWith('.jsonl')) {
      return p
    }
  }
  return null
}

const root = fileURLToPath(new URL('../harness/.dsh-home/sessions', import.meta.url))
const file = findJsonl(root)
console.log('log file:', file)
if (!file) process.exit(1)
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
console.log('total events:', lines.length)
for (const line of lines) {
  const e = JSON.parse(line)
  let text = ''
  const data = e.data?.message ?? e.data
  if (data?.content) {
    text = (data.content.filter((b) => b.type === 'text').map((b) => b.text).join('')).slice(0, 60)
  }
  const src = e.data?.source?.kind ?? ''
  if (/user\/message|assistant\/message|turn\/|tool\//.test(e.type)) {
    console.log(`${e.type} | src=${src} | ${text}`)
  }
}
