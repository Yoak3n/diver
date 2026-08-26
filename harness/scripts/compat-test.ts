/**
 * 第三方插件兼容性验证脚本（@diver/memory + @diver/backend，经 @diver/bundle-companion 组装）。
 *
 * 覆盖维度：
 *   T1 初始化加载 —— 插件 apply() 正常执行、服务注册无异常
 *   T2 核心功能   —— memory 工具面/常驻注入、backend HTTP 端点
 *   T3 跨模块交互 —— memory↔sessions/llm/tools/systemPrompt、backend↔agentLoop/credentials/sessionPersistence
 *   T4 异常场景   —— Rust 后端未启动、API Key 未配置、未知 provider
 *
 * 运行：pnpm tsx scripts/compat-test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { boot, bootOptionsFromCli, parseCliArgs } from '@cos/boot'
import { createUserMessage } from '@cos/types'
import type { Context } from 'cordis'

const results: Array<{ id: string; name: string; pass: boolean; detail: string }> = []

/** 后端端口（默认 3620，可用 `DIVER_PORT` 覆盖，避免与正在运行的 dev 应用冲突）。 */
const PORT = Number(process.env.DIVER_PORT ?? 3620)

function record(id: string, name: string, pass: boolean, detail: string) {
  results.push({ id, name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${id}] ${name} — ${detail}`)
}

async function main() {
  console.log('=== 第三方插件兼容性验证 ===\n')

  // ── 测试数据隔离（不污染应用的真实数据）────────────────────────────
  // 本套件不再向 'diver-companion' 会话投递消息；COS_HOME 与持久化根都重定向
  // 到一次性临时目录（结束即清理），避免测试会话/设置残留在应用数据里。
  const testHome = mkdtempSync(join(tmpdir(), 'diver-compat-'))
  process.env.COS_HOME = testHome

  // ── T1 初始化加载 ──────────────────────────────────────────────
  console.log('--- T1 初始化加载 ---')
  // 经第三方 bundle 组装 diver 插件（memory + backend），叠加 mock overlay 离线运行
  const cli = parseCliArgs(['--bundles', '@diver/bundle-companion', '--overlays', 'overlays/mock.yml'])
  let ctx: Context
  try {
    ctx = await boot(bootOptionsFromCli(cli, {
      required: ['agentLoop', 'llm', 'tools', 'sessions', 'agents', 'systemPrompt', 'credentials'],
      // 持久化根重定向到临时目录，测试会话不写入应用的 $COS_HOME/sessions
      extraPatches: [{ id: 'persistence', config: { root: join(testHome, 'sessions') } }],
    }))
    record('T1.1', 'boot 成功（含第三方插件挂载）', true, 'cordis.yml + cordis.patch.yml 组合树就绪')
  } catch (err) {
    record('T1.1', 'boot 成功（含第三方插件挂载）', false, String(err))
    console.log('\n=== 结果汇总 ===')
    const failed = results.filter((r) => !r.pass)
    console.log(`通过 ${results.length - failed.length}/${results.length}`)
    process.exit(1)
  }

  // memory 插件 apply() 是否执行（工具注册成功即证明 apply 跑通）
  const toolNames = ctx.tools.listDefinitions().map((t) => t.name)
  const memoryTools = ['remember', 'recall', 'inventory', 'demote', 'identity']
  const missingTools = memoryTools.filter((t) => !toolNames.includes(t))
  record('T1.2', 'memory 插件 apply() 执行（5 个记忆工具注册）', missingTools.length === 0,
    missingTools.length === 0 ? `已注册: ${memoryTools.join(', ')}` : `缺失: ${missingTools.join(', ')}`)

  // basic-tools 插件 apply() 是否执行（四个基础工具：read/write/edit/sh 注册）
  const basicTools = ['read', 'write', 'edit', 'sh']
  const missingBasic = basicTools.filter((t) => !toolNames.includes(t))
  record('T1.4', 'basic-tools 插件 apply() 执行（4 个基础工具注册）', missingBasic.length === 0,
    missingBasic.length === 0 ? `已注册: ${basicTools.join(', ')}` : `缺失: ${missingBasic.join(', ')}`)

  // backend 插件 apply() 是否执行（HTTP server 是否监听）
  const webUp = await new Promise<boolean>((resolve) => {
    const probe = () => {
      fetch(`http://127.0.0.1:${PORT}/api/health`)
        .then((res) => resolve(res.ok))
        .catch(() => resolve(false))
    }
    probe()
    setTimeout(() => resolve(false), 3000)
  })
  record('T1.3', `backend 插件 apply() 执行（HTTP server 监听 ${PORT}）`, webUp, webUp ? 'health 端点可达' : '端口未监听')

  // ── T2 核心功能 ────────────────────────────────────────────────
  console.log('\n--- T2 核心功能 ---')

  // T2.1 memory 常驻注入：systemPrompt section 已注册
  let sectionRegistered = false
  try {
    const assembly = await ctx.systemPrompt.assemble({})
    sectionRegistered = assembly.sections.some((s) => s.name === 'memory:relation-card')
  } catch { /* 忽略 */ }
  record('T2.1', 'memory 常驻注入（systemPrompt section 注册）', sectionRegistered,
    sectionRegistered ? 'memory:relation-card 已注册' : 'section 未找到')

  // T2.2 backend health 端点
  let healthOk = false
  let healthBody = ''
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`)
    healthOk = res.ok
    healthBody = await res.text()
  } catch { /* 忽略 */ }
  record('T2.2', 'backend /api/health 端点', healthOk, healthOk ? healthBody.slice(0, 120) : '请求失败')

  // T2.3 backend settings 端点
  let settingsOk = false
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/settings`)
    settingsOk = res.ok
  } catch { /* 忽略 */ }
  record('T2.3', 'backend /api/settings 端点', settingsOk, settingsOk ? '返回 200' : '请求失败')

  // T2.4 basic-tools 功能：write → read → edit → sh 四工具闭环（临时工作区）
  let basicRoundTrip = false
  let basicDetail = ''
  try {
    const wsRoot = join(testHome, 'workspace')
    mkdirSync(wsRoot, { recursive: true })
    // 用插件配置覆盖 workspace 根到临时目录：重新挂载一个 basic-tools 实例太
    // 重，这里直接以临时目录为 cwd 验证工具本身的行为（相对路径基于 wsRoot 不
    // 成立时，工具会按绝对路径解析——测试传绝对路径即可）。
    const probe = join(wsRoot, 'probe.txt')
    const w = await ctx.tools.execute('write', { file_path: probe, content: 'line1\nline2\nline3' }, new AbortController().signal)
    const r = await ctx.tools.execute('read', { file_path: probe, offset: 2, limit: 2 }, new AbortController().signal)
    const e = await ctx.tools.execute('edit', { file_path: probe, old_string: 'line2', new_string: 'LINE2' }, new AbortController().signal)
    const s = await ctx.tools.execute('sh', { command: 'echo hello', workdir: wsRoot }, new AbortController().signal)
    basicRoundTrip = !w.isError && r.content.includes('2: line2') && r.content.includes('3: line3')
      && !e.isError && s.content.includes('hello') && s.content.includes('[exit code: 0]')
    basicDetail = `write/read/edit/sh 闭环: ${basicRoundTrip ? 'OK' : `w=${w.isError} r=${r.content.slice(0, 60)} e=${e.isError} s=${s.content.slice(0, 60)}`}`
  } catch (err) {
    basicDetail = `异常: ${String(err)}`
  }
  record('T2.4', 'basic-tools 功能（write/read/edit/sh 闭环）', basicRoundTrip, basicDetail)

  // ── T3 跨模块交互 ──────────────────────────────────────────────
  console.log('\n--- T3 跨模块交互 ---')

  // T3.1 backend ↔ agentLoop：创建陪伴 agent（resume 语义）
  let agentCreated = false
  let agentId = ''
  try {
    const { agent } = await ctx.agentLoop.createAgent({
      sessionId: 'diver-companion' as never,
      agentOptions: { provider: 'mock', model: 'mock-1' },
      resume: true,
    })
    agentCreated = true
    agentId = String(agent.id)
  } catch (err) {
    console.error('  agent 创建失败:', err)
  }
  record('T3.1', 'backend ↔ agentLoop（createAgent resume）', agentCreated, agentCreated ? `agent ${agentId} 就绪` : '创建失败')

  // 注意：不再向 'diver-companion' 会话投递"测试消息"——那会经 sessionPersistence
  // 落盘进应用的真实聊天历史，每次启动 dev 都能看到。事件流接线由 T2.1/T3.1 覆盖；
  // 真实验证请走应用本身（DeepSeek / 其它真实 provider），不要用 mock 回显掩盖问题。

  // T3.3 memory ↔ subagents/llm：digest 路径（Rust 后端未启动时应优雅降级，不抛未捕获异常；
  // 消化已委托给 harness 核心 ctx.subagents，worker 通过工具直写记忆）
  let digestGraceful = true
  try {
    const { MemoryStore } = await import('@diver/memory/store-rpc')
    const { digestSession } = await import('@diver/memory/digest')
    const store = new MemoryStore('.')
    await digestSession(ctx, store, { profile: '', agent_model: '', relationship: '' }, { total: 0 }, '测试摘要')
    // Rust 后端未启动 → 记忆工具调用返回 isError、worker 正常收场；不应抛未捕获异常
  } catch (err) {
    digestGraceful = false
    console.error('  digest 路径异常:', err)
  }
  record('T3.3', 'memory ↔ subagents（digestSession 委派 worker）', digestGraceful, digestGraceful ? '调用完成（后端缺失时优雅降级）' : '抛未捕获异常')

  // T3.4 backend ↔ sessionPersistence：history 端点读取持久化事件
  let historyOk = false
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/history`)
    historyOk = res.ok
  } catch { /* 忽略 */ }
  record('T3.4', 'backend ↔ sessionPersistence（/api/history）', historyOk, historyOk ? '返回 200' : '请求失败')

  // ── T4 异常场景 ────────────────────────────────────────────────
  console.log('\n--- T4 异常场景 ---')

  // T4.1 Rust 后端未启动（DIVER_MEMORY_PORT 未配置）：memory 优雅降级
  // 已在 boot 日志中体现（"拉取快照失败: memory: DIVER_MEMORY_PORT 未配置"），
  // 且插件仍正常加载（T1.2 通过）。这里验证 store 调用不抛未捕获异常。
  let storeGraceful = true
  try {
    const { MemoryStore } = await import('@diver/memory/store-rpc')
    const store = new MemoryStore('.')
    await store.refresh()
    const card = store.getCard()
    void card
  } catch (err) {
    storeGraceful = false
    console.error('  store 调用异常:', err)
  }
  record('T4.1', 'Rust 后端未启动 → memory 优雅降级', storeGraceful, storeGraceful ? 'store 调用不抛未捕获异常' : '抛异常')

  // T4.2 API Key 未配置（deepseek provider）：chat 返回 400 明确提示
  // 临时把 provider 切到 deepseek-official（无 key），验证守卫后恢复。
  // 设置文件路径与 @diver/backend 的 cosHome() 语义一致（COS_HOME 优先）。
  const { cosHome } = await import('@diver/backend/session-helpers')
  const settingsPath = join(cosHome(), 'diver-settings.json')
  const savedSettings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null
  try {
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }), 'utf8')
  } catch { /* 忽略 */ }
  let chatGuard = false
  let chatGuardMsg = ''
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    })
    if (res.status === 400) {
      chatGuard = true
      chatGuardMsg = (await res.json()).error ?? ''
    }
  } catch { /* 忽略 */ }
  if (savedSettings !== null) {
    try { writeFileSync(settingsPath, savedSettings, 'utf8') } catch { /* 忽略 */ }
  }
  record('T4.2', 'API Key 未配置 → chat 400 明确提示', chatGuard, chatGuard ? `400: ${chatGuardMsg}` : '未返回 400')

  // T4.3 未知 provider：创建成功，但首轮 turn 以 error 结束（不崩溃）
  let unknownProvider = false
  let unknownProviderDetail = ''
  try {
    const { agent } = await ctx.agentLoop.createAgent({
      agentOptions: { provider: 'no-such-provider', model: 'x' },
    })
    agent.followup(createUserMessage('hi', { kind: 'human' }))
    await agent.whenIdle()
    const lastTurn = [...agent.session.events].reverse().find((e) => e.type === 'turn/end')
    const reason = lastTurn?.data.reason
    unknownProvider = reason?.kind === 'error'
    unknownProviderDetail = reason?.kind === 'error'
      ? `turn 以 error 结束: ${reason.error?.message ?? ''}`
      : `turn 结束 reason=${reason?.kind ?? 'unknown'}`
  } catch (err) {
    console.error('  未知 provider 抛未捕获异常:', err)
  }
  record('T4.3', '未知 provider → 首轮 turn 报错不崩溃', unknownProvider, unknownProvider ? unknownProviderDetail : '未按预期报错')

  // ── 汇总 ───────────────────────────────────────────────────────
  console.log('\n=== 结果汇总 ===')
  const failed = results.filter((r) => !r.pass)
  for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} [${r.id}] ${r.name}`)
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) {
    console.log('失败项:')
    for (const f of failed) console.log(`  - [${f.id}] ${f.name}: ${f.detail}`)
  }

  await ctx.fiber.dispose()
  // 清理测试数据（临时 COS_HOME 与持久化根），不残留任何文件。
  try { rmSync(testHome, { recursive: true, force: true }) } catch { /* 忽略 */ }
  process.exit(failed.length === 0 ? 0 : 1)
}

void main()