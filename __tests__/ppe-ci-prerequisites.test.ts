import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.forgejo/workflows/ci.yml', 'utf8')

function occurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1
}

describe('PPE controller CI prerequisites', () => {
  it('provisions and bootstraps a disposable pgvector database in both CI jobs', () => {
    expect(occurrences(workflow, 'image: pgvector/pgvector:pg17')).toBe(2)
    expect(occurrences(workflow, 'POSTGRES_DB: scrum4me_mcp_ppe_test')).toBe(2)
    expect(occurrences(
      workflow,
      'run: npx prisma db push --url "$PPE_CONTROLLER_TEST_DATABASE_URL"',
    )).toBe(2)
  })

  it('binds only the dedicated PPE controller test variable to the disposable database', () => {
    expect(occurrences(workflow, 'PPE_CONTROLLER_TEST_DATABASE_URL:')).toBe(2)
    expect(occurrences(
      workflow,
      'DATABASE_URL: postgresql://placeholder:placeholder@localhost:5432/placeholder',
    )).toBe(2)
    expect(occurrences(
      workflow,
      'run: npx prisma db push --url "$PPE_CONTROLLER_TEST_DATABASE_URL"',
    )).toBe(2)
    expect(workflow).not.toMatch(/\n\s+TEST_DATABASE_URL:/)
  })
})
