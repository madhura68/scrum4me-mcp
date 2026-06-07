// One-shot e2e smoke test against the live Scrum4Me database.
// Reads .env, spawns the server over stdio via tsx, calls each tool.
//
//   npx tsx scripts/smoke-test.ts
//
// Exits 0 on success, 1 on any tool failure.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(__filename), '..')

function loadEnv(): Record<string, string> {
  const file = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
  const out: Record<string, string> = {}
  for (const line of file.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
  }
  return out
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args })
  const text = (res.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
  return { isError: Boolean(res.isError), text }
}

async function main() {
  const env = { ...process.env, ...loadEnv() } as Record<string, string>
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL missing')
  if (!env.SCRUM4ME_TOKEN) throw new Error('SCRUM4ME_TOKEN missing')

  const transport = new StdioClientTransport({
    command: resolve(repoRoot, 'node_modules/.bin/tsx'),
    args: ['src/index.ts'],
    env: {
      ...env,
      TSX_TSCONFIG_PATH: resolve(repoRoot, 'tsconfig.json'),
    },
  })
  const client = new Client({ name: 'smoke-test', version: '0.0.1' })
  await client.connect(transport)

  let failed = 0
  const log = (label: string, ok: boolean, detail: string) => {
    const tag = ok ? 'PASS' : 'FAIL'
    console.log(`[${tag}] ${label}: ${detail.slice(0, 240)}${detail.length > 240 ? '…' : ''}`)
    if (!ok) failed++
  }

  // tools/list
  const tools = await client.listTools()
  log(
    'tools/list',
    tools.tools.length === 16,
    `${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(', ')}`,
  )

  // health
  const health = await callTool(client, 'health')
  log('health', !health.isError, health.text)
  const healthJson = JSON.parse(health.text)
  log('health.database', healthJson.database === 'ok', `database=${healthJson.database}`)

  // list_products
  const products = await callTool(client, 'list_products')
  log('list_products', !products.isError, products.text)
  const productList = JSON.parse(products.text) as Array<{ id: string; name: string; code: string | null }>
  log('list_products.count', productList.length > 0, `count=${productList.length}`)

  if (productList.length > 0) {
    const productId = productList[0].id
    const ctx = await callTool(client, 'get_claude_context', { product_id: productId })
    log('get_claude_context', !ctx.isError, ctx.text)
  }

  // list_open_questions (M11 — read-only, geen write nodig voor smoke-test)
  const openQs = await callTool(client, 'list_open_questions')
  log('list_open_questions', !openQs.isError, openQs.text)
  if (!openQs.isError) {
    const parsed = JSON.parse(openQs.text) as { count: number }
    log('list_open_questions.shape', typeof parsed.count === 'number', `count=${parsed.count}`)
  }

  // prompts/list
  const prompts = await client.listPrompts()
  log(
    'prompts/list',
    prompts.prompts.some((p) => p.name === 'implement_next_story'),
    `prompts: ${prompts.prompts.map((p) => p.name).join(', ')}`,
  )

  await client.close()
  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
