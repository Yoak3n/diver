/**
 * @diver/native-bridge — internal plug-in slot for Rust-native capabilities.
 *
 * Role (P5):
 * - Own the shared HTTP RPC client for the Tauri shell (`nativeRpc`).
 * - Register `native_status` so the agent/UI can probe shell services.
 * - Be the **only** designated mount point for future native tools that are
 *   not domain plugins (memory/grep stay in their own packages but MUST use
 *   this RPC client).
 *
 * Extension checklist (docs/plugins.md §P5):
 * 1. Rust: add `/rpc` method under `src-tauri/src/services/`
 * 2. Document the method in `NATIVE_RPC_METHODS`
 * 3. Expose tools/services here (or `@diver/native-<name>` internal) using `nativeRpc`
 * 4. Mount via `@diver/bundle-companion` insert + `plugins.json` catalog
 * 5. Add a smoke script under `scripts/`
 *
 * @module @diver/native-bridge
 */

import type { Context } from 'cordis'
import type {} from '@cos/plugin-api'
import { NATIVE_RPC_METHODS, nativeRpcConfigured, nativeRpcUrl, probeNativeRpc } from './rpc.ts'

export const name = 'native-bridge'

export const inject = ['tools']

export * from './rpc.ts'

export function apply(ctx: Context) {
  ctx.tools.register(
    'native_status',
    async () => {
      const url = nativeRpcUrl()
      if (url === null) {
        return {
          content: JSON.stringify(
            {
              configured: false,
              url: null,
              methods: NATIVE_RPC_METHODS,
              probes: [],
              hint: '设置 DIVER_MEMORY_PORT（Tauri 壳启动 sidecar 时注入）后可探测原生服务',
            },
            null,
            2,
          ),
        }
      }
      const probes = []
      for (const entry of NATIVE_RPC_METHODS) {
        if (entry.probeSafe === false) {
          probes.push({
            method: entry.method,
            ok: true,
            detail: 'skipped (side effect; see notify::ping)',
          })
          continue
        }
        const params =
          entry.method === 'grep::search'
            ? { pattern: '__diver_native_probe__', path: '.', maxMatches: 1 }
            : {}
        probes.push(await probeNativeRpc(entry.method, params))
      }
      return {
        content: JSON.stringify(
          {
            configured: true,
            url,
            methods: NATIVE_RPC_METHODS,
            probes,
          },
          null,
          2,
        ),
      }
    },
    {
      description:
        '探测 Rust 壳本地 RPC（记忆 / grep 等原生服务）是否可达；扩展原生能力时用于联调。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  )

  console.log(
    `[native-bridge] ready — rpc=${nativeRpcUrl() ?? 'unset'} configured=${nativeRpcConfigured()}`,
  )
}
