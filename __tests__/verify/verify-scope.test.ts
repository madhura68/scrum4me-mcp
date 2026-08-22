import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getDiffInWorktree } from '../../src/tools/verify-task-against-plan.js'

const exec = promisify(execFile)

describe('verify scope per-job (PBI-47 P0)', () => {
  let tmpRepo: string
  let baseSha: string
  let task1Sha: string

  beforeAll(async () => {
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-scope-'))
    await exec('git', ['init', '-b', 'main'], { cwd: tmpRepo })
    await exec('git', ['config', 'user.email', 't@t.local'], { cwd: tmpRepo })
    await exec('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo })
    await fs.writeFile(path.join(tmpRepo, 'README.md'), '# init\n')
    await exec('git', ['add', '-A'], { cwd: tmpRepo })
    await exec('git', ['commit', '-m', 'init'], { cwd: tmpRepo })
    const baseRev = await exec('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo })
    baseSha = baseRev.stdout.trim()

    // Simulate task 1: add a.ts
    await fs.writeFile(path.join(tmpRepo, 'a.ts'), 'task 1\n')
    await exec('git', ['add', '-A'], { cwd: tmpRepo })
    await exec('git', ['commit', '-m', 'task 1'], { cwd: tmpRepo })
    const t1Rev = await exec('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo })
    task1Sha = t1Rev.stdout.trim()

    // Simulate task 2: add b.ts
    await fs.writeFile(path.join(tmpRepo, 'b.ts'), 'task 2\n')
    await exec('git', ['add', '-A'], { cwd: tmpRepo })
    await exec('git', ['commit', '-m', 'task 2'], { cwd: tmpRepo })
  })

  afterAll(async () => {
    await fs.rm(tmpRepo, { recursive: true, force: true })
  })

  it('diff vs base = origin/main → both task 1 and task 2 visible', async () => {
    const diff = await getDiffInWorktree(tmpRepo, baseSha)
    expect(diff).toContain('a.ts')
    expect(diff).toContain('b.ts')
  })

  it('diff vs base = task1_sha → only task 2 visible', async () => {
    const diff = await getDiffInWorktree(tmpRepo, task1Sha)
    expect(diff).not.toContain('a.ts')
    expect(diff).toContain('b.ts')
  })
})

describe('large verify diffs', () => {
  it('reads diff output larger than the Node execFile default buffer', async () => {
    const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-large-diff-'))

    try {
      await exec('git', ['init', '-b', 'main'], { cwd: tmpRepo })
      await exec('git', ['config', 'user.email', 't@t.local'], { cwd: tmpRepo })
      await exec('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo })
      await fs.writeFile(path.join(tmpRepo, 'README.md'), '# init\n')
      await exec('git', ['add', '-A'], { cwd: tmpRepo })
      await exec('git', ['commit', '-m', 'init'], { cwd: tmpRepo })
      const baseRev = await exec('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo })

      const largeFile = Array.from(
        { length: 90_000 },
        (_, index) => `line-${index.toString().padStart(6, '0')}: verify buffer regression`,
      ).join('\n')
      await fs.writeFile(path.join(tmpRepo, 'large-diff.txt'), `${largeFile}\n`)
      await exec('git', ['add', '-A'], { cwd: tmpRepo })
      await exec('git', ['commit', '-m', 'large diff'], { cwd: tmpRepo })

      const diff = await getDiffInWorktree(tmpRepo, baseRev.stdout.trim())

      expect(Buffer.byteLength(diff)).toBeGreaterThan(1024 * 1024)
      expect(diff).toContain('large-diff.txt')
    } finally {
      await fs.rm(tmpRepo, { recursive: true, force: true })
    }
  })
})
