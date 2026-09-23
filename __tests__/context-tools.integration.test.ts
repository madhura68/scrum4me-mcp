import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { prisma } from '../src/prisma.js'
import { createStdioServer } from '../src/stdio-server.js'
import { requestContext } from '../src/request-context.js'
import { handleGetContext } from '../src/tools/get-context.js'
import { handleGetAgentGuide } from '../src/tools/get-agent-guide.js'
import { handleGetSprintContext } from '../src/tools/get-sprint-context.js'
import { handleGetIdeasContext } from '../src/tools/get-ideas-context.js'
import { toolText } from './helpers/tool-result.js'

// Opt in only against a disposable test DB. No fixtures are written to the live MCP DB.
const url = process.env.TEST_CONTEXT_DATABASE_URL
const describeWithDb = url ? describe : describe.skip

describeWithDb('context tools over MCP with real PostgreSQL', () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = (name: string) => `context-${suffix}-${name}`
  const owner = ids('owner'), member = ids('member'), outsider = ids('outsider')
  const product = ids('product'), otherProduct = ids('other-product')
  const ownerToken = ids('owner-token'), memberToken = ids('member-token'), scopedToken = ids('scoped-token'), outsiderToken = ids('outsider-token')
  const firstSprint = ids('s1'), secondSprint = ids('s2'), closedSprint = ids('s3')
  const fullPlan = 'one complete selected implementation plan\n'.repeat(3000)
  const oldEnv = { database: process.env.DATABASE_URL, token: process.env.SCRUM4ME_TOKEN }
  let client: Client
  let server: ReturnType<typeof createStdioServer>

  const doc = async (slug: string, content: string, status = 'active', productId = product) => {
    return prisma.productDoc.upsert({
      where: { product_id_folder_slug: { product_id: productId, folder: 'MANUAL', slug } },
      create: { product_id: productId, folder: 'MANUAL', slug, title: slug, content_md: content, status, created_by: owner },
      update: { content_md: content, status },
    })
  }
  const body = (result: CallToolResult) => {
    expect(result.isError, toolText(result)).not.toBe(true)
    return JSON.parse(toolText(result))
  }
  const call = async (name: string, args: Record<string, unknown>) => body(await client.callTool({ name, arguments: args }) as CallToolResult)

  beforeAll(async () => {
    const target = new URL(url!)
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
      throw new Error('TEST_CONTEXT_DATABASE_URL must name a disposable local *_test database')
    }
    process.env.DATABASE_URL = url
    process.env.SCRUM4ME_TOKEN = ownerToken
    for (const id of [owner, member, outsider]) {
      await prisma.user.create({ data: { id, username: id, password_hash: 'test-only' } })
    }
    for (const id of [product, otherProduct]) {
      await prisma.product.create({ data: { id, code: id === product ? `CTX-${suffix}` : `OTHER-${suffix}`, user_id: owner, name: id, definition_of_done: 'test', enabled_doc_folders: ['MANUAL'] } })
    }
    await prisma.productMember.create({ data: { product_id: product, user_id: member, access: 'READ_ONLY' } })
    for (const [raw, user, scope] of [[ownerToken, owner, []], [memberToken, member, []], [scopedToken, owner, [otherProduct]], [outsiderToken, outsider, []]] as const) {
      await prisma.apiToken.create({ data: { user_id: user, token_hash: createHash('sha256').update(raw).digest('hex'), scoped_products: [...scope] } })
    }
    for (const [id, status, created] of [[firstSprint, 'OPEN', '2026-01-01'], [secondSprint, 'OPEN', '2026-01-02'], [closedSprint, 'CLOSED', '2026-01-03'], [ids('failed'), 'FAILED', '2026-01-04'], [ids('archived'), 'ARCHIVED', '2026-01-05']] as const) {
      await prisma.sprint.create({ data: { id, product_id: product, code: id, sprint_goal: id, status, created_at: new Date(created) } })
    }
    for (const [id, order, priority] of [[ids('pbi1'), 1, 4], [ids('pbi2'), 2, 1]] as const) {
      await prisma.pbi.create({ data: { id, product_id: product, code: id, title: id, sort_order: order, priority } })
    }
    for (const [id, pbi, order, status] of [[ids('story1'), ids('pbi1'), 2, 'DONE'], [ids('story2'), ids('pbi1'), 1, 'IN_SPRINT'], [ids('story3'), ids('pbi2'), 0, 'FAILED']] as const) {
      await prisma.story.create({ data: { id, pbi_id: pbi, product_id: product, sprint_id: firstSprint, code: id, title: id, description: 'full story description', acceptance_criteria: 'full acceptance criteria', priority: order === 1 ? 4 : 1, sort_order: order, status } })
    }
    for (const [id, code, order, status] of [[ids('task1'), 'T-901', 2, 'REVIEW'], [ids('task2'), 'T-100', 1, 'DONE'], [ids('task3'), 'T-902', 3, 'EXCLUDED']] as const) {
      await prisma.task.create({ data: { id, code, story_id: ids('story2'), product_id: product, sprint_id: firstSprint, title: id, description: 'full task description', implementation_plan: id === ids('task1') ? fullPlan : null, priority: order === 1 ? 4 : 1, sort_order: order, status } })
    }
    for (const [id, runtime, model, active] of [[ids('astra'), 'CODEX', 'gpt-6-astra', false], [ids('sol'), 'CODEX', 'gpt-5.6-sol', true], [ids('opus'), 'CLAUDE', 'claude-opus-5', true]] as const) {
      await prisma.agentModel.create({ data: { id, runtime, model_id: model, display_name: model, active, notes: 'REGISTRY NOTES MUST NOT BECOME INSTRUCTIONS' } })
    }
    await doc('agent-guide-runtime-codex', 'CODEX RUNTIME')
    await doc('agent-guide-runtime-claude', 'CLAUDE RUNTIME')
    await doc(`agent-guide-model-${ids('astra')}`, 'ASTRA INSTRUCTIONS')
    await doc(`agent-guide-model-${ids('sol')}`, 'SOL INSTRUCTIONS')
    await doc(`agent-guide-model-${ids('opus')}`, 'OPUS INSTRUCTIONS')
    await doc('agent-guide', 'PRODUCT AGREEMENTS LAST')
    await doc(`agent-guide-model-${ids('astra')}`, 'OTHER PRODUCT INSTRUCTIONS', 'active', otherProduct)
    for (const [id, user, productId, status, archived, date] of [
      [ids('idea-global'), owner, null, 'DRAFT', false, '2026-01-01'],
      [ids('idea-product'), owner, product, 'GRILLED', false, '2026-01-02'],
      [ids('idea-planned'), owner, product, 'PLANNED', false, '2025-01-01'],
      [ids('idea-archived'), owner, product, 'DRAFT', true, '2025-01-01'],
      [ids('idea-other-owner'), outsider, product, 'DRAFT', false, '2025-01-01'],
      [ids('idea-other-product'), owner, otherProduct, 'DRAFT', false, '2025-01-01'],
    ] as const) {
      await prisma.idea.create({ data: { id, code: id.replace(`context-${suffix}-`, ''), user_id: user, product_id: productId, title: id, description: 'idea details excluded', status, archived, created_at: new Date(date) } })
    }
    server = createStdioServer({ mode: 'runtime' }) // constructor only: no presence or maintenance
    client = new Client({ name: 'context-integration-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
  }, 30000)

  afterAll(async () => {
    await client?.close()
    await server?.close()
    if (url && process.env.DATABASE_URL === url) {
      await prisma.task.deleteMany({ where: { product_id: { in: [product, otherProduct] } } })
      await prisma.story.deleteMany({ where: { product_id: { in: [product, otherProduct] } } })
      await prisma.user.deleteMany({ where: { id: { in: [owner, member, outsider] } } })
      await prisma.agentModel.deleteMany({ where: { id: { in: [ids('astra'), ids('sol'), ids('opus')] } } })
      await prisma.$disconnect()
    }
    if (oldEnv.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldEnv.database
    if (oldEnv.token === undefined) delete process.env.SCRUM4ME_TOKEN; else process.env.SCRUM4ME_TOKEN = oldEnv.token
  })

  it('lists the three reads and returns every OPEN sprint without the old large fields', async () => {
    const tools = await client.listTools()
    for (const name of ['get_context', 'get_sprint_context', 'get_ideas_context']) {
      expect(tools.tools.find(t => t.name === name)?.annotations?.readOnlyHint).toBe(true)
    }
    const context = await call('get_context', { product_id: `CTX-${suffix}` })
    expect(context.active_sprints.map((s: { id: string }) => s.id)).toEqual([secondSprint, firstSprint])
    expect(Object.keys(context).sort()).toEqual(['active_sprints', 'agent_context', 'agent_guide', 'agent_guide_error', 'product'])
    expect(JSON.stringify(context)).not.toContain('full task description')
    expect(await call('get_claude_context', { product_id: product })).toEqual(context)
  })

  it('orders actual rows by their PBI/story/task hierarchy, preserving codes and all statuses', async () => {
    const data = await call('get_sprint_context', { sprint_id: firstSprint })
    expect(data.stories.map((s: { id: string }) => s.id)).toEqual([ids('story2'), ids('story1'), ids('story3')])
    expect(data.stories[0].tasks.map((t: { code: string; status: string }) => [t.code, t.status])).toEqual([['T-100', 'done'], ['T-901', 'review'], ['T-902', 'excluded']])
    expect(data.selected_task).toBeNull()
    expect(JSON.stringify(data)).not.toContain('implementation_plan')
    expect(JSON.stringify(data)).not.toContain('acceptance_criteria')
    const closed = await call('get_sprint_context', { sprint_id: closedSprint })
    expect(closed.sprint.status).toBe('CLOSED')
    expect(closed.stories).toEqual([])
  })

  it('returns one full large plan only when explicitly selected and rejects a wrong sprint', async () => {
    const data = await call('get_sprint_context', { sprint_id: firstSprint, task_id: ids('task1') })
    expect(data.selected_task.implementation_plan).toBe(fullPlan)
    expect(data.selected_task.story.acceptance_criteria).toBe('full acceptance criteria')
    expect((JSON.stringify(data).match(/implementation_plan/g) ?? []).length).toBe(1)
    const wrong = await client.callTool({ name: 'get_sprint_context', arguments: { sprint_id: secondSprint, task_id: ids('task1') } })
    expect(wrong.isError).toBe(true)
  })

  it('filters actual ideas by owner, product/global, archival and planned status', async () => {
    const data = await call('get_ideas_context', { product_id: product })
    expect(data.open_ideas.map((idea: { id: string }) => idea.id)).toEqual([ids('idea-global'), ids('idea-product')])
    expect(data.limit).toBe(50)
    expect(JSON.stringify(data)).not.toContain('description')
  })

  it('caps the ideas overview at the oldest 50 actual rows', async () => {
    await prisma.idea.createMany({ data: Array.from({ length: 52 }, (_, i) => ({ id: ids(`extra-${i}`), code: ids(`extra-${i}`), title: 'extra', user_id: owner, product_id: product, created_at: new Date(Date.UTC(2026, 2, i + 1)) })) })
    try {
      const data = await call('get_ideas_context', { product_id: product })
      expect(data.open_ideas).toHaveLength(50)
      expect(data.open_ideas[0].id).toBe(ids('idea-global'))
      expect(data.open_ideas[49].id).toBe(ids('extra-47'))
    } finally {
      await prisma.idea.deleteMany({ where: { user_id: owner, title: 'extra' } })
    }
  })

  it('delivers matching guides to both tools and isolates explicit models across calls', async () => {
    for (const [runtime, model_id, included, excluded] of [
      ['CODEX', 'gpt-6-astra', 'ASTRA INSTRUCTIONS', 'SOL INSTRUCTIONS'],
      ['CODEX', 'gpt-5.6-sol', 'SOL INSTRUCTIONS', 'ASTRA INSTRUCTIONS'],
      ['CLAUDE', 'claude-opus-5', 'OPUS INSTRUCTIONS', 'CODEX RUNTIME'],
    ]) {
      const args = { product_id: product, agent: { runtime, model_id: ` ${model_id} ` } }
      const context = await call('get_context', args), guide = await call('get_agent_guide', args)
      expect(context.agent_guide).toBe(guide.guide_md)
      expect(context.agent_context).toEqual(guide.agent_context)
      expect(context.agent_context.model_id).toBe(model_id)
      expect(context.agent_guide).toContain(included)
      expect(context.agent_guide).not.toContain(excluded)
      expect(context.agent_guide).not.toContain('REGISTRY NOTES')
      expect(context.agent_guide).not.toContain('OTHER PRODUCT INSTRUCTIONS')
      expect(context.agent_guide.endsWith('PRODUCT AGREEMENTS LAST')).toBe(true)
    }
    const neutral = await call('get_context', { product_id: product })
    expect(neutral.agent_context.runtime).toBeNull()
    expect(neutral.agent_guide).not.toContain('RUNTIME')
    const unknown = await call('get_context', { product_id: product, agent: { runtime: 'CODEX', model_id: 'unknown.future' } })
    expect(unknown.agent_context.model_id).toBe('unknown.future')
    expect(unknown.agent_context.display_name).toBeNull()
    expect(unknown.agent_guide).not.toContain('INSTRUCTIONS')
  })

  it('excludes inactive profile documents and disabled MANUAL while identifying an inactive registry row', async () => {
    const args = { product_id: product, agent: { runtime: 'CODEX', model_id: 'gpt-6-astra' } }
    await doc(`agent-guide-model-${ids('astra')}`, 'INACTIVE PROFILE', 'archived')
    try {
      const inactive = await call('get_context', args)
      expect(inactive.agent_context.display_name).toBe('gpt-6-astra')
      expect(inactive.agent_guide).not.toContain('INACTIVE PROFILE')
      await prisma.product.update({ where: { id: product }, data: { enabled_doc_folders: [] } })
      const disabled = await call('get_context', args)
      expect(disabled.agent_context.applied_profiles).toEqual([])
      expect(disabled.agent_guide).not.toMatch(/CODEX RUNTIME|PRODUCT AGREEMENTS LAST/)
    } finally {
      await prisma.product.update({ where: { id: product }, data: { enabled_doc_folders: ['MANUAL'] } })
      await doc(`agent-guide-model-${ids('astra')}`, 'ASTRA INSTRUCTIONS')
    }
  })

  it('preserves partial context on guide overflow, while get_agent_guide fails', async () => {
    await doc('agent-guide-runtime-codex', 'x'.repeat(16000))
    try {
      const args = { product_id: product, agent: { runtime: 'CODEX', model_id: 'gpt-6-astra' } }
      const context = await call('get_context', args)
      expect(context.active_sprints).toHaveLength(2)
      expect(context.agent_guide_error).toContain('AGENT_GUIDE_TOO_LARGE')
      expect(context.agent_context.applied_profiles).toBeNull()
      expect((await client.callTool({ name: 'get_agent_guide', arguments: args })).isError).toBe(true)
    } finally { await doc('agent-guide-runtime-codex', 'CODEX RUNTIME') }
  })

  it('allows a READ_ONLY member and refuses outsider or token-out-of-scope reads', async () => {
    const memberResult = await requestContext.run({ token: memberToken }, () => handleGetSprintContext({ sprint_id: firstSprint }))
    expect(body(memberResult).stories).toHaveLength(3)
    for (const token of [outsiderToken, scopedToken]) {
      const reads = await requestContext.run({ token }, () => Promise.all([
        handleGetContext({ product_id: product }), handleGetAgentGuide({ product_id: product }),
        handleGetSprintContext({ sprint_id: firstSprint, task_id: ids('task1') }), handleGetIdeasContext({ product_id: product }),
      ]))
      expect(reads.every(result => result.isError)).toBe(true)
      expect(JSON.stringify(reads)).not.toContain('full task description')
    }
  })
})
