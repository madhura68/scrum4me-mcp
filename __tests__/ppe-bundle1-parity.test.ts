import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PLAN_A_SHARED_COMMIT = '36993b26138554afee18d0e7af03e9e1b77dd85b'
const PLAN_A_STORAGE_FOUNDATION_ACK_SHA256 = 'b35da103fe8f0b94e2a928e4e2605819e1605147f23e544317a24f52dd85c988'
const PLAN_A_PREDECESSOR_INPUT_SHA256 = 'b5d72d6a49eb0ef50e1bc417d4c4d8fc39231d3c9bb1de35933347985e406df8'
const PLAN_A_JCS_VECTOR_SHA256 = 'a9489ef41ec3cf1d0f8f2190d21e7b1875dbb88a990c1c60fcef9367d3863a05'
const MCP_IMPLEMENTATION_SCHEMA_SHA256 = 'e22330c2c90246723eebb9eeddcaab7a3d192aa634f84f44eccca9d4a8ae75fb'

const predecessorInput = {
  plan_a_db_evidence_commit: '4b80c6e9837399fbd5e5d4b81b8753a9c122b863',
  plan_a_db_implementation_commit: 'ac7294ceec4a8a67f066648983e2f8ac00798b42',
  plan_a_shared_commit: PLAN_A_SHARED_COMMIT,
  storage_foundation_ack_sha256: PLAN_A_STORAGE_FOUNDATION_ACK_SHA256,
  version: 'plan-a-predecessor-input-v1',
} as const

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('Bundle 1 Plan A and B1 compatibility consumer', () => {
  it('pins the exact closed Plan A predecessor input and storage ACK', () => {
    expect(Object.keys(predecessorInput)).toEqual([
      'plan_a_db_evidence_commit',
      'plan_a_db_implementation_commit',
      'plan_a_shared_commit',
      'storage_foundation_ack_sha256',
      'version',
    ])
    expect(sha256(JSON.stringify(predecessorInput))).toBe(PLAN_A_PREDECESSOR_INPUT_SHA256)
  })

  it('pins the committed shared input and hand-derived JCS vector bytes', () => {
    const gitlink = execFileSync('git', ['rev-parse', 'HEAD:vendor/scrum4me-shared'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    }).trim()
    expect(gitlink).toBe(PLAN_A_SHARED_COMMIT)

    const vector = readFileSync(new URL(
      '../vendor/scrum4me-shared/fixtures/parallel-plan-execution/storage-projection-v1.json',
      import.meta.url,
    ))
    expect(vector.at(-1)).not.toBe(0x0a)
    expect(vector.toString('utf8')).toBe(JSON.stringify(JSON.parse(vector.toString('utf8'))))
    expect(sha256(vector)).toBe(PLAN_A_JCS_VECTOR_SHA256)
  })

  it('pins the B1 generated consumer schema separately from the JCS vector', () => {
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url))
    expect(sha256(schema)).toBe(MCP_IMPLEMENTATION_SCHEMA_SHA256)
    expect(MCP_IMPLEMENTATION_SCHEMA_SHA256).not.toBe(PLAN_A_JCS_VECTOR_SHA256)

    const text = schema.toString('utf8')
    for (const model of [
      'AgentMessage',
      'AgentMessageArchive',
      'PpeBootstrapFamily',
      'PpeRunRegistry',
      'PpeOrchestratorLease',
      'PpeConsumer',
      'PpeClaimLease',
      'PpeOperationReceipt',
      'PpeRunLedgerEvent',
      'PpeResource',
      'PpeLocalChild',
      'PpeStateHead',
    ]) expect(text).toContain(`model ${model} {`)
  })
})
