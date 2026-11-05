// @diver/backend — B 站扫码登录（只读账号）。
//
// 只把 SESSDATA 写进 $COS_HOME/curiosity/bilibili-auth.json（0600），
// 响应里永远不回传 token；不保存 bili_jct，不提供任何写接口。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { toDataURL } from 'qrcode'

import {
  clearBilibiliAuth,
  fetchLoginProfile,
  pollQrLogin,
  readBilibiliAuth,
  requestQrLogin,
  writeBilibiliAuth,
} from '@diver/memory/curiosity-bilibili-auth'

import { sendJson } from '../http.ts'
import { cosHome } from '../paths.ts'
import type { WebHandlerDeps } from '../types.ts'

export async function handleBilibili(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  _deps: WebHandlerDeps,
): Promise<boolean> {
  if (pathname === '/api/bilibili/status' && req.method === 'GET') {
    const auth = readBilibiliAuth(cosHome())
    if (auth === null) {
      sendJson(res, 200, { loggedIn: false })
      return true
    }
    const profile = await fetchLoginProfile(auth)
    sendJson(res, 200, {
      loggedIn: profile.loggedIn,
      ...(profile.expired === true ? { expired: true } : {}),
      ...(profile.name === undefined ? {} : { name: profile.name }),
      ...(profile.mid === undefined ? {} : { mid: profile.mid }),
    })
    return true
  }

  if (pathname === '/api/bilibili/login/qrcode' && req.method === 'POST') {
    try {
      const qr = await requestQrLogin()
      const qrDataUrl = await toDataURL(qr.url, { margin: 1, width: 240 })
      sendJson(res, 200, { key: qr.key, qrDataUrl, expiresIn: 180 })
    } catch (err) {
      sendJson(res, 502, { error: String((err as Error)?.message ?? err) })
    }
    return true
  }

  if (pathname === '/api/bilibili/login/poll' && req.method === 'GET') {
    const key = new URL(req.url ?? '', 'http://x').searchParams.get('key') ?? ''
    if (key === '') {
      sendJson(res, 400, { error: 'key 必填' })
      return true
    }
    try {
      const result = await pollQrLogin(key)
      if (result.status !== 'confirmed' || result.auth === undefined) {
        sendJson(res, 200, {
          status: result.status,
          loggedIn: false,
          ...(result.message === undefined ? {} : { message: result.message }),
        })
        return true
      }
      writeBilibiliAuth(cosHome(), result.auth)
      const profile = await fetchLoginProfile(result.auth)
      sendJson(res, 200, {
        status: 'confirmed',
        loggedIn: true,
        ...(profile.name === undefined ? {} : { name: profile.name }),
        ...(profile.mid === undefined ? {} : { mid: profile.mid }),
      })
    } catch (err) {
      sendJson(res, 502, { status: 'error', error: String((err as Error)?.message ?? err) })
    }
    return true
  }

  if (pathname === '/api/bilibili/logout' && req.method === 'POST') {
    clearBilibiliAuth(cosHome())
    sendJson(res, 200, { ok: true, loggedIn: false })
    return true
  }

  return false
}
