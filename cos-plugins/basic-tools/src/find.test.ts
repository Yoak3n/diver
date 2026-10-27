// find 遍历回归：lstat 不跟随符号链接，链接目录/文件不会把遍历带出根外。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdir, mkdtemp, realpath, rm, symlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { walkGlob } from './find.ts'

test('符号链接目录不递归、链接文件不列出', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'diver-find-root-')))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'diver-find-out-')))
  try {
    await mkdir(join(root, 'inside'))
    await writeFile(join(root, 'inside', 'a.md'), 'a')
    await writeFile(join(outside, 'secret.md'), 'secret')
    await symlink(outside, join(root, 'link-dir'))
    await symlink(join(outside, 'secret.md'), join(root, 'link-file.md'))

    const hits = await walkGlob(root, '**/*.md', 100)
    assert.deepEqual(hits, ['inside/a.md'])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
