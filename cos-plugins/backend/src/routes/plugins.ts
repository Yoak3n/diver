// @diver/backend — 插件 / profile / native 管理端点。
// 阶段 1 通道收敛：这些操作走 backend HTTP（UI 不再 invoke）。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { broadcastLocal, readBody, sendJson } from '../http.ts'
import {
  ensureProfile,
  getProfile,
  listPlugins,
  nativeStatus,
  setProfile,
  toggleWithBroadcast,
} from '../plugins.ts'
import { installProfilePlugin, uninstallProfilePlugin } from '../plugin-install.ts'
import { COMPANION_PROFILE, gracefulExitForRestart, readActiveProfile, requestRestart } from '../paths.ts'
import type { WebHandlerDeps } from '../types.ts'

/** 命中并处理返回 true；未命中返回 false 交回分发器。 */
export async function handlePlugins(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: WebHandlerDeps,
): Promise<boolean> {
  // GET /api/plugins
  if (pathname === '/api/plugins' && req.method === 'GET') {
    const plugins = listPlugins()
    deps.state.plugins = plugins
    sendJson(res, 200, {
      activeProfile: readActiveProfile(),
      plugins,
    })
    return true
  }

  // POST /api/plugins/toggle  { id, enabled, restart? }
  if (pathname === '/api/plugins/toggle' && req.method === 'POST') {
    const body = await readBody(req)
    const id = String(body.id ?? '').trim()
    const enabled = !!body.enabled
    const restart = body.restart !== false
    if (!id) {
      sendJson(res, 400, { error: 'id 必填' })
      return true
    }
    const plugins = toggleWithBroadcast(
      id,
      enabled,
      deps.state,
      (e) => broadcastLocal(deps, e),
    )
    sendJson(res, 200, { plugins, activeProfile: readActiveProfile(), restart })
    if (restart) {
      setTimeout(() => {
        void gracefulExitForRestart()
      }, 100)
    }
    return true
  }

  // POST /api/plugins/install { spec, restart? }
  if (pathname === '/api/plugins/install' && req.method === 'POST') {
    const body = await readBody(req)
    const spec = String(body.spec ?? '').trim()
    const restart = body.restart !== false
    if (!spec) {
      sendJson(res, 400, { error: 'spec 必填' })
      return true
    }
    try {
      const plugins = await installProfilePlugin(spec, deps.state, (e) =>
        broadcastLocal(deps, e),
      )
      sendJson(res, 200, { plugins, activeProfile: readActiveProfile(), restart })
      if (restart) {
        setTimeout(() => {
          void gracefulExitForRestart()
        }, 100)
      }
    } catch (e) {
      sendJson(res, 500, { error: String((e as Error)?.message ?? e) })
    }
    return true
  }

  // POST /api/plugins/uninstall { id, restart? }
  if (pathname === '/api/plugins/uninstall' && req.method === 'POST') {
    const body = await readBody(req)
    const id = String(body.id ?? '').trim()
    const restart = body.restart !== false
    if (!id) {
      sendJson(res, 400, { error: 'id 必填' })
      return true
    }
    try {
      const plugins = await uninstallProfilePlugin(id, deps.state, (e) =>
        broadcastLocal(deps, e),
      )
      sendJson(res, 200, { plugins, activeProfile: readActiveProfile(), restart })
      if (restart) {
        setTimeout(() => {
          void gracefulExitForRestart()
        }, 100)
      }
    } catch (e) {
      sendJson(res, 500, { error: String((e as Error)?.message ?? e) })
    }
    return true
  }

  // GET /api/plugins/config —— 插件配置读面（延迟加载 plugin-config，含 yaml 等重依赖）
  if (pathname === '/api/plugins/config' && req.method === 'GET') {
    const { listPluginConfigs } = await import('../plugin-config.ts')
    sendJson(res, 200, { plugins: await listPluginConfigs() })
    return true
  }

  if (pathname === '/api/plugins/config' && req.method === 'POST') {
    const body = await readBody(req)
    if (typeof body.id !== 'string' || body.id === '') {
      sendJson(res, 400, { error: 'id is required' })
      return true
    }
    const { savePluginConfig } = await import('../plugin-config.ts')
    const result = await savePluginConfig(body.id, body.values ?? {})
    requestRestart()
    sendJson(res, 200, result)
    return true
  }

  // GET /api/profile
  if (pathname === '/api/profile' && req.method === 'GET') {
    sendJson(res, 200, await getProfile())
    return true
  }

  // POST /api/profile { profile: companion|safe, restart? }
  if (pathname === '/api/profile' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const result = await setProfile(String(body.profile ?? COMPANION_PROFILE))
      ensureProfile()
      sendJson(res, 200, { ...result, restart: body.restart !== false })
      if (body.restart !== false) {
        setTimeout(() => {
          void gracefulExitForRestart()
        }, 100)
      }
    } catch (e) {
      sendJson(res, 400, { error: String((e as Error)?.message ?? e) })
    }
    return true
  }

  // GET /api/native/status
  if (pathname === '/api/native/status' && req.method === 'GET') {
    sendJson(res, 200, await nativeStatus())
    return true
  }

  return false
}
