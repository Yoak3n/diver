// @diver/backend — secrets 文件读写助手。
//
// 路径来源适配新版 harness：优先取框架配置的 credentials.config.file
// （@cos/credentials 的读取来源），其次 COS_SECRETS_FILE 环境变量，最后默认
// ./secrets.yml——写入与 @cos/credentials 的读取保持同一文件。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** 凭据服务来源的 secrets 文件路径（相对 cwd 解析；未配置时默认 ./secrets.yml）。 */
export function secretsFileOf(ctx?: { credentials?: { secretFile?: string } }): string {
  const file = ctx?.credentials?.secretFile ?? process.env.COS_SECRETS_FILE ?? './secrets.yml'
  return isAbsolute(file) ? file : resolve(process.cwd(), file)
}

/** 解析 secrets 文件路径（相对 cwd 解析；未配置时默认 ./secrets.yml）。 */
function secretsPath(): string {
  return secretsFileOf()
}

/** 读取 secrets 文件为对象（不存在/解析失败返回空对象）。 */
export function readSecrets(file: string = secretsPath()): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {}
    const doc = parseYaml(readFileSync(file, 'utf8'))
    return typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 按点路径写入一个 secret（如 deepseek.apiKey），并落盘到给定文件。 */
export function writeSecret(dotPath: string, value: string, file: string = secretsPath()): void {
  const root = readSecrets(file)
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