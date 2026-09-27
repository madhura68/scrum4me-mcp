import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const dsn = process.env.TOKEN_USAGE_TEST_URL
const describeDb = dsn ? describe : describe.skip
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describeDb('real MCP transport success boundary (explicit disposable DB)', () => {
  let pool: Pool
  const suffix = randomUUID()
  const uid = `usage-user-${suffix}`
  const pid = `usage-product-${suffix}`
  const raw = `synthetic-usage-${suffix}`
  const revoked = `synthetic-revoked-${suffix}`
  const children: ChildProcess[] = []
  const clients: Client[] = []
  const stdios: StdioClientTransport[] = []
  let httpUrl: URL
  let httpOutput = ''
  const env = () => ({ PATH: process.env.PATH ?? '', DATABASE_URL: dsn!, SCRUM4ME_TOKEN: raw,
    S4M_SERVER: 'mac', S4M_MODEL: 'codex', NODE_ENV: 'test' })
  const count = (text: string) => text.split('\n').filter(line => line.startsWith('USAGE_SPY:')).length
  async function stdio(token = raw, mode = 'stdio') {
    let output = ''
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', '__tests__/fixtures/token-usage-server.ts', mode], env: { ...env(), SCRUM4ME_TOKEN: token }, stderr: 'pipe' })
    stdios.push(transport)
    transport.stderr?.on('data', chunk => { output += String(chunk) })
    const client = new Client({ name: 'usage-probe', version: '1' })
    clients.push(client)
    await client.connect(transport)
    return { client, writes: () => count(output) }
  }
  async function http(token = raw) {
    const client = new Client({ name: 'usage-probe', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(httpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    return client
  }
  beforeAll(async () => {
    const target = new URL(dsn!)
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/s4m_dispatch_test') throw new Error('TEST_TARGET_REFUSED')
    pool = new Pool({ connectionString: dsn, max: 2 })
    const cluster = await pool.query("SELECT 1 FROM pg_database WHERE datname = 'scrum4me'")
    if (cluster.rowCount) throw new Error('PRODUCTION_CLUSTER_REFUSED')
    await pool.query('INSERT INTO users(id,username,password_hash,updated_at) VALUES($1,$1,$2,now())', [uid, 'synthetic-not-a-password'])
    await pool.query('INSERT INTO products(id,user_id,name,definition_of_done,updated_at) VALUES($1,$2,$3,$4,now())', [pid, uid, 'Usage probe', 'Test only'])
    for (const [token, dead] of [[raw, false], [revoked, true]] as const) {
      await pool.query('INSERT INTO api_tokens(id,user_id,token_hash,revoked_at) VALUES($1,$2,$3,$4)', [token, uid, createHash('sha256').update(token).digest('hex'), dead ? new Date() : null])
    }
    const child = spawn(process.execPath, ['--import', 'tsx', '__tests__/fixtures/token-usage-server.ts', 'http'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    child.stderr!.on('data', chunk => { httpOutput += String(chunk) })
    child.stdout!.resume()
    for (let i = 0; i < 200 && !/READY:\d+/.test(httpOutput); i++) await pause(25)
    const match = /READY:(\d+)/.exec(httpOutput)
    if (!match) throw new Error('HTTP probe failed to start: ' + httpOutput.slice(-1000))
    httpUrl = new URL(`http://127.0.0.1:${match[1]}/mcp`)
  }, 15000)
  afterAll(async () => {
    await Promise.all(clients.map(client => client.close().catch(() => {})))
    await Promise.all(stdios.map(transport => transport.close().catch(() => {})))
    for (const child of children) child.kill('SIGTERM')
    if (pool) {
      await pool.query('DELETE FROM products WHERE id=$1', [pid])
      await pool.query('DELETE FROM users WHERE id=$1', [uid])
      await pool.end()
    }
  })
  it('stdio: real get_context counts; failed action and revoked token do not', async () => {
    const good = await stdio()
    expect((await good.client.callTool({ name: 'get_context', arguments: { product_id: pid } })).isError).not.toBe(true)
    await pause(20)
    expect(good.writes()).toBe(1)
    expect((await good.client.callTool({ name: 'create_sprint', arguments: { product_id: 'missing', sprint_goal: 'Must fail' } })).isError).toBe(true)
    expect(good.writes()).toBe(1)
    const dead = await stdio(revoked)
    expect((await dead.client.callTool({ name: 'get_context', arguments: { product_id: pid } })).isError).toBe(true)
    expect(dead.writes()).toBe(0)
  })
  it('HTTP: real get_context counts; failed action and revoked preflight do not', async () => {
    const client = await http()
    const before = count(httpOutput)
    expect((await client.callTool({ name: 'get_context', arguments: { product_id: pid } })).isError).not.toBe(true)
    await pause(20)
    expect(count(httpOutput)).toBe(before + 1)
    expect((await client.callTool({ name: 'create_sprint', arguments: { product_id: 'missing', sprint_goal: 'Must fail' } })).isError).toBe(true)
    await expect(http(revoked)).rejects.toThrow()
    expect(count(httpOutput)).toBe(before + 1)
  })
  it('invalid plan YAML remains an explicit domain error and does not count', async () => {
    const idea = `usage-idea-${suffix}`
    await pool.query('INSERT INTO ideas(id,user_id,product_id,code,title,updated_at) VALUES($1,$2,$3,$4,$5,now())', [idea, uid, pid, 'IDEA-1', 'Synthetic plan'])
    const probe = await stdio()
    const result = await probe.client.callTool({ name: 'update_idea_plan_md', arguments: { idea_id: idea, markdown: 'Invalid: no frontmatter' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('PLAN_FAILED')
    expect(probe.writes()).toBe(0)
  })
  it('canary: real get_context execution forbidden and no writer', async () => {
    const canary = await stdio(raw, 'canary')
    expect((await canary.client.callTool({ name: 'get_context', arguments: { product_id: pid } })).isError).toBe(true)
    expect(canary.writes()).toBe(0)
  })
  async function waitUntilListening() {
    for (let i = 0; i < 100; i++) {
      const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'LISTEN %'")
      if (result.rowCount) return
      await pause(20)
    }
    throw new Error('Actual queue wait never reached LISTEN')
  }
  it('stdio: cancellation of actual queue wait never counts', async () => {
    const probe = await stdio()
    const controller = new AbortController()
    const call = probe.client.callTool({ name: 'queue_wait_reply', arguments: { message_ids: [randomUUID()], wait_seconds: 10 } }, undefined, { signal: controller.signal }).catch(e => e)
    await waitUntilListening()
    controller.abort()
    expect(await call).toBeInstanceOf(Error)
    await pause(200)
    expect(probe.writes()).toBe(0)
  })
  it('HTTP: disconnect before a blocked real get_context completes never counts', async () => {
    const before = count(httpOutput)
    const lock = await pool.connect()
    await lock.query('BEGIN')
    await lock.query('LOCK TABLE products IN ACCESS EXCLUSIVE MODE')
    const controller = new AbortController()
    const call = fetch(httpUrl, { method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'get_context', arguments: { product_id: pid } } })
    }).then(async response => response.text()).catch(e => e)
    try {
      let blocked = false
      for (let i = 0; i < 100; i++) {
        const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%products%'")
        if (result.rowCount) { blocked = true; break }
        await pause(20)
      }
      expect(blocked).toBe(true)
      controller.abort()
      expect(await call).toBeInstanceOf(Error)
      // Allow the socket close to reach the server before completing its action.
      await pause(50)
    } finally {
      await lock.query('ROLLBACK')
      lock.release()
    }
    await pause(300)
    expect(count(httpOutput)).toBe(before)
  })
  it('normal empty queue timeout is a successful request', async () => {
    const probe = await stdio()
    const result = await probe.client.callTool({ name: 'queue_wait_reply', arguments: { message_ids: [randomUUID()], wait_seconds: 0 } })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result)).toContain('timeout')
    await pause(20)
    expect(probe.writes()).toBe(1)
  })
})
