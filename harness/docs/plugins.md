# Plugins & Layered Composition

This document is about how third-party plugins join the harness and how layers
compose — the two halves of delivering `cos` as a sidecar to an outer program.

## Diver direct-path mode (this repo's default)

In the diver project the third-party plugins ARE this repo's own
`cos-plugins/` sources, so they are resolved **by path** — no profile install,
no harness dependency changes. The companion entry
(`packages/sidecar/src/companion.ts`) locates the repo root from its own module
position and boots:

- bundle: `cos-plugins/bundle-companion` (a bundle **path**, read for its
  `cordis.patch.yml` / `bundle.yml` / `dsh.bundle.patch`);
- plugin rows: `@diver/memory` / `@diver/backend` resolve by `pluginPaths`
  (explicit map) or `pluginRoot` (a directory where a row's unscoped package
  resolves, e.g. `--plugin-root ../cos-plugins`).

So `pnpm start:companion` (or the Tauri shell spawning
`packages/sidecar/src/companion.ts`) works with zero setup: editing
`cos-plugins/` takes effect on restart. `--bundles <spec>` / `--profile
<name>` / `--plugin-root <dir>` override or complement the defaults — this is
also how the SEA binary is driven at runtime (`dist/cos-sidecar.exe --bundles
../cos-plugins/bundle-companion --plugin-root ../cos-plugins`; and baked at
build via `scripts/build-sea.mjs --bundle ... --plugin-root ...`).

## Profile model (generic DSH-aligned form, optional)

Every boot is either a **flat** (installation-level) tree or a **profile** tree.
Profiles are the generic way third-party plugins join (other cos consumers that
pull diver bundles from a registry): a profile is a directory under
`<home>/profiles/<name>` holding its own `package.json` (out-of-tree plugin
dependencies plus the profile manifest `dsh.profile` with its ordered `bundles`
list), a `node_modules` pnpm manages for those plugins, and a
`cordis.patch.yml` (the profile's own user patch layer, applied after every
bundle layer).

- The cos home resolves `COS_HOME`, then `DSH_HOME`, then `~/.cos`. This repo's
  shell drives `DSH_HOME=<repo>/harness/.dsh-home` (see
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

## Sidecar consumption

The harness ships as an independent process: `@cos/sidecar/server` boots the
same composed tree and serves newline-delimited JSON-RPC over stdin/stdout
(`--profile <name>` selects a profile tree; `--cos-home` overrides the home).
An outer program spawns it and drives agents without importing this codebase:

```ts
import { SidecarClient } from '@cos/sidecar/client'

const client = new SidecarClient({ cwd: process.cwd(), configPath: 'cordis.yml', args: ['--profile', 'companion'] })
await client.ready                                   // handshake
await client.request('agent.create', { sessionId: 'ext-1', agentOptions: { provider: 'deepseek-official' } })
...
client.dispose()
```

Methods: `ping` / `system.listProviders` / `agent.create` / `agent.followup` /
`agent.whenIdle` / `agent.status` / `session.events`. Logs go to stderr; stdout
carries protocol lines only.

There is also a resident **HTTP** sidecar for in-process outer programs:
`packages/sidecar/src/companion.ts` boots the diver direct-path composition
(cos-plugins/bundle-companion) by default — or `--profile <name>` for the
generic profile form — and stays resident while `@diver/backend` serves
HTTP/SSE on `DIVER_PORT` (prints `DIVER_READY` on stdout). The Tauri shell
spawns exactly this entry (see `src-tauri/src/base/sidecar.rs`).

The sidecar can also be compiled into a single-file Node SEA. See
`scripts/build-sea.mjs`: 1) esbuild bundles `@cos/sidecar/sea` — which supplies
`packages/sidecar/src/plugins.ts` as the loader's in-process plugin registry
and disables source watching — plus, with `--profile <name>`, the profile's
third-party plugins baked into the same module graph; 2) `node
--experimental-sea-config` produces the blob; 3) postject injects it into the
binary.

> **SEA + third-party plugins**: the SEA runtime (embedded CJS) cannot
> type-strip TypeScript under `node_modules`
> (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so profile plugins cannot be
> `import()`'d at runtime. `pnpm build:sea --bundle ../cos-plugins/bundle-companion
> --plugin-root ../cos-plugins` (diver) — or `--profile <name>` (generic) —
> compiles the plugin packages with esbuild and
> registers them in the in-process registry — the profile's bundle **layers**
> are still read from disk at runtime, so mounting follows the profile; adding
> a new plugin package requires a rebuild.

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

Verified in this repository: in diver direct-path mode the companion mounts
`@diver/memory` + `@diver/backend` from `cos-plugins/` by path with zero
changes to the harness code; the generic profile flow (reconcile +
two-anchor + install-less junctions) is covered by the compatibility suite
(`scripts/compat-test.ts`, 17/17: T1–T4 diver direct-path, T5 profile).