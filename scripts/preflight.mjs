// Diver 打包前置自愈（tauri.conf.json beforeBuildCommand 第二步，bundle-release 之前）。
//
// 目前只有一件事：harness lockfile 与 manifest 失配时自动重生成。bundle-release
// 组装 sidecar 时对 harness 副本跑 `pnpm install --offline --frozen-lockfile`，
// 源头 lockfile 不同步会让每次 `pnpm tauri build` 都死在同一处；在这里提前发现
// 并修好**源仓库**的 lockfile（修副本没用——下次构建又从源头拷坏的）。
//
// 守卫：仅 Linux 本机生效。CI 上 lockfile 由「install --frozen-lockfile」步骤
// 把关（失配就该当场失败，不能静默重写）；Windows 本机开发不存在，不折腾。
// 用法：由 tauri build 自动调用，无需手工运行。

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

if (process.platform !== 'linux' || process.env.CI !== undefined) {
  process.exit(0)
}

const quiet = (cmd) => {
  const r = spawnSync(cmd, { cwd: join(ROOT, 'harness'), stdio: 'pipe', shell: true })
  return r.status === 0
}

if (quiet('pnpm install --offline --frozen-lockfile')) {
  console.log('[preflight] harness lockfile 同步')
  process.exit(0)
}

console.log('[preflight] harness lockfile 失配，重新生成 …')
const regen = spawnSync('pnpm install --lockfile-only', { cwd: join(ROOT, 'harness'), stdio: 'inherit', shell: true })
if (regen.status !== 0 || !quiet('pnpm install --offline --frozen-lockfile')) {
  console.error('[preflight] lockfile 重新生成后仍无法离线 frozen 安装，请手动检查 harness/pnpm-lock.yaml')
  process.exit(1)
}
console.log('[preflight] harness lockfile 已重新生成')
