import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDispatchHarness, type DispatchHarness, type DispatchHarnessSeed } from './harness.js'
import { createDispatchAuth } from '../../src/dispatch/auth.js'
import { createDispatchRequests } from '../../src/dispatch/requests.js'
import { createReadyFixtureSelection } from './source-fixtures.js'
import { readManagedJobSnapshot } from '../../src/dispatch/job-adapter.js'
import { resolveRuntimeJobConfig } from '@shared/job-config.js'

let h: DispatchHarness
let f: DispatchHarnessSeed
let previousConfig: unknown

beforeEach(async () => {
  h = await makeDispatchHarness()
  f = await h.seed()
  previousConfig = (await h.admin.query("SELECT row_to_json(k) AS config FROM job_kind_config k WHERE kind='QUEUE_TASK'")).rows[0]?.config
  await h.admin.query("INSERT INTO job_kind_config(kind,codex_model,allowed_tools,skills,updated_at) VALUES('QUEUE_TASK','gpt-6-astra','{}','{}',now()) ON CONFLICT(kind) DO UPDATE SET codex_model='gpt-6-astra'")
})

afterEach(async () => {
  try {
    await h.reset()
    await h.admin.query("DELETE FROM job_kind_config WHERE kind='QUEUE_TASK'")
    if (previousConfig) await h.admin.query('INSERT INTO job_kind_config SELECT * FROM json_populate_record(NULL::job_kind_config,$1::json)', [JSON.stringify(previousConfig)])
  } finally {
    await h.close()
  }
})

describe('registry models in managed snapshots', () => {
  it('persists Astra via actual selection/enqueue and keeps its frozen override', async () => {
    const auth = createDispatchAuth({ store: h.dispatch })
    const requests = createDispatchRequests({ store: h.dispatch, auth, enabled: true, productAllowlist: [f.input.product_id] })
    const selection = createReadyFixtureSelection({ store: h.dispatch, auth, enabled: true, productAllowlist: [f.input.product_id] })
    const request = await requests.submitDispatch(f.actor, f.input, 'model-snapshot')
    const snapshot = await readManagedJobSnapshot(h.dispatch, {
      id: request.id, user_id: f.actor.userId, product_id: f.input.product_id,
      input: f.input, snapshot: {},
    })
    expect(snapshot.CODEX).toMatchObject({ runtime: 'CODEX', model: 'gpt-6-astra' })
    expect(await selection.reserveNextRequest()).toBe(request.id)
    const saved = (await h.admin.query('SELECT requested_model FROM claude_jobs WHERE dispatch_request_id=$1', [request.id])).rows
    expect(saved).toEqual([{ requested_model: 'gpt-6-astra' }])
    await h.admin.query("UPDATE job_kind_config SET codex_model='gpt-5.6-terra' WHERE kind='QUEUE_TASK'")
    const kindConfig = (await h.admin.query("SELECT * FROM job_kind_config WHERE kind='QUEUE_TASK'")).rows[0]
    const frozen = (await h.admin.query('SELECT requested_model FROM claude_jobs WHERE dispatch_request_id=$1', [request.id])).rows[0]
    expect(resolveRuntimeJobConfig({ kind: 'QUEUE_TASK', requested_model: frozen.requested_model }, {}, undefined, kindConfig, 'CODEX').model).toBe('gpt-6-astra')
  })

  it('still refuses unsafe managed configuration even with a registered model', async () => {
    await h.admin.query("UPDATE job_kind_config SET allow_all_tools=true WHERE kind='QUEUE_TASK'")
    const snapshot = await readManagedJobSnapshot(h.dispatch, {
      id: 'unsafe-model-fixture', user_id: f.actor.userId, product_id: f.input.product_id,
      input: f.input, snapshot: {},
    })
    expect(snapshot).toEqual({ CLAUDE: null, CODEX: null })
  })
})
