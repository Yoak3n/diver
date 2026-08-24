/**
 * 第三方插件兼容性验证脚本（@diver/memory + @diver/backend，经 @diver/bundle-companion 组装）。
 *
 * 覆盖维度：
 *   T0 插件管理链路 —— DSH 对齐的 profile reconcile（pnpm add 后 bundle 自动进 layers）
 *   T1 初始化加载 —— profile 模式 boot：第三方 bundle 从 profile node_modules 解析、插件 apply() 正常执行
 *   T2 核心功能   —— memory 工具面/常驻注入、backend HTTP 端点
 *   T3 跨模块交互 —— memory↔sessions/llm/tools/systemPrompt、backend↔agentLoop/credentials/sessionPersistence
 *   T4 异常场景   —— Rust 后端未启动、API Key 未配置、未知 provider
 *
 * 运行：pnpm tsx scripts/compat-test.ts
 *
 * 形态：与 DSH 对齐的 profile 模型。脚本在临时 cos home 下构造一个 profile
 * （`dsh.profile.bundles` + node_modules 符号链接到 cos-plugins 源码），
 * 再用 `boot({ profile })` 走 profile 组装；不依赖 harness package.json 里的
 * 第三方依赖（已在迁移中移除）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { boot, bootOptionsFromCli, parseCliArgs } from '@cos/boot'
import { createUserMessage } from '@cos/types'
import { initProfile, readProfileManifest, reconcilePlugins, resolveProfileDir, writeProfileManifest } from '@cos/profile'
import { digestSession } from '../../cos-plugins/memory/src/extract'
import { MemoryStore } from '../../cos-plugins/memory/src/store-rpc'
import type { Context } from 'cordis'

const results: Array<{ id: string; name: string; pass: boolean; detail: string }> = []

function record(id: string, name: string, pass: boolean, detail: string) {
  results.push({ id, name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${id}] ${name} — ${detail}`)
}

/** Junction/symlink `target` at `link` (profile node_modules stand-in for pnpm). */
function ensureLink(link: string, target: string) {
  try {
    symlinkSync(resolve(target), link, 'junction')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

/** Construct the test profile: temp home under the harness, node_modules
 * junctions to ../cos-plugins (the "installation" of the third-party
 * packages). Returns the profile directory and the harness install anchor. */
function setUpProfile(tmpHome: string): { profileDir: string; anchor: string } {
  rmSync(tmpHome, { recursive: true, force: true })
  const profileDir = resolveProfileDir('compat', tmpHome)
  // Step 1: `pnpm plugin --profile compat add …` initializes an empty profile.
  initProfile(profileDir, [])
  const before = readProfileManifest('cos', profileDir)
  // Step 2: pnpm writes the dependencies; we hand-write them, plus the
  // node_modules junctions the install would materialize.
  writeProfileManifest(profileDir, {
    ...before,
    dependencies: {
      '@diver/bundle-companion': 'file:../../../cos-plugins/bundle-companion',
      yaml: '2.4.0',
    },
  })
  const nmScoped = join(profileDir, 'node_modules', '@diver')
  mkdirSync(nmScoped, { recursive: true })
  for (const pkg of ['bundle-companion', 'backend', 'memory']) {
    ensureLink(join(nmScoped, pkg), join(process.cwd(), '..', 'cos-plugins', pkg))
  }
  const anchor = join(process.cwd(), 'package.json')
  // Step 3: reconcile — a dependency that declares dsh.bundle joins the
  // profile layer stack; a plain library does not.
  reconcilePlugins('cos', before, profileDir, anchor)
  return { profileDir, anchor }
}

async function main() {
  console.log('=== 第三方插件兼容性验证（profile 模型）===\n')
  const cwd = process.cwd()
  const tmpHome = join(cwd, '.compat-test-home')

  // ── T0 插件管理链路（DSH 对齐的 reconcile）────────────────────
  console.log('--- T0 插件管理链路 ---')
  let profileDir: string
  const anchor = join(cwd, 'package.json')
  try {
    profileDir = setUpProfile(tmpHome).profileDir
    const manifest = readProfileManifest('cos', profileDir)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    record('T0.1', 'reconcile：dsh.bundle 依赖自动进 profile layers', bundles.includes('@diver/bundle-companion'),
      bundles.includes('@diver/bundle-companion') ? `layers: ${bundles.join(', ')}` : `layers 缺失: ${bundles.join(', ')}`)
    record('T0.2', 'reconcile：普通库不进 layers', !bundles.includes('yaml'),
      bundles.includes('yaml') ? 'yaml 被误加入 layers' : 'yaml 保持普通依赖')
    record('T0.3', 'profile 形态（package.json + node_modules + cordis.patch.yml）',
      existsSync(join(profileDir, 'package.json')) && existsSync(join(profileDir, 'node_modules', '@diver', 'backend')),
      profileDir)
  } catch (err) {
    record('T0.1', 'reconcile：dsh.bundle 依赖自动进 profile layers', false, String(err))
    record('T0.2', 'reconcile：普通库不进 layers', false, '未运行')
    record('T0.3', 'profile 形态（package.json + node_modules + cordis.patch.yml）', false, String(err))
  }

  // ── T1 初始化加载 ──────────────────────────────────────────────
  console.log('\n--- T1 初始化加载（diver 直连路径）---')
  // diver 直连模式：bundle 用路径直接指向 cos-plugins/bundle-companion，
  // 插件按 pluginPaths 从 cos-plugins 源码加载（无需 profile 安装）。
  const diverRoot = join(cwd, '..', 'cos-plugins')
  const cli = parseCliArgs(['--overlays', 'overlays/mock.yml'])
  let ctx: Context
  try {
    ctx = await boot(bootOptionsFromCli(cli, {
      bundles: [join(diverRoot, 'bundle-companion')],
      pluginPaths: {
        '@diver/memory': join(diverRoot, 'memory'),
        '@diver/backend': join(diverRoot, 'backend'),
      },
      required: ['agentLoop', 'llm', 'tools', 'sessions', 'agents', 'systemPrompt', 'credentials'],
    }))
    record('T1.1', 'diver 路径 boot 成功（cos-plugins/bundle-companion 直连挂载）', true, 'cordis.yml + 路径 bundle 组合树就绪')
  } catch (err) {
    record('T1.1', 'diver 路径 boot 成功（cos-plugins/bundle-companion 直连挂载）', false, String(err))
    console.log('\n=== 结果汇总 ===')
    const failed = results.filter((r) => !r.pass)
    console.log(`通过 ${results.length - failed.length}/${results.length}`)
    process.exit(1)
  }

  // memory 插件 apply() 是否执行（工具注册成功即证明 apply 跑通）
  const toolNames = ctx.tools.listDefinitions().map((t) => t.name)
  const memoryTools = ['remember', 'recall', 'inventory', 'demote']
  const missingTools = memoryTools.filter((t) => !toolNames.includes(t))
  record('T1.2', 'memory 插件 apply() 执行（4 个记忆工具注册）', missingTools.length === 0,
    missingTools.length === 0 ? `已注册: ${memoryTools.join(', ')}` : `缺失: ${missingTools.join(', ')}`)

  // backend 插件 apply() 是否执行（HTTP server 是否监听）
  const webUp = await new Promise<boolean>((resolveReady) => {
    const probe = () => {
      fetch('http://127.0.0.1:3620/api/health')
        .then((res) => resolveReady(res.ok))
        .catch(() => resolveReady(false))
    }
    probe()
    setTimeout(() => resolveReady(false), 3000)
  })
  record('T1.3', 'backend 插件 apply() 执行（HTTP server 监听 3620）', webUp, webUp ? 'health 端点可达' : '端口未监听')

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
    const res = await fetch('http://127.0.0.1:3620/api/health')
    healthOk = res.ok
    healthBody = await res.text()
  } catch { /* 忽略 */ }
  record('T2.2', 'backend /api/health 端点', healthOk, healthOk ? healthBody.slice(0, 120) : '请求失败')

  // T2.3 backend settings 端点
  let settingsOk = false
  try {
    const res = await fetch('http://127.0.0.1:3620/api/settings')
    settingsOk = res.ok
  } catch { /* 忽略 */ }
  record('T2.3', 'backend /api/settings 端点', settingsOk, settingsOk ? '返回 200' : '请求失败')

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

  // T3.2 memory ↔ sessions：session/event 监听（投递一条用户消息，验证事件流不抛错）
  let eventWired = true
  try {
    const agent = ctx.agents.get('diver-companion' as never)
    if (agent) {
      agent.followup(createUserMessage('测试消息', { kind: 'human' }))
      await agent.whenIdle()
    }
  } catch (err) {
    eventWired = false
    console.error('  session/event 流异常:', err)
  }
  record('T3.2', 'memory ↔ sessions（session/event 事件流）', eventWired, eventWired ? '消息投递 + turn 完成无异常' : '事件流异常')

  // T3.3 memory ↔ llm：digest 路径（Rust 后端未启动时应优雅降级，不抛未捕获异常）
  let digestGraceful = true
  try {
    const diff = await digestSession(ctx, { profile: '', agent_model: '', relationship: '' }, { total: 0 }, '测试摘要')
    // Rust 后端未启动 → llmText 可能失败返回 null，或 stats 失败回退；都不应抛未捕获异常
    void diff
  } catch (err) {
    digestGraceful = false
    console.error('  digest 路径异常:', err)
  }
  record('T3.3', 'memory ↔ llm（digestSession 调用）', digestGraceful, digestGraceful ? '调用完成（后端缺失时优雅降级）' : '抛未捕获异常')

  // T3.4 backend ↔ sessionPersistence：history 端点读取持久化事件
  let historyOk = false
  try {
    const res = await fetch('http://127.0.0.1:3620/api/history')
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
  // 临时把 provider 切到 deepseek-official（无 key），验证守卫后恢复 mock。
  const settingsPath = join(cwd, '.dsh-home', 'diver-settings.json')
  const savedSettings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null
  try {
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }), 'utf8')
  } catch { /* 忽略 */ }
  let chatGuard = false
  let chatGuardMsg = ''
  try {
    const res = await fetch('http://127.0.0.1:3620/api/chat', {
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

  // ── T5 profile 机制（通用 DSH 形态，diver 项目不用）──────────
  console.log('\n--- T5 profile 机制（通用 DSH 形态）---')
  await ctx.fiber.dispose() // 先释放 T1-T4 的 ctx（backend 端口 3620）
  let profileBootOk = false
  try {
    const pcli = parseCliArgs(['--profile', 'compat', '--overlays', 'overlays/mock.yml'])
    const pctx = await boot(bootOptionsFromCli(pcli, {
      home: tmpHome,
      installAnchor: anchor,
      required: ['agentLoop', 'llm', 'tools', 'sessions', 'agents', 'systemPrompt', 'credentials'],
    }))
    const ptools = pctx.tools.listDefinitions().map((t) => t.name)
    profileBootOk = ['remember', 'recall', 'inventory', 'demote'].every((t) => ptools.includes(t))
    await pctx.fiber.dispose()
  } catch (err) {
    console.error('  profile boot 异常:', err)
  }
  record('T5.1', 'profile 机制 boot 仍可用（临时 home + 双锚点解析）', profileBootOk, profileBootOk ? 'memory 工具注册' : 'boot 失败')

  // ── 汇总与清理 ─────────────────────────────────────────────────
  rmSync(tmpHome, { recursive: true, force: true })

  console.log('\n=== 结果汇总 ===')
  const failed = results.filter((r) => !r.pass)
  for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} [${r.id}] ${r.name}`)
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) {
    console.log('失败项:')
    for (const f of failed) console.log(`  - [${f.id}] ${f.name}: ${f.detail}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

void main()