import { it, expect, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({ prisma: {} }))
vi.mock('../src/auth.js', () => ({ requireWriteAccess: vi.fn() }))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))

import { KIND_VALUES } from '../src/tools/dispatch-job.js'

it('IDEA_CHAT is bewust géén dispatch_job-kind: jobs ontstaan alleen via het send-protocol (copilot idea-chat spec §3.7)', () => {
  expect(KIND_VALUES).not.toContain('IDEA_CHAT')
})
