import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { Pool } from 'pg'
import { makeDispatchHarness, type DispatchHarness } from './harness.js'
import { createDispatchApp } from '../../src/dispatch/routes.js'
import { DISPATCH_PROTOCOL, DISPATCH_SERVICE_VERSION } from '../../src/dispatch/health.js'

let h: DispatchHarness
const servers: Server[] = []
beforeEach(async () => { h = await makeDispatchHarness() })
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  await h.close()
})

async function healthz(store: Pool) {
  const server = createDispatchApp({ store, enabled: false, productAllowlist: [] }).listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/healthz`)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

it('reports the real schema and the real dispatch role, and writes nothing while doing it', async () => {
  const counts = async () => (await h.admin.query<{ events: string; requests: string }>(
    'SELECT (SELECT count(*) FROM queue_dispatch_events) AS events,(SELECT count(*) FROM queue_dispatch_requests) AS requests')).rows[0]
  const before = await counts()
  expect(await healthz(h.dispatch)).toEqual({
    status: 200,
    body: { version: DISPATCH_SERVICE_VERSION, protocol: DISPATCH_PROTOCOL, schema_ready: true, role_ready: true },
  })
  expect(await counts()).toEqual(before)
})

it('refuses to call a connection that is not the contract role ready, however complete its schema is', async () => {
  // The migration owner sees the whole schema and is exactly the connection the service must not use.
  const { status, body } = await healthz(h.admin)
  expect(status).toBe(200)
  expect(body).toMatchObject({ schema_ready: true, role_ready: false })
  expect(Object.keys(body).sort()).toEqual(['protocol', 'role_ready', 'schema_ready', 'version'])
})

it('needs no authorization and answers the same for anyone', async () => {
  const server = createDispatchApp({ store: h.dispatch, enabled: false, productAllowlist: [] }).listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/healthz`
  const anonymous = await (await fetch(url)).json()
  const bearer = await (await fetch(url, { headers: { Authorization: 'Bearer not-a-token' } })).json()
  expect(bearer).toEqual(anonymous)
  // It is not part of the versioned protocol surface and answers nothing else.
  expect((await fetch(url, { method: 'POST' })).status).toBe(404)
  expect((await fetch(`${url.replace('/healthz', '/dispatch/v1/healthz')}`)).status).toBe(404)
})
