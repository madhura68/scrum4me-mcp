import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { product: { findUnique: vi.fn() } },
}))

import { resolveRepoRoot } from '../src/tools/wait-for-job.js'

const PID = 'prod-claimlog-test'
const ENV_KEY = `SCRUM4ME_REPO_ROOT_${PID}`

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  delete process.env[ENV_KEY]
  vi.restoreAllMocks()
})

describe('resolveRepoRoot observability', () => {
  it('logs repoRoot.resolved with via=product-env', async () => {
    process.env[ENV_KEY] = '/tmp/some-repo'
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await resolveRepoRoot(PID)
    expect(result).toBe('/tmp/some-repo')
    const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('repoRoot.resolved'))
    expect(line).toBeTruthy()
    expect(JSON.parse(line!)).toMatchObject({
      scope: 'claim',
      event: 'repoRoot.resolved',
      via: 'product-env',
    })
  })
})
