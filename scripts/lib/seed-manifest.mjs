/**
 * 出厂种子 manifest 生成（构建侧）。
 *
 * 与 harness/packages/boot/src/seed-manifest.ts **同算法**：
 * - hash = 归一化换行（\r\n → \n）后的 UTF-8 内容 sha256；
 * - seedVersion = 逐插件逐文件 hash 列表（键序归一）sha256 前 16 位。
 * 改任一侧必须同步另一侧。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 播种面忽略规则：依赖、点目录、增量编译产物。 */
export function ignoredName(name) {
  return name === 'node_modules' || name.startsWith('.') || name.endsWith('.tsbuildinfo')
}

/** 递归收集 `<dir>` 相对路径 → 内容 hash（POSIX 斜杠键）。 */
export function hashTree(dir) {
  const out = {}
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      if (ignoredName(name)) continue
      const childRel = rel === '' ? name : `${rel}/${name}`
      const abs = join(dir, childRel)
      if (statSync(abs).isDirectory()) walk(childRel)
      else out[childRel] = createHash('sha256')
        .update(readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n'), 'utf8')
        .digest('hex')
    }
  }
  walk('')
  return out
}

/** 由逐插件逐文件 hash 列表推导稳定 seedVersion。 */
export function deriveSeedVersion(plugins) {
  const canonical = JSON.stringify(
    Object.keys(plugins).sort().map((name) => [
      name,
      Object.keys(plugins[name].files).sort().map((f) => [f, plugins[name].files[f]]),
    ]),
  )
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

/** 为已复制的种子目录生成完整 manifest 对象。 */
export function buildSeedManifest(seedDir, pluginNames) {
  const plugins = {}
  for (const name of [...pluginNames].sort()) {
    plugins[name] = { files: hashTree(join(seedDir, name)) }
  }
  return {
    schemaVersion: 1,
    seedVersion: deriveSeedVersion(plugins),
    generatedAt: new Date().toISOString(),
    plugins,
  }
}
