/**
 * HTML → 可读 Markdown 抽取（公共出口）。
 *
 * 算法移植自 bladebro `page/perception.rs` 的 `findMain` / `isAd` / `toMd`
 * （E:\GitVault\bladebro），语义对齐 `see mode=content`：
 * - 主内容：semantic main/article → 常见内容选择器 → 文本密度（text − 2×link）
 * - 去噪：SKIP/NOISE 标签、广告 class/id/data-*、hidden
 * - 块级转 Markdown：标题 / 段落 / 链接 / 列表 / code / 引用 / 表格
 *
 * 与 bladebro 的差异：无 live DOM（用 node-html-parser 解析静态 HTML），
 * `innerText` 以 `textContent` 近似；站点特化（商品/Reddit/GitHub）v1 不做，
 * Explore 以通用正文为主，更可控。
 *
 * 分层：extract-dom.ts 节点工具 | extract-noise.ts 去噪判定与兜底
 * | extract-main.ts 主内容定位 | extract-markdown.ts 块级转 MD
 * | extract-page.ts 页面入口；本文件只做公共 re-export。
 */

export * from './extract-dom.ts'
export * from './extract-main.ts'
export * from './extract-markdown.ts'
export * from './extract-noise.ts'
export * from './extract-page.ts'
