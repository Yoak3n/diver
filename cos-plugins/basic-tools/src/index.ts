// @diver/basic-tools — 基础工具插件（read / write / edit / multi_edit / sh / grep / ls / find / list_displays / screenshot）。
//
// 逻辑移植自 DSH 上游（@deepseek-ai/dsh-tool-fs 与 dsh-tool-fs-search），适配
// @cos/tools 极简注册表（executor 返回 {content} 字符串）：
// - read/write/edit：窗口读取、原子写、版本守卫、行尾还原等成熟算法照搬上游；
// - grep：引擎在 Rust 壳（search.grep RPC，ripgrep），Node 侧为 RPC 客户端；
// - sh：保留原自研实现（一次新进程执行）。
//
// 接入方式（见 harness/docs/plugins.md）：
//   pnpm add file:../cos-plugins/basic-tools
//   cordis.patch.yml: - insert: [{ id: basic-tools, name: '@diver/basic-tools' }]

import { join } from 'node:path'
import type { Context } from 'cordis'
import type {} from '@cos/plugin-api'

import { applyReadTool } from './read.ts'
import { applyWriteTool } from './write.ts'
import { applyEditTool } from './edit.ts'
import { applyMultiEditTool } from './multi-edit.ts'
import { applyScreenshotTools } from './screenshot.ts'
import { applyShTool } from './sh.ts'
import { applyGrepTool } from './grep.ts'
import { applyLsTool } from './ls.ts'
import { applyFindTool } from './find.ts'
import { ObservationTable } from './observation.ts'

export const name = 'basic-tools'

export const inject = ['tools', 'systemPrompt']

/** Settings-page form for `apply(ctx, config)` values (Desktop model-config style). */
export const configDecl = {
  title: '基础工具',
  fields: [
    {
      key: 'workspaceRoot',
      label: '工作区根目录',
      type: 'text' as const,
      description: '相对 file_path 的解析基准；默认 $COS_HOME/workspace',
    },
    {
      key: 'shTimeoutMs',
      label: 'sh 超时（毫秒）',
      type: 'number' as const,
      default: 60000,
      description: '每次 sh 调用的默认超时',
    },
    {
      key: 'requireObservation',
      label: '要求先 read 再 write/edit',
      type: 'boolean' as const,
      default: true,
    },
  ],
}

/** 当前进程的 cos home（sidecar 启动时由 Rust 注入 COS_HOME）。 */
export function cosHome() {
  return process.env.COS_HOME ?? join(process.cwd(), '.cos-home')
}

/** 插件配置：workspace 根（相对路径基准）与 shell 默认超时。 */
export interface Config {
  /** 文件工具的路径基准：相对 file_path 在此解析，默认 $COS_HOME/workspace。 */
  workspaceRoot?: string
  /** sh 的默认超时毫秒数（每次调用可用 timeoutMs 覆盖），默认 60s。 */
  shTimeoutMs?: number
  /** 是否要求 read-first 守卫（write/edit 前必须先 read），默认 true。 */
  requireObservation?: boolean
}

export function apply(ctx: Context, config: Config = {}) {
  const workspaceRoot = config.workspaceRoot ?? join(cosHome(), 'workspace')
  const shTimeoutMs = Number(config.shTimeoutMs) || 60_000
  const requireObservation = config.requireObservation ?? true

  // 会话级 read-first 观察表（write/edit 守卫）。
  const observation = new ObservationTable(requireObservation)

  applyReadTool(ctx, { workspaceRoot, observation })
  applyWriteTool(ctx, { workspaceRoot, observation })
  applyEditTool(ctx, { workspaceRoot, observation })
  applyMultiEditTool(ctx, { workspaceRoot, observation })
  applyScreenshotTools(ctx, { timeoutMs: shTimeoutMs })
  applyShTool(ctx, { workspaceRoot, timeoutMs: shTimeoutMs })
  applyGrepTool(ctx, { workspaceRoot })
  applyLsTool(ctx, { workspaceRoot })
  applyFindTool(ctx, { workspaceRoot })

  console.log(`[basic-tools] 十个基础工具就绪（workspace=${workspaceRoot}, requireObservation=${requireObservation}）`)
}
