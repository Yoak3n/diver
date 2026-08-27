// Temp SEA smoke: keep stdin open, probe the profile-mount HTTP server.
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const exe = join(process.cwd(), 'dist', 'cos-sidecar.exe')
const child = spawn(exe, ['--bundles', '../cos-plugins/bundle-companion', '--plugin-root', '../cos-plugins'], {
  cwd: process.cwd(),
  env: { ...process.env, DIVER_PORT: '53620' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => { out += d.toString() })
child.stderr.on('data', (d) => { out += d.toString() })

await new Promise((r) => setTimeout(r, 9000))
try {
  const res = await fetch('http://127.0.0.1:53620/api/health')
  const body = await res.text()
  console.log(`HTTP ${res.status} ${body.slice(0, 160)}`)
} catch (err) {
  console.log(`health FAIL: ${err.message}`)
}
child.stdin.end()
await new Promise((r) => setTimeout(r, 500))
child.kill()
const code = await new Promise((r) => child.on('exit', r))
console.log(`exit=${code}`)
console.log('--- boot logs ---')
console.log(out.slice(0, 1600))