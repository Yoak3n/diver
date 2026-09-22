// idle-gate 冒烟（不依赖 @cos/plugin-api，可用 --experimental-strip-types 直接跑）
// 运行: node --experimental-strip-types scripts/smoke-idle-gate.ts

import { createIdleGate } from '../src/idle-gate.ts'

let failed = 0
function check(name: string, cond: boolean) {
  if (cond) console.log(`ok  ${name}`)
  else {
    console.error(`FAIL ${name}`)
    failed++
  }
}

const cfg = { quietMs: 1000, cooldownMs: 5000, maxTriggers: 1 }
let busy = false
const gate = createIdleGate(() => busy, () => cfg)

// 刚启动：未对话也需 quiet
check('startup blocks', !gate.tryClaim(0).ok)

// 静默后可触发
check('idle allows', gate.tryClaim(2000).ok === true)
// 冷却中
const c = gate.tryClaim(2500)
check('cooldown blocks', !c.ok && c.reason === 'cooldown')
// busy
busy = true
const b = gate.tryClaim(10_000)
check('busy blocks', !b.ok && b.reason === 'busy')
busy = false

// 主动后 noteChat 不重置 window；max_triggers 生效
gate.noteChat(10_000)
const m = gate.tryClaim(20_000)
check('max_triggers blocks', !m.ok && m.reason === 'max_triggers')

// 真人发言重置窗口
gate.noteUserChat(30_000)
check('after user chat blocked by quiet', !gate.tryClaim(30_500).ok)
check('after user chat allows', gate.tryClaim(31_100).ok === true)

if (failed > 0) process.exit(1)
console.log('all good')
