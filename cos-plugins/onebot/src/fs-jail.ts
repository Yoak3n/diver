// @diver/onebot — OneBot 回合文件囚笼：只读工具（read/ls/find/grep）的路径边界。
//
// 层级见 sandbox.ts：受限回合里 write/edit/sh 等仍整类硬禁；本模块只管
// 「受限可见」的四个只读工具——QQ 回合可见，但目标路径必须落在囚笼内：
//  - 基线（群聊 / 陌生私聊）：COS_HOME 全域（含 workspace 与 profiles 插件源码），
//    扣除会话记录、笔记根（只豁免当前来源自己的 scope）与敏感落盘；
//  - 主人私聊：不受囚笼约束（unrestricted）——该回合工具面与本地桌面一致，
//    write/sh 本就能触及任意路径，再套只读囚笼只会造成语义分裂。
// 判定用 realpath containment：`..` 与符号链接逃逸都会被解析后再比对。
// 路径解析复用 @diver/basic-tools 的 resolveLocalTarget，与工具本体同一语义。
// grep/find 是递归的：起点若在受保护路径的祖先上，会把受保护内容一起扫出来，
// 因此额外拒绝这类起点（allowedSubtrees 内的自身笔记 scope 除外）。

import { basename, join, sep } from 'node:path'

import { resolveLocalTarget } from '@diver/basic-tools/fsio'

/**
 * 受限可见工具 → 路径参数字段。字段缺省时工具默认落在 workspace 根
 * （$COS_HOME/workspace，在囚笼内），调用方以默认根代查。
 * 清单与 config.ts BASELINE_TOOLS 中的四个只读项保持同步。
 */
export const FS_SCOPED_PATH_FIELDS: Readonly<Record<string, string>> = {
  read: 'file_path',
  ls: 'path',
  find: 'path',
  grep: 'path',
}

/**
 * 递归读取内容的工具：起点若是受保护路径的祖先，会把受保护内容一并扫出来
 * （grep 读内容、find 列路径）。这类工具只允许从受保护路径之外的子树起步。
 */
export const FS_RECURSIVE_TOOLS: ReadonlySet<string> = new Set(['grep', 'find'])

/** 任何层级都按文件名拒绝：明文凭据（相对 sidecar cwd 或 COS_SECRETS_FILE 落盘，位置可变，按名堵）。 */
const DENIED_NAMES_ALWAYS: ReadonlySet<string> = new Set(['secrets.yml', 'secrets.yaml'])

/** 基线额外按文件名拒绝：群发言落账（消息记录同源）与设置/实例绑定（含 token 类字段）。 */
const DENIED_NAMES_BASELINE: ReadonlySet<string> = new Set([
  'group-sent.jsonl',
  'cos-settings.json',
  'instances.json',
])

/** 基线额外拒绝的 COS_HOME 子树：会话记录（跨群/跨作用域聊天历史）。 */
const BASELINE_DENIED_SUBTREES = ['sessions'] as const

/** 任意层级都拒绝的敏感落盘文件名（凭据/记录/配置）。 */
export function isDeniedFileName(name: string): boolean {
  return DENIED_NAMES_ALWAYS.has(name) || DENIED_NAMES_BASELINE.has(name)
}

export interface FsPolicy {
  /** 允许根（realpath；COS_HOME + 配置额外根，如 dev 期的插件源码 repo）。 */
  roots: readonly string[]
  /** 拒绝子树（绝对路径，锚定在 COS_HOME 根）。 */
  deniedSubtrees: readonly string[]
  /** 从 deniedSubtrees 中挖出的例外（当前回合自己的笔记作用域）。 */
  allowedSubtrees: readonly string[]
  /** 按文件名拒绝（任意层级）。 */
  deniedNames: ReadonlySet<string>
  /** 拒绝名称的已知落盘位置：递归工具不能从它们的祖先起步。 */
  protectedPaths: readonly string[]
  /** 主人私聊：不做任何囚笼判定（判定直接放行）。 */
  unrestricted: boolean
}

export interface FsPolicyOptions {
  /** 追加拒绝子树（如笔记根）。 */
  extraDeniedSubtrees?: readonly string[]
  /** 从拒绝子树中挖出的例外（当前回合自己的笔记作用域）。 */
  allowedSubtrees?: readonly string[]
}

/** 构建囚笼策略；ownerPrivate = 主人私聊回合（见 sandbox.isOwnerSource + kind==='private'）。 */
export function buildFsPolicy(
  cosHome: string,
  extraRoots: readonly string[],
  ownerPrivate: boolean,
  options: FsPolicyOptions = {},
): FsPolicy {
  const deniedNames = ownerPrivate
    ? DENIED_NAMES_ALWAYS
    : new Set([...DENIED_NAMES_ALWAYS, ...DENIED_NAMES_BASELINE])
  return {
    roots: [cosHome, ...extraRoots],
    deniedSubtrees: [
      ...(ownerPrivate ? [] : BASELINE_DENIED_SUBTREES.map((name) => join(cosHome, name))),
      ...(options.extraDeniedSubtrees ?? []),
    ],
    allowedSubtrees: options.allowedSubtrees ?? [],
    deniedNames,
    // 默认布局下 secrets / 群发言账 / 设置 / 实例绑定都在 COS_HOME 根；
    // 递归工具从 COS_HOME 起步时会经过这些文件，起点判定据此拒绝。
    protectedPaths: [...deniedNames].map((name) => join(cosHome, name)),
    unrestricted: ownerPrivate,
  }
}

/** 路径是 root 本身或其后代。 */
export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
}

/** 囚笼判定：放行返回 undefined，否则返回模型可见拒因。realPath 必须是解析后的身份键。 */
export function fsVetoReason(
  displayPath: string,
  realPath: string,
  policy: FsPolicy,
  recursive = false,
): string | undefined {
  // 主人私聊：完整工具面，囚笼不参与判定。
  if (policy.unrestricted) return undefined
  if (!policy.roots.some((root) => isWithin(realPath, root))) {
    return `当前回合来自外部聊天（OneBot），文件访问仅限 ${policy.roots.join('、')} 之内："${displayPath}" 越界。`
  }
  if (policy.deniedNames.has(basename(realPath))) {
    return `"${basename(realPath)}" 是敏感落盘文件（凭据/记录/配置），OneBot 回合不可读。`
  }
  const allowed = policy.allowedSubtrees.some((subtree) => isWithin(realPath, subtree))
  if (!allowed && policy.deniedSubtrees.some((subtree) => isWithin(realPath, subtree))) {
    return `"${displayPath}" 位于 OneBot 回合不可读的目录（会话记录/其他来源的笔记）。`
  }
  if (recursive) {
    // 起点是受保护路径的祖先 → 递归会把受保护内容一起读出来。例外（如当前
    // 笔记作用域）若整体位于该受保护路径内，则不算越界。
    const carvedOut = (target: string): boolean =>
      policy.allowedSubtrees.some((subtree) => isWithin(subtree, target) && isWithin(realPath, subtree))
    const blocksAncestor = [...policy.deniedSubtrees, ...policy.protectedPaths]
      .some((target) => isWithin(target, realPath) && !carvedOut(target))
    if (blocksAncestor) {
      return `递归搜索不能从受保护路径的上级开始："${displayPath}" 会扫到不可读内容，请把 path 收窄到具体子目录或文件。`
    }
  }
  return undefined
}

/**
 * 从工具参数取路径字段：
 * undefined = 非受限工具（不走囚笼）；null = 字段缺省（以默认 workspace 根代查）；
 * string = 模型显式给的路径。
 */
export function fsPathArgOf(toolName: string, args: unknown): string | null | undefined {
  const field = FS_SCOPED_PATH_FIELDS[toolName]
  if (field === undefined) return undefined
  const value = (args as Record<string, unknown> | null | undefined)?.[field]
  if (typeof value !== 'string' || value.trim() === '') return null
  return value
}

/**
 * 解析并判定一次受限工具调用；放行返回 undefined，否则返回拒因。
 * relativeBase 是工具解析相对路径的基准（workspace 根）；注意 basic-tools 的
 * workspaceRoot 可被其自身配置覆盖，覆盖到囚笼外时需同步配置 fsExtraRoots。
 */
export async function fsCheckCall(
  toolName: string,
  args: unknown,
  policy: FsPolicy,
  relativeBase: string,
): Promise<string | undefined> {
  const raw = fsPathArgOf(toolName, args)
  if (raw === undefined) return undefined
  try {
    const target = await resolveLocalTarget(relativeBase, raw ?? '.')
    return fsVetoReason(
      target.displayPath,
      target.targetKey,
      policy,
      FS_RECURSIVE_TOOLS.has(toolName),
    )
  } catch {
    // 解析失败（空路径/父级非目录等）交给工具本体报错，囚笼不抢答。
    return undefined
  }
}
