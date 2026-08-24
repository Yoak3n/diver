// @diver/backend — secrets 文件读写助手。
//
// harness 的 @cos/credentials 是只读的（env / secrets 文件来源，无 set()）。
// 设置面板保存 API Key 时，这里直接读写 secrets 文件（credentials.config.file，
// 默认 ./secrets.yml），与 @cos/credentials 的读取来源保持一致。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** 解析 secrets 文件路径（相对 cwd 解析；未配置时默认 ./secrets.yml）。 */
function secretsPath(): string {
  const file = process.env.COS_SECRETS_FILE ?? './secrets.yml'
  return isAbsolute(file) ? file : resolve(process.cwd(), file)
}

/** 读取 secrets 文件为对象（不存在/解析失败返回空对象）。 */
export function readSecrets(): Record<string, unknown> {
  const file = secretsPath()
  try {
    if (!existsSync(file)) return {}
    const doc = parseYaml(readFileSync(file, 'utf8'))
    return typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 按点路径写入一个 secret（如 deepseek.apiKey），并落盘。 */
export function writeSecret(dotPath: string, value: string): void {
  const file = secretsPath()
  const root = readSecrets()
  const segments = dotPath.split('.')
  let cursor = root
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const next = cursor[seg]
    if (typeof next !== 'object' || next === null) {
      const fresh: Record<string, unknown> = {}
      cursor[seg] = fresh
      cursor = fresh
    } else {
      cursor = next as Record<string, unknown>
    }
  }
  cursor[segments[segments.length - 1]] = value
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, stringifyYaml(root), 'utf8')
  } catch (err) {
    console.error('[diver] 保存 secrets 失败:', err)
  }
}