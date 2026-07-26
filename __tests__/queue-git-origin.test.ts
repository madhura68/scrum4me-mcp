import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveRepoFromCwd } from '../src/queue/git-origin.js'

describe('deriveRepoFromCwd — best-effort git remote get-url origin (§5.1)', () => {
  it('geeft null buiten een git-repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-no-repo-'))
    expect(await deriveRepoFromCwd(dir)).toBeNull()
  })

  it('geeft null voor een niet-bestaande cwd', async () => {
    expect(await deriveRepoFromCwd('/pad/dat/niet/bestaat')).toBeNull()
  })
})
