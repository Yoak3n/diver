# Plugins & Layered Composition

This document is about how third-party plugins join the harness and how layers
compose — the two halves of delivering `cos` as a sidecar to an outer program.

> **Diver product contract:** the companion app's loader contract, profile
> enable/disable, shell plugin manager, and phased roadmap live in the repo
> doc [`docs/plugins.md`](../../docs/plugins.md). Prefer that document when
> changing diver behavior. This file stays focused on generic cos/DSH
> profile semantics.

## Diver unified loader contract (current default)

In the diver project both `companion.ts` (dev) and `companion-bundle.ts`
(release) share `companion-boot.ts`:

- **pluginPaths**: `@cos/*` core → `<harness>/packages/<pkg>/src/index.ts`
- **pluginRoot**: open plugin dir (`@diver/<name>` → `<pluginsRoot>/<name>`)
- **bundles**: companion bundle directory (`cordis.patch.yml` inserts)
- **profile**: `companion` under `$COS_HOME/profiles/companion/` — the shell
  writes `disabled: true` overrides here for enable/disable

`@cos/boot` filters bundle `insert` rows against those disable ids before
handing patches to `@cordisjs/plugin-include` (same-batch inserts are not
indexed by the include entry map, so a later `disabled` patch would miss them).

```sh
# dev (repo)
node --import tsx --expose-internals packages/sidecar/src/companion.ts \
  --profile companion \
  --plugin-root ../cos-plugins \
  --bundles ../cos-plugins/bundle-companion \
  --harness .

# release (install dir)
node.exe --import file:///.../tsx/dist/loader.mjs \
  --expose-internals harness/packages/sidecar/src/companion-bundle.ts \
  --profile companion \
  --plugin-root plugins \
  --bundles bundles/bundle-companion \
  --harness harness
```

Shell module: `src-tauri/src/plugins/mod.rs`. Catalog metadata:
`cos-plugins/bundle-companion/plugins.json`.

## Profile model (generic DSH-aligned form, optional)

Every boot is either a **flat** (installation-level) tree or a **profile** tree.
Profiles are the generic way third-party plugins join (other cos consumers that
pull diver bundles from a registry): a profile is a directory under
`<home>/profiles/<name>` holding its own `package.json` (out-of-tree plugin
dependencies plus the profile manifest `dsh.profile` with its ordered `bundles`
list), a `node_modules` pnpm manages for those plugins, and a
`cordis.patch.yml` (the profile's own user patch layer, applied after every
bundle layer).

- The cos home resolves `COS_HOME`, then `~/.cos`. This repo's
  shell drives `COS_HOME=<repo>/harness/.cos-home` (see
  `src-tauri/src/base/sidecar.rs`).
- The `dsh` manifest section is the ecosystem namespace (a bundle written for
  DSH works in a cos profile untouched); `cos` is accepted as an alias.
- Module resolution is **two-anchor**: a bundle name resolves first from the
  cos installation, then from the profile directory. The loader's `baseUrl` is
  anchored at the profile, and the maintained flat fallback
  `<home>/profiles/node_modules` (one symlink per package the installation
  depends on) makes every in-box `@cos/*` package Node-resolvable from any
  profile through the ordinary parent-walk — so profiles never reinstall the
  core.

### Managing a profile's plugins: `pnpm plugin`

`pnpm plugin --profile <name> <pnpm args...>` forwards pnpm into the profile
directory (initializing the profile on first use), then **reconciles** the
layer list against the installed state: a dependency whose package.json
declares `dsh.bundle.patch` (a bundle) joins `dsh.profile.bundles`
automatically; a removed or bundle-less dependency leaves it. Reconciling by
installed state means `update` activates a package that gained its `dsh.bundle`
declaration in a newer version.

```sh
# diver direct-path (default): boot the companion with the repo's cos-plugins
pnpm start:companion
node --import tsx --expose-internals packages/sidecar/src/companion.ts

# generic profile-managed plugins (other cos consumers):
pnpm plugin --profile <name> -- add <package>
pnpm plugin --profile <name> -- remove <package>
```

Booting a profile that does not exist yet auto-initializes an empty one and
warns that the bundle dependencies still need `pnpm plugin … add`.

### Profile layer order

```
base cordis.yml → overlays (COS_OVERLAYS + --overlays) → profile bundle layers
(dsh.profile.bundles order) → explicit --bundles → profile cordis.patch.yml
→ home cordis.patch.yml (<home>/cordis.patch.yml) → --patch → extraPatches
```

Patch semantics are the include patch engine: a row is patched by `id` or
inserted with `insert:`; inserted rows are indexed immediately so later layers
can patch them.

## Flat model (backward compatible)

Without `--profile`, boot composes the installation-level tree as before:

```
base cordis.yml → overlays → --bundles → cwd cordis.patch.yml → home patch → extraPatches
```

`--bundles` resolves each specifier from `node_modules/<spec>` (package-style:
manifest `dsh.bundle.patch`; dir-style: `cordis.patch.yml` / `bundle.yml` in
the package directory), then the top-level `bundles/<name>`. This is how the
in-repo mock bundle works: `pnpm dev --overlays overlays/mock.yml` or
`--bundles @cos/bundle-mock`.

The repo's own `@cos/*` core packages are **workspace dependencies** of the
harness (never installed into profiles); third-party packages (`@diver/*`) live
outside the workspace in `../cos-plugins` and are **installed into the
profile**, not into the harness's `package.json`.

## Writing a third-party plugin

1. Write a plugin package anywhere `node_modules` resolution reaches: a
   function plugin with named exports `name` / `inject` / `apply` (no default
   export).

   ```ts
   // plugins/my-tool/src/index.ts
   import type { Context } from 'cordis'
   import type { PromptSection } from '@cos/types'

   export const name = 'my-tool'
   export const inject = ['systemPrompt']  // optional: declare service deps

   export function apply(ctx: Context, config: { text?: string } = {}) {
     const section: PromptSection = { name: 'my/tool', order: 90, text: config.text ?? 'hello from my tool' }
     ctx.systemPrompt.section(section)     // or ctx.tools.register(...) for a tool
   }
   ```

2. Install it into a profile: `pnpm plugin --profile <name> add ...` (registry
   name, git URL, or `file:`). For the diver project itself, skip the install
   and mount the repo sources by path (see "Diver direct-path mode").

3. Mount it. If the package declares `"dsh": { "bundle": { "patch":
   "./cordis.patch.yml" } }`, reconcile adds it to `dsh.profile.bundles` and
   its patch rows mount at boot. For a plain plugin package, add a row to the
   profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: my-tool
         name: my-tool
         config:
           text: Greetings from my tool.
   ```

4. Restart the process (or let HMR reload it) — the section/text/tool is now
   live in every assembled prompt.

## Subagents (harness core, `@cos/subagents`)

`@cos/subagents` is a **core service** (mounted in `cordis.yml` like the other
`@cos/*` rows, not a third-party plugin): `ctx.subagents.run({...})` spawns one
short-lived worker agent over the same `@cos/agent-loop` the main agent uses,
so the worker gets the full loop (streaming, tool calls, request-error retry,
step caps) for free — no second LLM path to maintain.

```ts
// third-party plugin (e.g. cos-plugins/memory) delegating a digest job:
export const inject = ['subagents']  // ...plus whatever else the plugin needs

const result = await ctx.subagents.run({
  label: 'memory-digest',
  task: '…摘要正文…',
  system: '你是记忆消化 worker：必须用工具写记忆，不要输出 JSON…',
  toolNames: ['remember', 'recall', 'inventory', 'demote', 'memory_update_card'],
  tools: [{ name: 'memory_update_card', executor: async (args) => ({ content: '…' }), options: {…} }],
  provider, model, maxTokens: 900,
})
// result: { sessionId, text, transcript[], toolCalls[], reason }
```

Per run the service:

- creates one agent with a unique session id and `meta.ephemeral = true` —
  ephemeral sessions are **never persisted** (see `@cos/persistence`), so a
  digest worker leaves no JSONL artifacts and never appears in resumed history;
- replaces the assembled **system prompt** with `system` and filters the
  advertised **tool set** to `toolNames` (a `system-prompt/assemble`
  waterfall participant; every other caller's assembly is untouched);
- registers the inline `tools` executors into `ctx.tools` **for the run only**
  (unregistered on settle) — worker-only operations never leak into the main
  agent's tool surface;
- feeds `task` via `agent.followup`, waits `agent.whenIdle()` (tool loops
  settled), projects the transcript, then disposes the agent + session.

Caveats: worker system prompts must not reference unknown prompt variables
(only `{{provider}}` / `{{model}}` / `{{cwd}}` exist, registered by
`@cos/agent-loop`); the default wall-clock cap is `defaultTimeoutMs`
(`cordis.yml`, 120s default) with per-run `timeoutMs` overrides — on expiry the
worker is cancelled like a parent-cancelled turn.

### Running workers as a parallel background line

`run({ ..., signal })` accepts an external `AbortSignal`: aborting it cancels
the worker immediately (the real DeepSeek adapter threads the signal into its
HTTP request, so an in-flight generation stops). That is an *optional* kill
switch (teardown, operator intervention) — background work does not have to be
interleaved with the user's session. Because a worker is a fully independent
agent (own ephemeral session, own driver, own LLM request), the natural shape
is **parallel lines**: `@diver/memory`'s digest scheduler dispatches a worker
the moment material appears and never waits for the main agent to be idle, and
new user messages never cancel it — conversation and digestion simply proceed
concurrently (LLM concurrency stays at main + 1 worker; digests serialize
among themselves so they never fight over the same memory store).

## Sidecar consumption

**Stdin/stdout JSON-RPC (`@cos/sidecar/client` / `server` / `sidecar.ts`) has been
removed.** Outer programs consume cos through the resident **HTTP/SSE** entry:

- `packages/sidecar/src/companion.ts` (dev) or `companion-bundle.ts` (packaged)
- `@diver/backend` serves HTTP/SSE on `DIVER_PORT` and prints `DIVER_READY`
- The Tauri shell spawns exactly this entry (see `src-tauri/src/base/sidecar.rs`)

Product channels: **backend HTTP/SSE + thin Tauri invoke** — see `docs/channels.md`
at the repo root.

There is also a resident **HTTP** sidecar for in-process outer programs:
`packages/sidecar/src/companion.ts` boots the diver direct-path composition
(cos-plugins/bundle-companion) by default — or `--profile <name>` for the
generic profile form — and stays resident while `@diver/backend` serves
HTTP/SSE on `DIVER_PORT` (prints `DIVER_READY` on stdout). The Tauri shell
spawns exactly this entry (see `src-tauri/src/base/sidecar.rs`).

Production Diver release uses **bundled Node + `companion-bundle.ts`**, not
Node SEA (see repo `docs/distribution.md` and root `docs/plugins.md`).

## Bundles (profile composition)

A **bundle** is a composition layer. In the profile model it is a package whose
manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` (and
optionally a dir-style `bundle.yml` for `requires` validation). Package-style
bundles resolve two-anchor: the cos installation first, then the profile. The
in-repo mock is a **dir-style** bundle living at `bundles/bundle-mock` (a
composition dir with `cordis.patch.yml` + `bundle.yml`, not a workspace
package), applied with `--bundles @cos/bundle-mock`.

A bundle's `bundle.yml` may declare:

```yaml
bundle:
  id: cos:mock
  name: '@cos/bundle-mock'
  requires: [llm, tools]   # base rows this bundle depends on; boot validates them
```

Layer constants: `COS_OVERLAYS` env / `--overlays` both accepted; `--patch`
adds an overlay patch; `--home <path>` overrides the home patch file;
`--cos-home <path>` sets the cos home (profile mode).

## DSH ecosystem compatibility

DSH plugins are written against the `@deepseek-ai/cordis` ABI. This harness runs
the same upstream cordis version (4.0.0-rc.7), so the compatibility surface is
one npm alias: `@deepseek-ai/cordis` -> `npm:cordis@4.0.0-rc.7` (root
`package.json`). Any plugin written for the DSH ecosystem imports that name and
hooks the same typed event surface — and, because the profile manifest uses the
`dsh` section, a DSH bundle package can be dropped into a cos profile
untouched (kit: `dsh.profile.bundles`, `dsh.bundle.patch` are recognized).

### Compatibility layer (`@deepseek-ai/dsh-*` shims)

Service *call shapes* used to diverge (`defineTool` vs `tools.register`,
`agents.create/resume` vs `agentLoop.createAgent`). cos now ships drop-in
packages under the DSH names so community plugins can import unchanged:

| Import | Backing | Notes |
|---|---|---|
| `@deepseek-ai/dsh-tools` | `defineTool`, schema DSL → JSON Schema | `ctx.tools.register(definition)` accepts DSH `ToolDefinition` **and** cos `(name, executor, options)` |
| `@deepseek-ai/dsh-llm` | `@cos/llm` `LlmAdapter` + stream types | `ctx.llm.registerAdapter(providers, adapter)` |
| `@deepseek-ai/dsh-agent` | create/resume option types | `ctx.agents.create` / `ctx.agents.resume` → `agentLoop.createAgent` |
| `@deepseek-ai/dsh-session` | `@cos/types` session types | `ctx.sessions` / `ctx.sessionPersistence.prepare` |
| `@deepseek-ai/dsh-system-prompt` | `@cos/system-prompt` | `ctx.systemPrompt.section` / `.variable` |
| `@deepseek-ai/dsh-scope` | `@cos/scope` | scope carriers |

Smoke: `pnpm tsx scripts/dsh-compat-test.ts`. Sample plugin:
`examples/dsh-compat-example` (`defineTool` → dual-shape register).

**Still not 1:1:** DSH `ToolRuntime` pipeline events (`tools/pre-execute` …),
PTC presentation mode, `user-approval`, and `dsh-tauri*` host plugins. Tool
bodies that only need `defineTool` + `register` + prompt sections work as-is;
deep pipeline/UI plugins still need a port.

Verified in this repository: in diver direct-path mode the companion mounts
`@diver/memory` + `@diver/backend` + `@diver/basic-tools` from `cos-plugins/` by path with zero
changes to the harness code; the generic profile flow (reconcile +
two-anchor + install-less junctions) is covered by the compatibility suite
(`scripts/compat-test.ts`, 17/17: T1–T4 diver direct-path, T5 profile).