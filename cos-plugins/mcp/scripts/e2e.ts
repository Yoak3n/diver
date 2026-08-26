// @diver/mcp — 端到端验证脚本（真实 bundle 加载路径）：
// boot harness + bundle-companion（含 mcp registry patch 行），
// 经 loader 挂载 MCP 插件，验证工具注册与调用。
// 用法（harness 目录）：node --import tsx ../cos-plugins/mcp/scripts/e2e.ts

import { join } from 'node:path'
import { boot } from '@cos/boot'
import { writeMcpConfigFile } from '../src/config-file.ts'

const repoRoot = process.env.DIVER_REPO_ROOT ?? 'E:/Project/RustProject/diver'
const harnessRoot = join(repoRoot, 'harness')
const pluginRoot = join(repoRoot, 'cos-plugins')

// seed 一份最小 MCP 配置（work-review），registry 模式从文件读取。
writeMcpConfigFile([
  {
    transport: 'stdio',
    serverName: 'work-review',
    command: 'E:\\Utils\\Work Review\\work-review-mcp-server.exe',
    args: [],
    env: {
      WORK_REVIEW_DB_PATH: 'E:\\Utils\\Work Review\\cache\\workreview.db',
      WORK_REVIEW_CONFIG_PATH: 'E:\\Utils\\Work Review\\cache\\config.json',
    },
    cwd: '',
    toolCallTimeoutMs: 30000,
  },
])

const ctx = await boot({
  configPath: join(harnessRoot, 'cordis.yml'),
  bundles: [join(pluginRoot, 'bundle-companion')],
  pluginPaths: {
    '@diver/mcp': join(pluginRoot, 'mcp'),
    '@diver/basic-tools': join(pluginRoot, 'basic-tools'),
    '@diver/memory': join(pluginRoot, 'memory'),
    '@diver/backend': join(pluginRoot, 'backend'),
  },
  required: ['agentLoop', 'llm', 'tools', 'sessions', 'agents', 'systemPrompt', 'credentials', 'sessionPersistence', 'subagents'],
})

const tools = ctx.tools
// 等后台连接 + 工具同步完成（diver cordis 不等 async apply，需轮询等待）。
let defs = tools.listDefinitions().map(d => d.name)
let waited = 0
while (!defs.some(n => n.startsWith('mcp__')) && waited < 15000) {
  await new Promise(r => setTimeout(r, 500))
  waited += 500
  defs = tools.listDefinitions().map(d => d.name)
}
console.log('[e2e] registered tools:', defs.join(', '))

const mcpTools = defs.filter(n => n.startsWith('mcp__'))
console.log(`[e2e] MCP tools (${mcpTools.length}):`, mcpTools.join(', '))

if (mcpTools.length === 0) {
  console.log('[e2e] FAIL: no MCP tools registered (loader path)')
  await ctx.fiber.dispose()
  process.exit(1)
}

// 调用 get_current_context（无参数，最安全）
const target = mcpTools.find(n => n.endsWith('get_current_context')) ?? mcpTools[0]
console.log(`[e2e] calling ${target} ...`)
const result = await tools.execute(target, {}, new AbortController().signal)
console.log('[e2e] result:', result.content.slice(0, 300))
console.log('[e2e] isError:', result.isError)

await ctx.fiber.dispose()
process.exit(result.isError ? 1 : 0)
