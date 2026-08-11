import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerQueueRegisterConsumerTool } from '../src/tools/queue-register-consumer.js'
import { registerQueueClaimMarkedTool } from '../src/tools/queue-claim-marked.js'
import { registerQueueRenewMarkedTool } from '../src/tools/queue-renew-marked.js'
import { registerQueueCancelMarkedTool } from '../src/tools/queue-cancel-marked.js'

describe('marked queue fence tools', () => {
  it('registers only the four dedicated marked operations', () => {
    const names: string[] = []
    const server = { registerTool: vi.fn((name: string) => names.push(name)) } as unknown as McpServer
    registerQueueRegisterConsumerTool(server)
    registerQueueClaimMarkedTool(server)
    registerQueueRenewMarkedTool(server)
    registerQueueCancelMarkedTool(server)
    expect(names).toEqual([
      'queue_register_consumer', 'queue_claim_marked',
      'queue_renew_marked', 'queue_cancel_marked',
    ])
    expect(names).not.toContain('queue_requeue_marked')
  })

  it('pins transaction locks, all generations and opaque-token hashing without generic leases', () => {
    const files = [
      '../src/tools/queue-register-consumer.ts',
      '../src/tools/queue-claim-marked.ts',
      '../src/tools/queue-renew-marked.ts',
      '../src/tools/queue-cancel-marked.ts',
    ].map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')).join('\n')
    expect(files).toContain('FOR UPDATE')
    expect(files).toContain('run_generation')
    expect(files).toContain('orchestrator_generation')
    expect(files).toContain('consumer_generation')
    expect(files).toContain('lease_generation')
    expect(files).toContain("createHash('sha256')")
    expect(files).not.toContain('registerLease')
    expect(files).not.toContain('queue_requeue')
  })
})
