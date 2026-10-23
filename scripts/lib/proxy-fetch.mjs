// 代理感知的 fetch（脚本工具共用）。
//
// Node 22 的内置 fetch（undici）不读 HTTP(S)_PROXY 环境变量（NODE_USE_ENV_PROXY
// 要 Node 24+），直连 github 的下载在有墙网络里会挂死。这里显式支持代理环境
// 变量：检测到代理时经 undici ProxyAgent 发请求（undici 自带 fetch + 自建
// dispatcher，内部自洽）；无代理走原生 fetch，行为不变。

const PROXY_VARS = [
  'HTTPS_PROXY', 'https_proxy',
  'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy',
]

/** 依序探测代理环境变量；都没有返回 undefined。 */
export function proxyUrlFromEnv(env = process.env) {
  for (const key of PROXY_VARS) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return undefined
}

let undiciModules

function loadUndici() {
  undiciModules ??= import('undici')
  return undiciModules
}

/**
 * 走代理环境变量的 fetch：签名与全局 fetch 一致。
 * 有代理且 undici 不可用时告警并回退直连（降级不中断）。
 */
export async function fetchWithProxy(url, init = {}) {
  const proxy = proxyUrlFromEnv()
  if (!proxy) return fetch(url, init)
  try {
    const { fetch: undiciFetch, ProxyAgent } = await loadUndici()
    return undiciFetch(url, { ...init, dispatcher: new ProxyAgent(proxy) })
  } catch (error) {
    console.warn(`[proxy-fetch] 加载 undici 失败（${error?.message ?? error}），回退直连`)
    return fetch(url, init)
  }
}
