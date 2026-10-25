// @diver/companion — companion-boot 单测：credentials secrets 钉位与旧文件迁移。
//
// 背景（生产 bug）：引擎默认 `credentials.config.file: ./secrets.yml` 按 sidecar
// cwd 解析，打包布局 cwd=<install>/resources/sidecar 只读，设置面板保存 API Key
// 静默失败、始终「未配置」。companionBootOptions 必须对 normal 与 safe 两种
// profile 都注入 extraPatches 把该文件钉到 $COS_HOME/secrets.yml，并把残留在
// harness cwd 的旧 secrets.yml 一次性搬过去（目标已存在则不覆盖）。

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { companionBootOptions, type CompanionPaths } from './companion-boot.ts'
import type { CliOptions } from '../../../harness/packages/boot/src/index.ts'

/** 最小 CliOptions（companionBootOptions 只读 profile 字段）。 */
const cli = {
  profile: undefined,
} as unknown as CliOptions

/** 造一份能通过存在性检查的 CompanionPaths（harness/bundle 目录形状）。 */
function fakePaths(root: string): CompanionPaths {
  const harnessDir = join(root, 'harness')
  const bundleDir = join(root, 'bundle-companion')
  mkdirSync(join(harnessDir, 'packages'), { recursive: true })
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), 'insert: []\n')
  return { harnessDir, pluginsRoot: join(root, 'plugins'), bundleDir, configPath: join(harnessDir, 'cordis.yml') }
}

function withCosHome<T>(fn: (cosHome: string) => T): T {
  const prev = process.env.COS_HOME
  const cosHome = mkdtempSync(join(tmpdir(), 'diver-coshome-'))
  process.env.COS_HOME = cosHome
  try {
    return fn(cosHome)
  } finally {
    if (prev === undefined) delete process.env.COS_HOME
    else process.env.COS_HOME = prev
    rmSync(cosHome, { recursive: true, force: true })
  }
}

test('normal 与 safe profile 都把 credentials secrets 钉到 $COS_HOME/secrets.yml', () => {
  withCosHome((cosHome) => {
    for (const profile of [undefined, 'safe'] as const) {
      const opts = companionBootOptions(
        { ...cli, profile } as CliOptions,
        fakePaths(mkdtempSync(join(tmpdir(), 'diver-layout-'))),
      )
      const pin = opts.extraPatches?.find((p) => p.id === 'credentials')
      assert.ok(pin, `profile=${profile ?? 'companion'} 应注入 credentials pin`)
      assert.deepEqual(pin!.config, { file: join(cosHome, 'secrets.yml') })
    }
  })
})

test('旧 harness/secrets.yml 目标缺失时迁移；目标已存在则不覆盖', () => {
  withCosHome((cosHome) => {
    const paths = fakePaths(mkdtempSync(join(tmpdir(), 'diver-layout-')))
    const legacy = join(paths.harnessDir, 'secrets.yml')
    writeFileSync(legacy, 'opencode-go:\n  apiKey: legacy\n')

    companionBootOptions(cli, paths)
    assert.equal(
      readFileSync(join(cosHome, 'secrets.yml'), 'utf8'),
      'opencode-go:\n  apiKey: legacy\n',
    )

    // 第二次调用：目标已存在 → harness 侧的后续改动不再搬动
    writeFileSync(legacy, 'opencode-go:\n  apiKey: changed\n')
    companionBootOptions(cli, paths)
    assert.match(readFileSync(join(cosHome, 'secrets.yml'), 'utf8'), /legacy/)
  })
})
