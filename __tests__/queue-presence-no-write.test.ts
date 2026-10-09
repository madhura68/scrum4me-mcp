// ISS-58: de MCP schrijft nooit in agent_presence. Het gesloten db-access-contract
// geeft scrum4me_web_runtime/scrum4me_worker alleen SELECT; elke schrijfpoging
// faalde stil (permission denied) en vulde de postgres-log.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('agent_presence is alleen-lezen vanuit de MCP (ISS-58)', () => {
  it('geen INSERT, UPDATE of DELETE op agent_presence in src/', () => {
    const writes = sourceFiles(join(__dirname, '..', 'src')).filter((file) =>
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?agent_presence\b/i.test(readFileSync(file, 'utf8')),
    )
    expect(writes).toEqual([])
  })
})
