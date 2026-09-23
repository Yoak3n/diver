// Live probe: web_search + extract on a real page (network required).
import { DEFAULT_POLICY, resolvePolicy } from '../src/policy.ts'
import { webSearch, formatSearchHits } from '../src/search.ts'
import { fetchPage } from '../src/fetch.ts'
import { extractContent } from '../src/extract.ts'
import { exploreTerm } from '../src/explore.ts'

const policy = resolvePolicy(DEFAULT_POLICY, { maxResults: 3, maxPages: 2, maxCharsPerPage: 1500, maxTotalChars: 4000 })

async function main() {
  console.log('--- web_search ---')
  try {
    const hits = await webSearch('MXene 材料', policy)
    console.log(formatSearchHits(hits))
  } catch (e) {
    console.log('search failed:', (e as Error).message)
  }

  console.log('\n--- web_read example.com ---')
  try {
    const page = await fetchPage('https://example.com/', policy)
    const md = extractContent(page.body, 800)
    console.log('title:', md.title)
    console.log(md.markdown.slice(0, 400))
  } catch (e) {
    console.log('read failed:', (e as Error).message)
  }

  console.log('\n--- web_explore ---')
  try {
    const result = await exploreTerm('MXene', policy)
    console.log(result.summary.slice(0, 1200))
    console.log('... totalChars', result.totalChars, 'pages', result.pages.length)
  } catch (e) {
    console.log('explore failed:', (e as Error).message)
  }
}

await main()
