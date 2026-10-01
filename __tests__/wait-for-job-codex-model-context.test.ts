import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  claudeJob: { findUnique: vi.fn() },
  jobKindConfig: { findUnique: vi.fn() },
  product: { findUnique: vi.fn() },
}))
vi.mock('../src/prisma.js', () => ({ prisma: db }))

import { getFullJobContext } from '../src/tools/wait-for-job.js'

function job(requested_model: string | null = null) {
  return {
    id: 'codex-model-context', kind: 'PLAN_CHAT', runtime: 'CODEX', source: 'MANUAL',
    status: 'CLAIMED', requested_model, requested_thinking_budget: null,
    requested_permission_mode: null, task: null, idea: null, sprint_run_id: null,
    dispatch_request_id: null, dispatch_candidate_id: null,
    manual_drafts: [{ id: 'draft-model', title: 'Model fixture', adapter: 'codex_cli',
      required_capability: 'planning', prompt_md: 'Return a short plan.', launch_preview_json: {} }],
    product: { id: 'product-model', name: 'Model fixture', repo_url: null,
      definition_of_done: '', preferred_model: 'claude-sonnet-5-5',
      thinking_budget_default: null, preferred_permission_mode: null },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  db.claudeJob.findUnique.mockResolvedValue(job())
  db.jobKindConfig.findUnique.mockResolvedValue({ codex_model: 'gpt-6-astra', thinking_budget: 6000 })
  db.product.findUnique.mockResolvedValue({ enabled_doc_folders: [] })
})

describe('Codex model in actual full job context', () => {
  it.each([undefined, 'CODEX'] as const)('uses the live model with caller runtime %s', async (runtime) => {
    const context = await getFullJobContext('codex-model-context', runtime)
    expect(context).toMatchObject({ config: { runtime: 'CODEX', model: 'gpt-6-astra' } })
    expect(db.jobKindConfig.findUnique).toHaveBeenCalledWith({ where: { kind: 'PLAN_CHAT' } })
  })

  it('passes a future configured id through without a code catalogue update', async () => {
    db.jobKindConfig.findUnique.mockResolvedValue({ codex_model: 'gpt-future-registry-fixture' })
    expect(await getFullJobContext('codex-model-context')).toMatchObject({
      config: { runtime: 'CODEX', model: 'gpt-future-registry-fixture' },
    })
  })

  it.each([
    ['codex-default', 'gpt-6-astra'],
    ['gpt-5.6-terra', 'gpt-5.6-terra'],
  ])('preserves override semantics for %s', async (override, expected) => {
    db.claudeJob.findUnique.mockResolvedValue(job(override))
    expect(await getFullJobContext('codex-model-context')).toMatchObject({
      config: { runtime: 'CODEX', model: expected },
    })
  })
})
