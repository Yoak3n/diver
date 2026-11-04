// Diver 打包前垫层（tauri.conf.json beforeBundleCommand，cargo 编译后、打包前）。
//
// 两件事，都落在 ~/.cache/tauri/linuxdeploy-plugin-gtk.sh 的幂等补丁上
// （标记防重复，缓存缺失则从 scripts/assets/ 内置副本恢复；tauri 见文件存在
// 即不会重新下载，补丁得以存活）：
//  1. gdk-pixbuf ≥ 2.44 目录守卫：Arch 的 gdk-pixbuf2 2.44+ 不再落盘 loaders
//     目录，而插件按 `gdk_pixbuf_binarydir` 硬拷贝，撞空即 `cp: cannot stat`
//     整包失败。
//  2. IME：内置 immodules.cache 只含 GTK 自带 IM 模块，hook 又把
//     GTK_IM_MODULE_FILE 钉死在它上面，且 GDK_BACKEND=x11 下 GTK 只认
//     GTK_IM_MODULE —— 三者叠加导致打包产物里输入法（fcitx5/ibus）无法切换。
//     补丁把缓存选择改为「系统优先、内置兜底」，并从 XMODIFIERS 推导
//     GTK_IM_MODULE。
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
const GTK_IME_MARK = 'local patch: prefer system IM modules'
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

// GTK3 heredoc 里被无条件 export 的那一行（$ 与 ${gtk3_*} 均在构建期展开）
const GTK3_IME_ANCHOR = 'export GTK_IM_MODULE_FILE="\\$APPDIR/${gtk3_immodules_cache_file/$LD_GTK_LIBRARY_PATH//usr/lib}"'

/** IME 补丁：内置缓存只含 GTK 自带 IM 模块，把 GTK_IM_MODULE_FILE 改为
 *  优先系统 immodules.cache（fcitx5/ibus 模块在那里），并从 XMODIFIERS 推导
 *  GTK_IM_MODULE。背景：GDK_BACKEND=x11（防 WebKitGTK Wayland 崩溃，tauri#8541）
 *  下 GTK 只认 GTK_IM_MODULE，会话设空串即落 "simple" 上下文，打包产物里
 *  输入法无法切换（与 scripts/assets 内置副本的补丁同形，标记防重复）。 */
function patchGtkIme(src) {
  const start = src.indexOf(GTK3_IME_ANCHOR)
  if (start < 0) {
    throw new Error(`${GTK_PLUGIN} 结构与 IME 补丁预期不符（上游更新？），请人工检查并更新 scripts/assets/${GTK_PLUGIN}`)
  }
  return (
    src.slice(0, start)
    + [
      `# ${GTK_IME_MARK}: AppImage 只内置 GTK 自带 IM 模块，优先系统 immodules.cache`,
      '_system_immodules_cache=""',
      'for _c in /usr/lib/gtk-3.0/3.0.0/immodules.cache /usr/lib/x86_64-linux-gnu/gtk-3.0/3.0.0/immodules.cache /usr/lib/aarch64-linux-gnu/gtk-3.0/3.0.0/immodules.cache; do',
      '    if [ -f "\\$_c" ]; then _system_immodules_cache="\\$_c"; break; fi',
      'done',
      'if [ -n "\\$_system_immodules_cache" ]; then',
      '    export GTK_IM_MODULE_FILE="\\$_system_immodules_cache"',
      'else',
      `    ${GTK3_IME_ANCHOR}`,
      'fi',
      '# 只留 XIM 风格变量（XMODIFIERS=@im=fcitx）的会话，给 GTK 推一个 IM 模块',
      'if [ -z "\\$GTK_IM_MODULE" ] && [ -n "\\$XMODIFIERS" ]; then',
      '    export GTK_IM_MODULE="\\${XMODIFIERS#*@im=}"',
      'fi',
    ].join('\n')
    + src.slice(start + GTK3_IME_ANCHOR.length)
  )
}

const cacheDir = join(process.env.HOME ?? '', '.cache', 'tauri')
const pluginPath = join(cacheDir, GTK_PLUGIN)
mkdirSync(cacheDir, { recursive: true })
if (!existsSync(pluginPath)) {
  copyFileSync(join(ROOT, 'scripts', 'assets', GTK_PLUGIN), pluginPath)
  chmodSync(pluginPath, 0o755)
  console.log('[before-bundle] 已从仓库内置副本恢复 ~/.cache/tauri/linuxdeploy-plugin-gtk.sh（含补丁）')
} else {
  let src = readFileSync(pluginPath, 'utf8')
  let patched = false
  if (!src.includes(GTK_PATCH_MARK)) {
    src = patchGtkPlugin(src)
    patched = true
    console.log('[before-bundle] 已为 linuxdeploy-plugin-gtk.sh 打 gdk-pixbuf≥2.44 补丁')
  }
  if (!src.includes(GTK_IME_MARK)) {
    src = patchGtkIme(src)
    patched = true
    console.log('[before-bundle] 已为 linuxdeploy-plugin-gtk.sh 打 IME 补丁（优先系统 immodules.cache）')
  }
  if (patched) {
    writeFileSync(pluginPath, src)
  } else {
    console.log('[before-bundle] linuxdeploy gtk 插件补丁已在')
  }
}
