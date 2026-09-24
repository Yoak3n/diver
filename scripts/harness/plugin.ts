/**
 * `pnpm plugin --profile <name> <args...>` — profile plugin management as a
 * thin pnpm forwarder (DSH-aligned): initialize the profile on first use, run
 * `pnpm <args...>` in the profile directory, then reconcile the
 * `dsh.profile.bundles` layer list against the installed state (a dependency
 * resolving to a package that declares `dsh.bundle` joins the layer stack; a
 * removed or bundle-less dependency leaves it). Reconciling by installed
 * state, not by dependency diff, means `update` activates a package that
 * gained its `dsh.bundle` declaration in a newer version.
 *
 * Usage (from the harness directory):
 *   pnpm plugin --profile companion add file:../cos-plugins/bundle-companion
 *   pnpm plugin --profile companion remove @diver/backend
 *   pnpm plugin --profile companion -- --help          # pnpm's own help
 *   pnpm plugin --profile companion --cos-home <path>  # non-default cos home
 * @module cos/plugin
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DEFAULT_PROFILE_BUNDLES,
  PROFILE_TEMPLATES,
  initProfile,
  readProfileManifest,
  reconcilePlugins,
  resolveCosHome,
  resolveProfileDir,
  type ProfileManifest,
} from '@cos/profile'

const NAME = 'cos'

/** The cos installation anchor (its own package.json), for two-anchor resolution. */
function installAnchor(): string {
  const anchor = join(process.cwd(), 'package.json')
  if (!existsSync(anchor)) throw new Error(`${NAME}: cannot find the cos installation manifest at ${anchor}`)
  return anchor
}

/** Parse `--profile <name> [--cos-home <path>] [-- <pnpm args>]`. */
function parseArgv(argv: readonly string[]): { profile: string; home: string; args: string[] } {
  let profile: string | undefined
  let home: string | undefined
  const args: string[] = []
  let rest = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!rest && flag === '--') { rest = true; continue }
    if (!rest && flag === '--profile') { profile = argv[index + 1]; index += 1; continue }
    if (!rest && flag === '--cos-home') { home = argv[index + 1]; index += 1; continue }
    args.push(flag)
  }
  if (profile === undefined || profile === '') {
    process.stderr.write(`${NAME}: plugin needs --profile <name> (e.g. pnpm plugin --profile companion add <package>)\n`)
    process.exit(2)
  }
  return { profile, home: home ?? resolveCosHome(), args }
}

/**
 * Rewrite relative filesystem specs against the user's invoking directory.
 * pnpm runs with cwd = the profile directory, so a bare `.` or `../plugin`
 * (or their `file:`/`link:` forms) would silently resolve inside the profile
 * — `add .` from a plugin checkout would self-link the profile. Absolute
 * specs, registry names, and every other pnpm argument pass through
 * untouched.
 * @param argument - one pnpm argument, verbatim from argv.
 * @param cwd - the directory `cos` was invoked from.
 * @returns the argument with a relative path spec anchored to `cwd`.
 */
function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  // A bare path stays bare and a prefixed spec keeps its prefix: pnpm's
  // link-vs-copy semantics differ between `file:` and a plain directory
  // path, and the anchor must not change which one the user asked for.
  const prefix = match.groups.prefix ?? ''
  return `${prefix}${resolve(cwd, match.groups.path)}`
}

/**
 * Run one `pnpm plugin` invocation: init if needed, forward to pnpm, reconcile.
 * @param profile - the profile name.
 * @param home - the cos home.
 * @param args - pnpm arguments with relative path specs anchored to the invoking directory.
 * @returns the pnpm exit code.
 */
export function runPlugin(profile: string, home: string, args: readonly string[]): number {
  const dir = resolveProfileDir(profile, home)
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)
    process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`)
  }
  const before = readProfileManifest(NAME, dir) as ProfileManifest
  const anchor = installAnchor()
  // Windows resolves pnpm through its .cmd shim, which spawn() refuses
  // without a shell since the CVE-2024-27980 hardening.
  const result = spawnSync('pnpm', args.map((argument) => anchorPathSpec(argument, process.cwd())), {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      process.stderr.write(`${NAME}: pnpm not found on PATH — install pnpm to manage profile plugins\n`)
      return 127
    }
    throw result.error
  }
  const exitCode = result.status ?? 1
  if (exitCode === 0) {
    reconcilePlugins(NAME, before, dir, anchor)
  } else {
    // pnpm's own diagnostics name pnpm-workspace.yaml without saying WHICH
    // one; the profile owns it, and the commonest failure here is pnpm ≥10
    // blocking a git dependency's prepare (build) script until allowlisted.
    process.stderr.write(`${NAME}: pnpm failed in profile directory ${dir}\n`)
    if (args.some((argument) => /^git\+|^github:|\.git(?:#|$)/.test(argument))) {
      process.stderr.write(
        `${NAME}: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — `
        + `add the exact key pnpm printed above under allowBuilds in ${join(dir, 'pnpm-workspace.yaml')}, then re-run\n`,
      )
    }
  }
  return exitCode
}

const parsed = parseArgv(process.argv.slice(2))
process.exit(runPlugin(parsed.profile, parsed.home, parsed.args))