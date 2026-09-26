// 测量 vite dev 冷启动下「整个前端模块图」的加载总耗时（复现白屏期）。
// 用法：vite 启动后立即 `node scripts/dev-graph-crawl.mjs`，输出总耗时 + 最慢模块。
const base = process.env.CRAWL_BASE ?? "http://localhost:1420";
const seen = new Set();
const times = [];
let inflight = 0;
const queue = ["/"];

function importsOf(text, url) {
  const out = [];
  const re =
    /(?:import|export)[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|(?:^|;|\s)import\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] || m[2] || m[3]);
  if (url.endsWith("/") || url.includes(".html")) {
    const tagRe = /<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/g;
    while ((m = tagRe.exec(text))) out.push(m[1]);
  }
  return out;
}

function normalize(spec, fromUrl) {
  if (!spec) return null;
  if (spec.startsWith("data:") || spec.startsWith("http")) return null;
  if (spec.startsWith(".")) {
    const u = new URL(spec, base + fromUrl);
    return u.pathname + u.search;
  }
  if (spec.startsWith("/")) return spec;
  return null; // bare specifier: vite 已在转换结果中改写成 /node_modules/... 形式
}

const t0 = Date.now();

async function worker() {
  while (queue.length > 0 || inflight > 0) {
    const url = queue.shift();
    if (!url) {
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    inflight++;
    const s = Date.now();
    try {
      const res = await fetch(base + url);
      const text = await res.text();
      times.push([Date.now() - s, url, res.status]);
      if ((res.headers.get("content-type") || "").includes("javascript") || url.endsWith("/") || url.includes(".html")) {
        for (const spec of importsOf(text, url)) {
          const n = normalize(spec, url);
          if (n && !seen.has(n)) queue.push(n);
        }
      }
    } catch (e) {
      times.push([Date.now() - s, url, "ERR " + e.message]);
    }
    inflight--;
  }
}

await Promise.all(Array.from({ length: 8 }, worker));
const total = Date.now() - t0;
times.sort((a, b) => b[0] - a[0]);
console.log(`TOTAL ${total} ms, ${times.length} URLs`);
for (const [ms, u, st] of times.slice(0, 25)) console.log(`${String(ms).padStart(6)} ms  [${st}]  ${u}`);
