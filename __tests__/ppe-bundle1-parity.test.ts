import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PLAN_A_SHARED_COMMIT = '36993b26138554afee18d0e7af03e9e1b77dd85b'
const PLAN_A_STORAGE_FOUNDATION_ACK_SHA256 = 'b35da103fe8f0b94e2a928e4e2605819e1605147f23e544317a24f52dd85c988'
const PLAN_A_PREDECESSOR_INPUT_SHA256 = 'b5d72d6a49eb0ef50e1bc417d4c4d8fc39231d3c9bb1de35933347985e406df8'
const PLAN_A_JCS_VECTOR_SHA256 = 'a9489ef41ec3cf1d0f8f2190d21e7b1875dbb88a990c1c60fcef9367d3863a05'
const B1_MCP_COMMIT = '4da3e7bf47af95b1d6f99533dd77aafe4011e051'
const B1_MCP_SCHEMA_SHA256 = 'e22330c2c90246723eebb9eeddcaab7a3d192aa634f84f44eccca9d4a8ae75fb'
const REBASELINED_SHARED_COMMIT = '6852386ef94d348315ba4021ea7e53968814b06b'
const REBASELINED_MCP_SCHEMA_SHA256 = '91e847ba982dc4f21928b23e63a4d25376b29ab4bc3ce5a2c61dbe8494e51282'
const repository = new URL('..', import.meta.url)

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

function candidateAncestryRef(): 'HEAD' | 'MERGE_HEAD' {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], {
      cwd: repository,
      stdio: 'ignore',
    })
    return 'MERGE_HEAD'
  } catch {
    return 'HEAD'
  }
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

  it('pins the historical B1 shared input, schema, and hand-derived JCS vector bytes', () => {
    expect(() => execFileSync(
      'git',
      ['merge-base', '--is-ancestor', B1_MCP_COMMIT, candidateAncestryRef()],
      { cwd: repository },
    )).not.toThrow()

    const gitlink = execFileSync('git', ['ls-tree', B1_MCP_COMMIT, 'vendor/scrum4me-shared'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim()
    expect(gitlink).toBe(`160000 commit ${PLAN_A_SHARED_COMMIT}\tvendor/scrum4me-shared`)

    const vector = execFileSync('git', [
      '-C',
      'vendor/scrum4me-shared',
      'show',
      `${PLAN_A_SHARED_COMMIT}:fixtures/parallel-plan-execution/storage-projection-v1.json`,
    ], { cwd: repository })
    expect(vector.at(-1)).not.toBe(0x0a)
    expect(vector.toString('utf8')).toBe(JSON.stringify(JSON.parse(vector.toString('utf8'))))
    expect(sha256(vector)).toBe(PLAN_A_JCS_VECTOR_SHA256)

    const schema = execFileSync('git', ['show', `${B1_MCP_COMMIT}:prisma/schema.prisma`], {
      cwd: repository,
    })
    expect(sha256(schema)).toBe(B1_MCP_SCHEMA_SHA256)
  })

  it('pins the rebaselined shared gitlink and generated consumer schema separately', () => {
    const stagedGitlink = execFileSync(
      'git',
      ['ls-files', '--stage', 'vendor/scrum4me-shared'],
      { cwd: repository, encoding: 'utf8' },
    ).trim()
    expect(stagedGitlink).toBe(
      `160000 ${REBASELINED_SHARED_COMMIT} 0\tvendor/scrum4me-shared`,
    )

    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url))
    expect(sha256(schema)).toBe(REBASELINED_MCP_SCHEMA_SHA256)
    expect(REBASELINED_MCP_SCHEMA_SHA256).not.toBe(PLAN_A_JCS_VECTOR_SHA256)

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
