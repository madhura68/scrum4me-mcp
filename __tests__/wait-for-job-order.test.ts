import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('SPRINT_IMPLEMENTATION scope ordering', () => {
  it('does not use priority as execution order', () => {
    const source = readFileSync(new URL('../src/tools/wait-for-job.ts', import.meta.url), 'utf8')

    expect(source).not.toMatch(/orderBy[^\n]*priority|priority[^\n]*orderBy|priority ASC/)
  })
})
