// Diver 本地启动器安装（一次性；pnpm setup:local）。
//
// tauri 没有打包后钩子，构建期自动注册做不了「成功后刷新」；改用稳定间接层：
// desktop 入口指向 ~/Applications/diver-launch，启动器每次运行时从构建产物目录
// 挑**最新**的 Diver_*_amd64.AppImage——`pnpm tauri build` 出新版本后无需任何
// 注册动作，菜单点开即最新。本脚本只需在换新机/清过 home 后重跑，幂等。
//
// 用法：pnpm setup:local

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOME = process.env.HOME ?? ''
if (HOME === '' || process.platform !== 'linux') {
  console.log('[setup:local] 仅支持 Linux 本机，跳过')
  process.exit(0)
}

const bundleDir = join(ROOT, 'target', 'release', 'bundle', 'appimage')

// 1. 启动器：始终运行产物目录里最新的 AppImage
const appsDir = join(HOME, 'Applications')
mkdirSync(appsDir, { recursive: true })
const launcher = join(appsDir, 'diver-launch')
writeFileSync(launcher, `#!/bin/sh
# 由 scripts/install-local-launcher.mjs 生成：运行最新的 Diver AppImage
img=$(ls -t ${bundleDir}/Diver_*_amd64.AppImage 2>/dev/null | head -n1)
if [ -z "$img" ]; then
  echo "未找到已构建的 Diver AppImage（先在仓库跑 pnpm tauri build）" >&2
  exit 1
fi
exec "$img" "$@"
`, { mode: 0o755 })
console.log(`[setup:local] 启动器 → ${launcher}`)

// 2. desktop 入口（Exec 指向启动器，构建后无需再动）
const desktopDir = join(HOME, '.local', 'share', 'applications')
mkdirSync(desktopDir, { recursive: true })
writeFileSync(join(desktopDir, 'diver.desktop'), `[Desktop Entry]
Type=Application
Name=Diver
Comment=Diver 桌面陪伴 Agent
Exec=${launcher}
Icon=diver
Terminal=false
Categories=Utility;
StartupWMClass=diver
StartupNotify=true
`)

// 3. hicolor 图标（缺源文件的档位跳过）
const iconMap = [
  ['32x32.png', '32x32'],
  ['64x64.png', '64x64'],
  ['128x128.png', '128x128'],
  ['128x128@2x.png', '256x256@2'],
  ['icon.png', '512x512'],
]
for (const [srcName, dir] of iconMap) {
  const src = join(ROOT, 'src-tauri', 'icons', srcName)
  if (!existsSync(src)) continue
  const dst = join(HOME, '.local', 'share', 'icons', 'hicolor', dir, 'apps', 'diver.png')
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
}
for (const cmd of [
  'update-desktop-database ~/.local/share/applications',
  'gtk-update-icon-cache -f ~/.local/share/icons/hicolor',
]) {
  try {
    execFileSync(cmd, { stdio: 'ignore', shell: true })
  } catch { /* 缓存刷新失败不影响使用 */ }
}
console.log('[setup:local] 完成：应用菜单搜索 Diver 即可启动（总是最新构建）')
