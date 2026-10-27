// 文件囚笼单测：层级策略、containment、符号链接/..逃逸、字段提取、缺省路径代查。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FS_SCOPED_PATH_FIELDS,
  buildFsPolicy,
  fsCheckCall,
  fsPathArgOf,
  fsVetoReason,
} from './fs-jail.ts'

function baselinePolicy(root: string, extra: string[] = []) {
  return buildFsPolicy(root, extra, false)
}

function ownerPolicy(root: string, extra: string[] = []) {
  return buildFsPolicy(root, extra, true)
}

test('策略层级：基线扣 sessions 子树与五个文件名；主人私聊只扣凭据', () => {
  const base = baselinePolicy('/cos')
  assert.deepEqual(base.roots, ['/cos'])
  assert.deepEqual(base.deniedSubtrees, [join('/cos', 'sessions')])
  assert.deepEqual(base.allowedSubtrees, [])
  for (const name of ['secrets.yml', 'secrets.yaml', 'group-sent.jsonl', 'cos-settings.json', 'instances.json']) {
    assert.equal(base.deniedNames.has(name), true, name)
    assert.equal(base.protectedPaths.includes(join('/cos', name)), true, name)
  }

  const owner = ownerPolicy('/cos')
  assert.deepEqual(owner.deniedSubtrees, [])
  assert.deepEqual(owner.protectedPaths, [join('/cos', 'secrets.yml'), join('/cos', 'secrets.yaml')])
  assert.equal(owner.deniedNames.has('secrets.yml'), true)
  assert.equal(owner.deniedNames.has('group-sent.jsonl'), false)
  assert.equal(owner.deniedNames.has('cos-settings.json'), false)
})

test('containment：根内放行、根外拒、根前缀不误判', () => {
  const policy = baselinePolicy('/cos')
  assert.equal(fsVetoReason('/cos/workspace/a.ts', '/cos/workspace/a.ts', policy), undefined)
  assert.match(fsVetoReason('/etc/passwd', '/etc/passwd', policy) ?? '', /越界/)
  // /cos-evil 不是 /cos 的子路径（无分隔符拼接不算前缀）。
  assert.match(fsVetoReason('/cos-evil/x', '/cos-evil/x', policy) ?? '', /越界/)
})

test('基线拒绝：sessions 子树与敏感文件名（含嵌套位置）', () => {
  const policy = baselinePolicy('/cos')
  assert.match(fsVetoReason('/cos/sessions/2026.jsonl', '/cos/sessions/2026.jsonl', policy) ?? '', /不可读的目录/)
  assert.match(fsVetoReason('/cos/secrets.yml', '/cos/secrets.yml', policy) ?? '', /敏感落盘/)
  assert.match(fsVetoReason('/cos/workspace/deep/group-sent.jsonl', '/cos/workspace/deep/group-sent.jsonl', policy) ?? '', /敏感落盘/)
})

test('笔记作用域例外：自己的 scope 放行，兄弟 scope/笔记根拒绝', () => {
  const notes = join('/cos', 'notes')
  const policy = buildFsPolicy('/cos', [], false, {
    extraDeniedSubtrees: [notes],
    allowedSubtrees: [join(notes, 'group-1')],
  })
  assert.equal(fsVetoReason(join(notes, 'group-1', 'diary.md'), join(notes, 'group-1', 'diary.md'), policy), undefined)
  assert.match(fsVetoReason(join(notes, 'group-2', 'diary.md'), join(notes, 'group-2', 'diary.md'), policy) ?? '', /不可读的目录/)
  assert.match(fsVetoReason(notes, notes, policy) ?? '', /不可读的目录/)
})

test('递归工具：受保护路径的祖先起点拒绝；自己 scope 的祖先例外不误伤', () => {
  const base = baselinePolicy('/cos')
  // 非递归（ls）允许在 COS_HOME 根列名字。
  assert.equal(fsVetoReason('/cos', '/cos', base, false), undefined)
  // grep/find 从 COS_HOME 根起步会扫进 sessions。
  assert.match(fsVetoReason('/cos', '/cos', base, true) ?? '', /递归搜索/)
  assert.equal(fsVetoReason(join('/cos', 'workspace'), join('/cos', 'workspace'), base, true), undefined)

  // 主人私聊没有 deniedSubtree，但 secrets 文件仍是受保护路径。
  const owner = ownerPolicy('/cos')
  assert.match(fsVetoReason('/cos', '/cos', owner, true) ?? '', /递归搜索/)
  assert.equal(fsVetoReason(join('/cos', 'workspace'), join('/cos', 'workspace'), owner, true), undefined)

  const notes = join('/cos', 'notes')
  const scoped = buildFsPolicy('/cos', [], false, {
    extraDeniedSubtrees: [notes],
    allowedSubtrees: [join(notes, 'group-1')],
  })
  assert.equal(fsVetoReason(join(notes, 'group-1'), join(notes, 'group-1'), scoped, true), undefined)
  assert.match(fsVetoReason(notes, notes, scoped, true) ?? '', /不可读的目录/)
})

test('主人私聊：sessions 可读、群发言账可读、凭据仍拒', () => {
  const policy = ownerPolicy('/cos')
  assert.equal(fsVetoReason('/cos/sessions/2026.jsonl', '/cos/sessions/2026.jsonl', policy), undefined)
  assert.equal(fsVetoReason('/cos/group-sent.jsonl', '/cos/group-sent.jsonl', policy), undefined)
  assert.match(fsVetoReason('/cos/secrets.yml', '/cos/secrets.yml', policy) ?? '', /敏感落盘/)
})

test('字段提取：受限工具取各自字段；缺省/空白为 null；非受限为 undefined', () => {
  assert.deepEqual(FS_SCOPED_PATH_FIELDS, { read: 'file_path', ls: 'path', find: 'path', grep: 'path' })
  assert.equal(fsPathArgOf('read', { file_path: '/a' }), '/a')
  assert.equal(fsPathArgOf('grep', { path: 'src' }), 'src')
  assert.equal(fsPathArgOf('grep', {}), null)
  assert.equal(fsPathArgOf('ls', { path: '  ' }), null)
  assert.equal(fsPathArgOf('write', { file_path: '/a' }), undefined)
  assert.equal(fsPathArgOf('read', undefined), null)
})

test('fsCheckCall 集成：相对基准解析、.. 与符号链接逃逸、缺省代查 workspace', async () => {
  // 根一律 realpath（macOS tmpdir 是符号链接，词法路径会让 containment 假失败）。
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'diver-jail-out-')))
  const cos = await realpath(await mkdtemp(join(tmpdir(), 'diver-jail-cos-')))
  const workspace = join(cos, 'workspace')
  const sessions = join(cos, 'sessions')
  const notes = join(cos, 'notes')
  await mkdir(workspace)
  await mkdir(sessions)
  await mkdir(join(notes, 'group-1'), { recursive: true })
  await mkdir(join(notes, 'group-2'), { recursive: true })
  await writeFile(join(workspace, 'note.md'), 'hello')
  await writeFile(join(sessions, 'today.jsonl'), '[]')
  await writeFile(join(cos, 'group-sent.jsonl'), '[]')
  await writeFile(join(notes, 'group-1', 'mine.md'), 'mine')
  await writeFile(join(notes, 'group-2', 'other.md'), 'other')
  await symlink(join(outside, 'secret.txt'), join(workspace, 'escape-link.md'))
  await writeFile(join(outside, 'secret.txt'), 'root-only')

  const base = baselinePolicy(cos)
  // 根内常规读：放行。
  assert.equal(await fsCheckCall('read', { file_path: 'note.md' }, base, workspace), undefined)
  // .. 逃逸到根外：拒。
  assert.match(await fsCheckCall('read', { file_path: '../../../outside.md' }, base, workspace) ?? '', /越界/)
  // 符号链接指向根外：realpath 落在囚笼外，拒。
  assert.match(await fsCheckCall('read', { file_path: 'escape-link.md' }, base, workspace) ?? '', /越界/)
  // 会话记录与敏感文件名：拒。
  assert.match(await fsCheckCall('read', { file_path: join(sessions, 'today.jsonl') }, base, workspace) ?? '', /不可读的目录/)
  assert.match(await fsCheckCall('grep', { pattern: 'x', path: 'group-sent.jsonl' }, base, workspace) ?? '', /敏感落盘/)
  // 字段缺省：ls/find/grep 默认 workspace 根，放行。
  assert.equal(await fsCheckCall('grep', { pattern: 'x' }, base, workspace), undefined)
  // 非受限工具：直接放行（不归囚笼管）。
  assert.equal(await fsCheckCall('write', { file_path: '/etc/x' }, base, workspace), undefined)

  // 递归工具从 COS_HOME 根起步：拒（会扫进 sessions）；workspace 起步：放行。
  assert.match(await fsCheckCall('grep', { pattern: 'x', path: cos }, base, workspace) ?? '', /递归搜索/)
  assert.match(await fsCheckCall('find', { pattern: '*', path: cos }, base, workspace) ?? '', /递归搜索/)
  assert.equal(await fsCheckCall('ls', { path: cos }, base, workspace), undefined)

  // 笔记作用域：自己的 scope 可读，兄弟 scope 拒。
  const scoped = buildFsPolicy(cos, [], false, {
    extraDeniedSubtrees: [notes],
    allowedSubtrees: [join(notes, 'group-1')],
  })
  assert.equal(await fsCheckCall('read', { file_path: join(notes, 'group-1', 'mine.md') }, scoped, workspace), undefined)
  assert.match(await fsCheckCall('read', { file_path: join(notes, 'group-2', 'other.md') }, scoped, workspace) ?? '', /不可读的目录/)
  assert.equal(await fsCheckCall('grep', { pattern: 'mine', path: join(notes, 'group-1') }, scoped, workspace), undefined)
  assert.match(await fsCheckCall('grep', { pattern: 'x', path: cos }, scoped, workspace) ?? '', /递归搜索/)

  // 主人私聊：sessions 可读，凭据仍拒。
  const owner = ownerPolicy(cos)
  assert.equal(await fsCheckCall('read', { file_path: join(sessions, 'today.jsonl') }, owner, workspace), undefined)
  assert.match(await fsCheckCall('read', { file_path: '../secrets.yaml' }, owner, workspace) ?? '', /敏感落盘/)
  assert.match(await fsCheckCall('grep', { pattern: 'x', path: cos }, owner, workspace) ?? '', /递归搜索/)

  // 额外根（dev repo）：根外路径在额外根内放行。
  const withExtra = baselinePolicy(cos, [outside])
  assert.equal(await fsCheckCall('read', { file_path: 'secret.txt' }, withExtra, workspace), undefined)

  await rm(cos, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})
