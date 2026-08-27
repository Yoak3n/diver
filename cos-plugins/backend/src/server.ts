// @diver/backend — HTTP 传输层装配（thin）：仅负责创建/监听/释放 server，
// 路由语义全部委托给 handlers.ts。

import { createServer } from 'node:http'
import type { Context } from 'cordis'

import { handleRequest } from './handlers.ts'
import type { WebHandlerDeps } from './types.ts'

export function mountServer(ctx: Context, deps: WebHandlerDeps) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${deps.port}`)
    void handleRequest(req, res, url, deps)
  })

  server.on('error', (err) => {
    console.error(`[diver] HTTP 服务错误: ${err.message}`)
  })

  server.listen(deps.port, '127.0.0.1', () => {
    const addr = server.address()
    const actual = typeof addr === 'object' && addr ? addr.port : deps.port
    console.log(`[diver] companion backend listening on 127.0.0.1:${actual}`)
    console.log(`DIVER_READY http://127.0.0.1:${actual}`)
  })

  ctx.effect(() => () => {
    for (const client of [...deps.state.clients]) client.end()
    deps.state.clients.clear()
    server.close()
  }, 'backend:server')
}