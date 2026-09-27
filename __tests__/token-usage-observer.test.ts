import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { installTokenUsageObserver } from '../src/token-usage-observer.js'
import { markAuthenticatedToken, requestContext } from '../src/request-context.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
async function fixture() {
  const server = new McpServer({ name: 'usage-test', version: '1' })
  const record = vi.fn(async () => {})
  installTokenUsageObserver(server, record)
  const auth = () => markAuthenticatedToken({ tokenId: 't1', userId: 'u1' })
  server.registerTool('success', {}, async () => { auth(); return { content: [] } })
  server.registerTool('error', {}, async () => { auth(); return { content: [], isError: true } })
  server.registerTool('throws', {}, async () => { auth(); throw new Error('domain failure') })
  server.registerTool('output', { outputSchema: { count: z.number() } }, async () => {
    auth(); return { content: [], structuredContent: { count: 'invalid' } }
  })
  server.registerTool('input', { inputSchema: { count: z.number() } }, async () => {
    auth(); return { content: [] }
  })
  for (const name of ['health', 'dispatch_task', 'dispatch_review', 'get_dispatch', 'cancel_dispatch']) {
    server.registerTool(name, {}, async () => ({ content: [] }))
  }
  server.registerTool('parallel', { inputSchema: { tokenId: z.string(), userId: z.string() } }, async args => {
    markAuthenticatedToken(args)
    await new Promise(resolve => setTimeout(resolve, args.tokenId === 'slow' ? 30 : 1))
    return { content: [] }
  })
  let started!: () => void
  const waiting = new Promise<void>(resolve => { started = resolve })
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  server.registerTool('wait', {}, async () => { auth(); started(); await released; return { content: [] } })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await server.connect(st)
  await client.connect(ct)
  cleanups.push(async () => { await client.close(); await server.close() })
  return { client, record, waiting, release }
}

describe('complete SDK call observation', () => {
  it('records validated authenticated success once, with completion time', async () => {
    const { client, record } = await fixture()
    const before = Date.now()
    const result = await client.callTool({ name: 'success' })
    expect(result).toEqual({ content: [] })
    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith({ tokenId: 't1', userId: 'u1', completedAt: expect.any(Date) })
    expect((record.mock.calls[0] as unknown as [{completedAt: Date}])[0].completedAt.getTime()).toBeGreaterThanOrEqual(before)
  })
  it.each(['error', 'throws', 'output', 'input'])('excludes SDK/domain error %s', async name => {
    const { client, record } = await fixture()
    expect(await client.callTool({ name })).toMatchObject({ isError: true })
    expect(record).not.toHaveBeenCalled()
  })
  it.each(['health', 'dispatch_task', 'dispatch_review', 'get_dispatch', 'cancel_dispatch'])('does not reuse preflight auth for %s', async name => {
    const { client, record } = await fixture()
    await requestContext.run({ token: 'raw-is-not-proof' }, async () => {
      markAuthenticatedToken({ tokenId: 'preflight', userId: 'preflight' })
      await client.callTool({ name })
    })
    expect(record).not.toHaveBeenCalled()
  })
  it('isolates overlapping identities', async () => {
    const { client, record } = await fixture()
    await Promise.all(['slow', 'fast'].map(tokenId => client.callTool({ name: 'parallel', arguments: { tokenId, userId: tokenId + '-user' } })))
    expect(record.mock.calls).toEqual([
      [{ tokenId: 'fast', userId: 'fast-user', completedAt: expect.any(Date) }],
      [{ tokenId: 'slow', userId: 'slow-user', completedAt: expect.any(Date) }],
    ])
  })
  it('excludes a cancelled call even when the handler later returns success', async () => {
    const { client, record, waiting, release } = await fixture()
    const controller = new AbortController()
    const result = client.callTool({ name: 'wait' }, undefined, { signal: controller.signal }).catch(e => e)
    await waiting
    controller.abort()
    await result
    // The SDK notification must reach the server before releasing its action.
    await new Promise(resolve => setTimeout(resolve, 10))
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(record).not.toHaveBeenCalled()
  })
})
