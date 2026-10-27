// grep 路径解析回归：相对路径按 workspace 解析，不再原样交给 Rust。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveGrepTarget } from './grep.ts'

test('相对路径按 workspace 解析；缺省为 workspace 根；绝对路径原样', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'diver-grep-path-')))
  try {
    await mkdir(join(workspace, 'src'))
    const relative = await resolveGrepTarget(workspace, 'src')
    assert.equal(relative.targetKey, join(workspace, 'src'))
    assert.equal(relative.displayPath, join(workspace, 'src'))

    const defaulted = await resolveGrepTarget(workspace, undefined)
    assert.equal(defaulted.targetKey, workspace)

    const parent = await resolveGrepTarget(workspace, '..')
    assert.equal(parent.targetKey, await realpath(join(workspace, '..')))

    const absolute = await resolveGrepTarget(workspace, join(workspace, 'src'))
    assert.equal(absolute.targetKey, join(workspace, 'src'))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
