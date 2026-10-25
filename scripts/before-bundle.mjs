// Diver 打包前垫层（tauri.conf.json beforeBundleCommand，cargo 编译后、打包前）。
//
// 一件事：确保 ~/.cache/tauri/linuxdeploy-plugin-gtk.sh 存在且带 gdk-pixbuf ≥ 2.44
// 目录守卫补丁。Arch 的 gdk-pixbuf2 2.44+ 不再落盘 loaders 目录，而插件按
// `gdk_pixbuf_binarydir` 硬拷贝，撞空即 `cp: cannot stat` 整包失败。
//  - 缓存缺失（新机 / 清过缓存）→ 从仓库内置副本恢复（scripts/assets/，上游
//    tauri-apps/linuxdeploy-plugin-gtk，MIT，已含补丁）；tauri 见文件存在即
//    不会重新下载，补丁得以存活；
//  - 缓存在但未打补丁（tauri 早期版本下载的）→ 就地幂等补丁。
//
// 其余 Linux 打包坑由别处负责：NO_STRIP（linuxdeploy 旧 strip 不认 .relr.dyn）
// 经 package.json 的 cross-env 垫片注入；patchelf 垫层与 pixbuf .pc 中转在
// bundle-release.mjs 的完整模式（pnpm bundle:release / CI）里自备。
// 用法：由 tauri build 自动调用，无需手工运行。

import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

if (process.platform !== 'linux') {
  process.exit(0)
}

const GTK_PATCH_MARK = 'local patch: gdk-pixbuf'
const GTK_PLUGIN = 'linuxdeploy-plugin-gtk.sh'

/** pixbuf 块外包目录守卫（与 scripts/assets 内置副本的补丁同形，标记防重复）。 */
function patchGtkPlugin(src) {
  const start = src.indexOf('copy_lib_tree "$gdk_pixbuf_binarydir" "$APPDIR/"')
  const endMarker = 'sed -i "s|$gdk_pixbuf_moduledir/||g" "$APPDIR/${gdk_pixbuf_cache_file/$LD_GTK_LIBRARY_PATH//usr/lib}"'
  const end = src.indexOf(endMarker)
  if (start < 0 || end < 0) {
    throw new Error(`${GTK_PLUGIN} 结构与补丁预期不符（上游更新？），请人工检查并更新 scripts/assets/${GTK_PLUGIN}`)
  }
  const block = src.slice(start, end + endMarker.length)
  return (
    src.slice(0, start)
    + `# ${GTK_PATCH_MARK}: gdk-pixbuf >= 2.44 ships no loaders dir; skip pixbuf deploy when absent\n`
    + 'if [ -d "$gdk_pixbuf_binarydir" ]; then\n'
    + block
    + '\nelse\n'
    + '    echo "WARNING: gdk-pixbuf loaders dir $gdk_pixbuf_binarydir missing; skipping pixbuf deploy"\n'
    + 'fi\n'
    + src.slice(end + endMarker.length)
  )
}

const cacheDir = join(process.env.HOME ?? '', '.cache', 'tauri')
const pluginPath = join(cacheDir, GTK_PLUGIN)
mkdirSync(cacheDir, { recursive: true })
if (!existsSync(pluginPath)) {
  copyFileSync(join(ROOT, 'scripts', 'assets', GTK_PLUGIN), pluginPath)
  chmodSync(pluginPath, 0o755)
  console.log('[before-bundle] 已从仓库内置副本恢复 ~/.cache/tauri/linuxdeploy-plugin-gtk.sh（含补丁）')
} else if (!readFileSync(pluginPath, 'utf8').includes(GTK_PATCH_MARK)) {
  writeFileSync(pluginPath, patchGtkPlugin(readFileSync(pluginPath, 'utf8')))
  console.log('[before-bundle] 已为 linuxdeploy-plugin-gtk.sh 打 gdk-pixbuf≥2.44 补丁')
} else {
  console.log('[before-bundle] linuxdeploy gtk 插件补丁已在')
}
