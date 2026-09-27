# @diver/web-tools 联网探索插件

> agent 的联网工具面：`web_search`（搜索）/ `web_read`（读页）/ `web_explore`
> （预算内搜索+读页+汇总）。纯 Node fetch 实现，**不经壳层 /rpc**；
> presence 的 Explore 执行面（记忆 `@diver/memory` 的 explore）复用本插件的引擎层。

## 工具面

| 工具 | 关键参数 | 语义 |
|---|---|---|
| `web_search` | `query` 必填；`maxResults`；`engine`(ddg\|bing)；`allowHosts`/`denyHosts` | 标题+URL+摘要（截 200 字） |
| `web_read` | `url` 必填；`outlineOnly`；`maxCharsPerPage`；hosts 过滤 | HTML→Markdown 正文；截断附 `[truncated: N chars total, showed M]` |
| `web_explore` | `term` 必填；`query`(搜索词覆盖)；`maxPages`/`maxCharsPerPage`/`maxTotalChars`；hosts 过滤 | 一次预算内：搜索→逐页读（单页失败不阻断）→汇总卡片 |

已知缺口：`web_explore` 的 `hint` 参数被接受但引擎层未实际使用（`explore.ts` 仅签名声明）。

## 预算与缺省（`policy.ts`，调用参数与 config 均按此夹紧）

| 字段 | 缺省 | 夹紧范围 |
|---|---|---|
| maxResults | 8 | 1–20 |
| maxPages | 3 | 1–8 |
| maxCharsPerPage | 6000 | 400–50,000 |
| maxTotalChars | 16000 | 800–200,000 |
| timeoutMs | 15,000ms | 2,000–60,000（不在设置 UI，仅调用参数） |
| engine | ddg | ddg（失败自动降级 bing）\| bing |
| 单页字节上限 | 1,500,000 | 固定 |

## 安全边界（`fetch.ts`）

- 仅 http/https；**私网拦截**（localhost/内网 IPv4 段/IPv6 fc,fd,fe80/link-local）；
- `denyHosts` 优先于 `allowHosts`（后缀匹配）；**重定向后对最终 URL 复检**防绕过；
- 编码：content-type charset 优先，异常兜底 utf-8。

## 实现

- 搜索（`search.ts`）：**无 API key**——ddg 走 `html.duckduckgo.com/html/` 表单
  （`kl=cn-zh`），bing 走 `/search` HTML 解析；`//duckduckgo.com/l/?uddg=` 跳转还原。
- 正文抽取（`extract.ts`）：语义标签→选择器→文本密度（text−2×link）三级找主
  内容 + 广告过滤 + Markdown 化（移植自 bladebro findMain/isAd/toMd）；过薄
  （<80 字符）退纯文本。
- 浏览器兜底（`browser.ts`）：可选 bladebro CLI（`bladebro see content --json
  --no-daemon`，`BLADEBRO_PATH` env 覆盖）；不通 CDP。
- 唯一运行时外部依赖：`node-html-parser`。

## 配置

- bundle 层（`bundle-companion/cordis.patch.yml`）：`engine: ddg, maxResults: 8,
  maxPages: 3, maxCharsPerPage: 6000, maxTotalChars: 16000`；
- 设置页（configDecl）可调：engine / maxResults / maxPages / maxCharsPerPage /
  maxTotalChars / allowHosts / denyHosts（逗号分隔）；`timeoutMs`、
  `browserFallback` 可配但不在 UI；
- 下游复用：`@diver/memory` 的 Explore 执行面 import `@diver/web-tools/policy` 与
  `@diver/web-tools/explore`（package.json 导出子路径）。

## 冒烟

- `cos-plugins/web-tools/scripts/smoke.ts`：离线逻辑冒烟（policy 夹紧/私网拦截/
  isAd/findMain/toMarkdown/预算），esbuild bundle 后 node 运行；
- `scripts/live-probe.ts`：需外网的 live 探针。
