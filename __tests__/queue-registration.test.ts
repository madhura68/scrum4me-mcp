import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({ prisma: {} }))

import { registerQueueTools, registerSharedTools, registerWorktreeTools } from '../src/register.js'
import { createMcpServer } from '../src/http.js'

const QUEUE_TOOL_NAMES = [
  'queue_push', 'queue_wait_reply', 'queue_next', 'queue_done',
  'queue_fail', 'queue_status', 'queue_list',
  'queue_register_consumer', 'queue_claim_marked', 'queue_renew_marked',
  'queue_cancel_marked',
] as const

function captureNames() {
  const names: string[] = []
  const server = {
    registerTool: (n: string) => {
      names.push(n)
    },
    registerPrompt: () => {},
  }
  return { server, names }
}

describe('queue-tools registratie — stdio-only (spec §5-intro/§9)', () => {
  it('registerQueueTools registreert exact de 7 legacy- en 4 marked-tools', () => {
    const { server, names } = captureNames()
    registerQueueTools(server as never)
    expect([...names].sort()).toEqual([...QUEUE_TOOL_NAMES].sort())
  })

  it('registerSharedTools bevat géén queue-tools', () => {
    const { server, names } = captureNames()
    registerSharedTools(server as never)
    for (const name of QUEUE_TOOL_NAMES) expect(names).not.toContain(name)
  })

  it('registerWorktreeTools bevat géén queue-tools', () => {
    const { server, names } = captureNames()
    registerWorktreeTools(server as never)
    for (const name of QUEUE_TOOL_NAMES) expect(names).not.toContain(name)
  })

  it('de échte HTTP-server exposeert géén queue-tools (assert op geregistreerde toolnamen)', () => {
    const server = createMcpServer()
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    )
    expect(registered.length).toBeGreaterThan(0)
    for (const name of QUEUE_TOOL_NAMES) expect(registered).not.toContain(name)
  })
})
