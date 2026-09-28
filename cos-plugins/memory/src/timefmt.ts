// @diver/memory — 时间展示纯函数（注入文案 / 工具结果共用）。
// 纯函数无 IO，独立可测。

/** 相对日期文案：今天 / 昨天 / N天前 / N周前 / N个月前。 */
export function humanWhen(ts: number) {
  const now = Date.now()
  const diff = now - ts
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return '今天'
  if (diff < 2 * day) return '昨天'
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}周前`
  return `${Math.floor(diff / (30 * day))}个月前`
}

/** 时:分（两位补零）。 */
export function timeHm(ts: number) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
