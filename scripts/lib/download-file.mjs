// 脚本共用下载助手：代理感知 + MB 级进度输出。
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { fetchWithProxy } from './proxy-fetch.mjs'

/**
 * 下载 url 到 dest（覆盖），每跨 1MB 打一行进度。
 * 大文件经代理可能只有几十 KB/s，无进度的静默挂住极像卡死——必须可见。
 */
export async function downloadTo(url, dest, label = '[download]') {
  const res = await fetchWithProxy(url)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  let bytes = 0
  let lastMb = 0
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length
      const mb = Math.floor(bytes / 1048576)
      if (mb > lastMb) {
        lastMb = mb
        console.log(`${label} 已下载 ${mb} MB…`)
      }
      cb(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body), progress, createWriteStream(dest))
  return bytes
}
