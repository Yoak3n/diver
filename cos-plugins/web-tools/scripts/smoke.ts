// @diver/web-tools — 纯逻辑冒烟（extract / policy / search 解析；不依赖外网）。
//
// 构建（在 harness 目录）：
//   node_modules/.bin/esbuild.cmd ../cos-plugins/web-tools/scripts/smoke.ts --bundle --platform=node --format=esm --tsconfig=../cos-plugins/web-tools/tsconfig.json --outfile=web-tools-smoke.bundle.mjs
// 运行：
//   node web-tools-smoke.bundle.mjs

import { extractContent, extractOutline, findMain, isAd, toMarkdown } from '../src/extract.ts'
import { DEFAULT_POLICY, resolvePolicy, WebError } from '../src/policy.ts'
import { resolveHttpUrl } from '../src/fetch.ts'
import { parse } from 'node-html-parser'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ok  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name} ${detail}`)
  }
}

// ── policy ──────────────────────────────────────────────────────────
const p1 = resolvePolicy(DEFAULT_POLICY, { maxPages: 99, maxResults: 0, allowHosts: 'Example.COM, foo.bar' })
check('policy clamps maxPages', p1.maxPages === 8, String(p1.maxPages))
check('policy clamps maxResults min 1', p1.maxResults === 1, String(p1.maxResults))
check('policy normalizes allowHosts', p1.allowHosts.join(',') === 'example.com,foo.bar', p1.allowHosts.join(','))

let blocked = false
try {
  resolveHttpUrl('http://127.0.0.1/x', DEFAULT_POLICY)
} catch (e) {
  blocked = e instanceof WebError && e.code === 'BLOCKED_HOST'
}
check('blocks loopback', blocked)

blocked = false
try {
  resolveHttpUrl('file:///etc/passwd', DEFAULT_POLICY)
} catch (e) {
  blocked = e instanceof WebError && e.code === 'UNSUPPORTED_SCHEME'
}
check('blocks file scheme', blocked)

blocked = false
try {
  resolveHttpUrl('https://evil.example/', resolvePolicy(DEFAULT_POLICY, { allowHosts: ['ok.test'] }))
} catch (e) {
  blocked = e instanceof WebError && e.code === 'BLOCKED_HOST'
}
check('enforces allowHosts', blocked)

// ── isAd / findMain / toMarkdown ────────────────────────────────────
const html = `<!doctype html><html><head><title>测试文章 · Demo</title></head><body>
  <nav><a href="/">Home</a></nav>
  <div class="ad-banner sponsored">BUY NOW</div>
  <main>
    <h1>主标题</h1>
    <p>第一段，介绍 <a href="https://example.com/ref">链接</a> 与 <strong>重点</strong>。</p>
    <ul><li>要点一</li><li>要点二</li></ul>
    <pre><code>const x = 1</code></pre>
    <table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>
    <p>${'正文填充。'.repeat(80)}</p>
  </main>
  <footer>© demo</footer>
</body></html>`

const doc = parse(html)
const ad = doc.querySelector('.ad-banner')
check('isAd hits sponsored', ad != null && isAd(ad))
const nav = doc.querySelector('nav')
check('noise nav not main', nav != null)

const main = findMain(doc)
check('findMain picks main', (main.tagName ?? '').toLowerCase() === 'main' || innerHasTitle(main), main.tagName)

const md = toMarkdown(main, 500)
check('toMarkdown has h1', md.includes('# 主标题'), md.slice(0, 80))
check('toMarkdown has link', md.includes('[链接](https://example.com/ref)'), md.slice(0, 200))
check('toMarkdown has list', md.includes('- 要点一'), md.slice(0, 300))
check('toMarkdown has code fence', md.includes('```'), md.slice(0, 400))
check('toMarkdown budget', md.length <= 500, String(md.length))
check('toMarkdown drops ad', !md.includes('BUY NOW'))

const extracted = extractContent(html, 200)
check('extractContent title', extracted.title.includes('测试文章'), extracted.title)
check('extractContent truncated flag', extracted.truncated === true || extracted.fullLength <= 200)

const outline = extractOutline(html)
check('outline has heading', outline.includes('主标题'), outline.slice(0, 80))

// density fallback: no main/article
const weak = `<!doctype html><html><head><title>W</title></head><body>
  <div class="wrap">${'词。'.repeat(120)}<a href="/x">很短</a></div>
  <div class="links"><a href="/a">A</a><a href="/b">B</a></div>
</body></html>`
const weakMain = findMain(parse(weak))
check('density fallback returns body-ish', weakMain != null)

function innerHasTitle(el: { textContent?: string }): boolean {
  return (el.textContent ?? '').includes('主标题')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
