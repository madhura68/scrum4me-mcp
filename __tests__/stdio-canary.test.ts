import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { runStdioCanary } from '../scripts/stdio-canary.js'
import type { StdioCanaryResultV1 } from '../src/canary-mode.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const CANARY_SCRIPT = join(REPO_ROOT, 'scripts', 'stdio-canary.ts')

// A named-but-not-embedded secret: we inject it into the child environment and
// assert it never surfaces in the credentialless canary's stdout or stderr.
const INJECTED_SECRET = 'sk-canary-must-never-leak-4f1c9a'

function assertResultShape(result: StdioCanaryResultV1): void {
  expect(result.version).toBe('scrum4me-mcp-canary/v1')
  expect(result.server_name).toBe('scrum4me-mcp')
  expect(result.ok).toBe(true)
  expect(typeof result.server_version).toBe('string')
  expect(result.tool_count).toBeGreaterThan(0)
  expect(result.tool_surface_sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(result.protocol_version.length).toBeGreaterThan(0)
}

describe('stdio canary — in-process', () => {
  it('initializes and lists the surface credentialless, with a stable hash', async () => {
    const first = await runStdioCanary({ SCRUM4ME_RELEASE_COMMIT: 'deadbeef' })
    assertResultShape(first)
    expect(first.release_commit).toBe('deadbeef')

    const second = await runStdioCanary({ SCRUM4ME_RELEASE_COMMIT: 'deadbeef' })
    // Surface digest and tool count are deterministic across runs.
    expect(second.tool_surface_sha256).toBe(first.tool_surface_sha256)
    expect(second.tool_count).toBe(first.tool_count)
  })
})

describe('stdio canary — spawned without DB/token', () => {
  it('emits exactly one result object, exits 0, and leaks no secret', () => {
    // Strip DB + token; a real handler would throw, but the canary forbids
    // execution so it never needs them. Inject a secret to prove no leak.
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.DATABASE_URL
    delete env.SCRUM4ME_TOKEN
    env.SCRUM4ME_CANARY_MODE = '1'
    env.SCRUM4ME_INJECTED_SECRET = INJECTED_SECRET
    env.SCRUM4ME_RELEASE_COMMIT = 'spawned-commit'

    const proc = spawnSync(process.execPath, [TSX_CLI, CANARY_SCRIPT], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    })

    expect(proc.status).toBe(0)

    const stdoutLines = proc.stdout.trim().split('\n').filter(Boolean)
    expect(stdoutLines).toHaveLength(1)

    const result = JSON.parse(stdoutLines[0]) as StdioCanaryResultV1
    assertResultShape(result)
    expect(result.release_commit).toBe('spawned-commit')

    expect(proc.stdout).not.toContain(INJECTED_SECRET)
    expect(proc.stderr).not.toContain(INJECTED_SECRET)
  })
})
