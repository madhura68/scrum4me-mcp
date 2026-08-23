// Fase 3 §8 — Sweep/lease, incarnatie-scenario en verlopen-claim-protocol
// tegen een echte Postgres (TEST_DATABASE_URL; zonder env: skip).
//
// LET OP — dit bestand deelt de database met andere runs. sweepStaleQueueClaims()
// heeft géén filter op afzender: hij requeue't élke stale rij in agent_message.
// De assertions filteren op de eigen row.id en zijn daar dus ongevoelig voor,
// maar de sweep zelf muteert alles wat hij tegenkomt. Draai dit daarom niet
// gelijktijdig met een andere run tegen dezelfde database, en niet tegen een
// database waar rijen in staan die iemand anders nodig heeft.
//
// Concreet gemeten: draai je dit bestand parallel met
// queue-tools.integration.test.ts (vitest doet dat standaard), dan requeue't de
// sweep hier de rijen die de fase-2-eigenaarstests net claimed hebben gezet, en
// vallen daar 3–4 tests om met een wisselende samenstelling. Serieel draaien
// lost het volledig op — gebruik `npm run test:integration`, dat
// --no-file-parallelism meegeeft.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(async () => ({
    userId: 'u-queue-int',
    tokenId: 'integration-test',
    username: 'agent',
    isDemo: false,
  })),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))

import { prisma } from '../src/prisma.js'
import { sweepStaleQueueClaims } from '../src/queue/sweep.js'
import { refreshQueueLeases } from '../src/queue/lease-refresh.js'
import { getLease, registerLease, clearLeases } from '../src/queue/lease-register.js'
import { registerQueueDoneTool } from '../src/tools/queue-done.js'
import { registerMarkedConsumer } from '../src/tools/queue-register-consumer.js'
import { claimMarkedMessage } from '../src/tools/queue-claim-marked.js'
import { renewMarkedMessage } from '../src/tools/queue-renew-marked.js'
import { cancelMarkedMessage } from '../src/tools/queue-cancel-marked.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args) as Promise<ToolResult>,
  }
  registerQueueDoneTool(server as unknown as McpServer)
  return server
}

describeWithDatabase('fase 3 — sweep/lease (§8, TEST_DATABASE_URL)', () => {
  const createdIds: string[] = []

  async function insertClaimed(opts: { claimedBy: string; ageMinutes: number }) {
    const at = new Date(Date.now() - opts.ageMinutes * 60_000)
    const row = await prisma.agentMessage.create({
      data: {
        type: 'task',
        from_server: 'mac',
        from_model: 'claude',
        to_server: 'mac',
        to_model: 'claude',
        body: 'integration sweep test',
        meta: {},
        source: 'mcp',
        status: 'claimed',
        claimed_by: opts.claimedBy,
        claimed_at: at,
        started_at: at,
      },
    })
    createdIds.push(row.id)
    return row
  }

  beforeAll(() => {
    process.env.S4M_SERVER = 'mac'
    process.env.S4M_MODEL = 'claude'
  })

  beforeEach(() => {
    clearLeases()
  })

  afterAll(async () => {
    await prisma.agentMessage.deleteMany({ where: { in_reply_to: { in: createdIds } } })
    await prisma.agentMessage.deleteMany({ where: { id: { in: createdIds } } })
    await prisma.$disconnect()
  })

  it('sweep-idempotentie: twee opeenvolgende sweeps requeuen samen precies één keer', async () => {
    const row = await insertClaimed({ claimedBy: 'mcp:inst-a:tok-1', ageMinutes: 10 })
    const first = await sweepStaleQueueClaims()
    const second = await sweepStaleQueueClaims()
    const hits = [...first.requeued, ...second.requeued].filter((id) => id === row.id)
    expect(hits).toHaveLength(1)
    const after = await prisma.agentMessage.findUnique({ where: { id: row.id } })
    expect(after?.status).toBe('pending')
    expect(after?.claimed_by).toBeNull()
    expect(after?.claimed_at).toBeNull()
    expect(after?.started_at).toBeNull()
  })

  it('twee gelijktijdige sweeps requeuen samen precies één keer (SKIP LOCKED)', async () => {
    const row = await insertClaimed({ claimedBy: 'mcp:inst-a:tok-2', ageMinutes: 10 })
    const [a, b] = await Promise.all([sweepStaleQueueClaims(), sweepStaleQueueClaims()])
    const hits = [...a.requeued, ...b.requeued].filter((id) => id === row.id)
    expect(hits).toHaveLength(1)

    // Gemeten, niet aangenomen: de helft hierboven blijft óók groen als je SKIP
    // LOCKED weghaalt. Met kaal FOR UPDATE serialiseert de tweede sweep gewoon
    // en ziet hij daarna via EvalPlanQual dat de rij niet meer 'claimed' is —
    // zelfde uitkomst, alleen trager. Wat SKIP LOCKED écht koopt is dóórlopen
    // langs een rij die een ánder vasthoudt, en dat is alleen zichtbaar met een
    // lock die tíjdens de sweep blijft staan. Vandaar een tweede, externe
    // verbinding die de rij in een open transactie op slot zet.
    const locked = await insertClaimed({ claimedBy: 'mcp:inst-a:tok-2b', ageMinutes: 10 })
    const blocker = new Client({ connectionString: testDatabaseUrl })
    await blocker.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM agent_message WHERE id = $1 FOR UPDATE', [locked.id])
      // Mét SKIP LOCKED slaat de sweep de vergrendelde rij over en keert direct
      // terug; zónder blokkeert hij tot de blocker loslaat — in de praktijk tot
      // de Prisma-transactietimeout, en dan gaat deze regel stuk op een fout.
      const swept = await sweepStaleQueueClaims()
      expect(swept.requeued).not.toContain(locked.id)
    } finally {
      await blocker.end()
    }
    // Slot weg → dezelfde rij is nog steeds gewoon stale en wordt alsnog
    // gerequeued. Dat pint vast dat het overslaan hierboven aan het slot lag en
    // niet aan een filter dat de rij sowieso al buitensloot.
    const afterUnlock = await sweepStaleQueueClaims()
    expect(afterUnlock.requeued).toContain(locked.id)
  })

  it('een levende lease wordt nooit gerequeued, ook niet voorbij het reclaim-window', async () => {
    const claimedBy = 'mcp:inst-a:tok-levend'
    const row = await insertClaimed({ claimedBy, ageMinutes: 5 * 60 })
    registerLease(row.id, { claimToken: 'tok-levend', claimedBy })
    await refreshQueueLeases()
    const swept = await sweepStaleQueueClaims()
    expect(swept.requeued).not.toContain(row.id)
    const after = await prisma.agentMessage.findUnique({ where: { id: row.id } })
    expect(after?.status).toBe('claimed')
    expect(after?.claimed_by).toBe(claimedBy)
  })

  it('incarnatie-scenario: B met dezelfde stabiele instance-config beschermt A\'s claim niet', async () => {
    // A claimde en stierf; B start direct met dezelfde instance-id in de
    // config. B's register is per definitie leeg (lease is per incarnatie),
    // dus B ververst niets van A en de sweep requeue't binnen de drempel.
    const row = await insertClaimed({ claimedBy: 'mcp:stabiele-instance:tok-a', ageMinutes: 6 })
    clearLeases()
    await refreshQueueLeases()
    const swept = await sweepStaleQueueClaims()
    expect(swept.requeued).toContain(row.id)

    // Gemeten, niet aangenomen: bovenstaande assertie is ongevoelig voor de
    // where-clause van refreshQueueLeases. Bij een leeg register draait de lus
    // nul keer, dus hij blijft ook groen als je `claimed_by: claimedBy`
    // vervangt door een losse 'mcp:'-prefixtest. En zelfs met een gevuld
    // register kan de refresh A's rij niet raken, want `id: messageId` sluit
    // vreemde rijen al uit. De scherpe vorm van hetzelfde contract is een B die
    // wél een entry voor dít bericht heeft terwijl de rij inmiddels van een
    // ander mcp-proces is: B mag die claim niet verversen (en dus niet
    // beschermen) en moet zijn eigen entry snoeien. Dat vraagt strikte
    // gelijkheid op claimed_by — een prefixtest matcht hier wél en verlengt
    // andermans claim.
    const vanB = await insertClaimed({ claimedBy: 'mcp:inst-b:tok-b', ageMinutes: 6 })
    const voor = await prisma.agentMessage.findUnique({ where: { id: vanB.id } })
    registerLease(vanB.id, { claimToken: 'tok-a', claimedBy: 'mcp:inst-a:tok-a' })
    await refreshQueueLeases()
    const na = await prisma.agentMessage.findUnique({ where: { id: vanB.id } })
    expect(na?.claimed_at?.getTime()).toBe(voor?.claimed_at?.getTime())
    expect(getLease(vanB.id)).toBeUndefined()
    const sweptB = await sweepStaleQueueClaims()
    expect(sweptB.requeued).toContain(vanB.id)
  })

  it('CLI-claims: binnen 4 h met rust gelaten, daarbuiten gerequeued', async () => {
    const jong = await insertClaimed({ claimedBy: 'mac:12345', ageMinutes: 3 * 60 })
    const oud = await insertClaimed({ claimedBy: 'mac:12345', ageMinutes: 5 * 60 })
    const swept = await sweepStaleQueueClaims()
    expect(swept.requeued).not.toContain(jong.id)
    expect(swept.requeued).toContain(oud.id)
  })

  it('complete marked claims overleven zowel de 5-minuten- als 4-uurs-sweep', async () => {
    const familyId = randomUUID()
    const runId = randomUUID()
    const consumerId = randomUUID()
    const fence = '9'.repeat(64)
    const messageIds = [randomUUID(), randomUUID()]
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO ppe_bootstrap_family (id,family_key,current_ordinal,updated_at)
         VALUES ($1,$2,1,now())`, familyId, `b3-sweep-${familyId}`,
      )
      await prisma.$executeRawUnsafe(
        `INSERT INTO ppe_run_registry
          (run_id,family_id,ordinal,invocation_operation_key,invocation_payload_sha256,
           principal,state,generation,registry_receipt_sha256,updated_at)
         VALUES ($1,$2,1,$3,$4,$5,'ACTIVE',1,$6,now())`,
        runId, familyId, `bootstrap:${runId}`, 'a'.repeat(64),
        `orchestrator:${runId}`, 'b'.repeat(64),
      )
      await prisma.$executeRawUnsafe(
        `INSERT INTO ppe_orchestrator_lease
          (run_id,generation,owner_principal,lease_expires_at,fence_sha256,status,updated_at)
         VALUES ($1,1,$2,now()+interval '1 hour',$3,'CURRENT',now())`,
        runId, `orchestrator:${runId}`, fence,
      )
      await prisma.$executeRawUnsafe(
        `INSERT INTO ppe_consumer
          (consumer_id,run_id,lane,generation,operation_key,config_sha256,
           attestation_sha256,status,heartbeat_at,updated_at)
         VALUES ($1,$2,'lane-codex',1,$3,$4,$5,'READY_ACK',now(),now())`,
        consumerId, runId, `consumer:${runId}`, 'c'.repeat(64), 'd'.repeat(64),
      )
      for (const [index, messageId] of messageIds.entries()) {
        const age = index === 0 ? '10 minutes' : '5 hours'
        await prisma.$executeRawUnsafe(
          `INSERT INTO agent_message
            (id,type,from_server,from_model,to_server,to_model,body,meta,source,status,
             claimed_by,claimed_at,started_at,ppe_protocol,ppe_run_id,ppe_operation_key,
             ppe_payload_sha256,ppe_from_principal,ppe_to_consumer_id,
             ppe_consumer_generation,ppe_lease_generation)
           VALUES ($1,'task','mac','codex','scrum4me-server','codex',$2,'{}','mcp','claimed',
             $3,now()-$4::interval,now()-$4::interval,'parallel-plan-execution/v1',$5,$6,
             $7,$8,$9,1,1)`,
          messageId, `marked sweep ${index}`, `marked:${consumerId}`, age, runId,
          `marked-sweep:${messageId}`, 'e'.repeat(64), `orchestrator:${runId}`, consumerId,
        )
        await prisma.$executeRawUnsafe(
          `INSERT INTO ppe_claim_lease
            (message_id,run_id,consumer_id,consumer_generation,lease_generation,
             token_sha256,status,claimed_at,updated_at)
           VALUES ($1,$2,$3,1,1,$4,'CURRENT',now()-$5::interval,now())`,
          messageId, runId, consumerId, 'f'.repeat(64), age,
        )
      }
      const swept = await sweepStaleQueueClaims()
      expect(swept.requeued).not.toContain(messageIds[0])
      expect(swept.requeued).not.toContain(messageIds[1])
      const rows = await prisma.agentMessage.findMany({ where: { id: { in: messageIds } } })
      expect(rows.map((row) => row.status)).toEqual(['claimed', 'claimed'])
    } finally {
      await prisma.ppeClaimLease.deleteMany({ where: { message_id: { in: messageIds } } })
      await prisma.agentMessage.deleteMany({ where: { id: { in: messageIds } } })
      await prisma.ppeConsumer.deleteMany({ where: { consumer_id: consumerId } })
      await prisma.ppeOrchestratorLease.deleteMany({ where: { run_id: runId } })
      await prisma.ppeRunRegistry.deleteMany({ where: { run_id: runId } })
      await prisma.ppeBootstrapFamily.deleteMany({ where: { id: familyId } })
    }
  })

  it('marked MCP-tools vergelijken alle fences en slaan alleen de tokenhash op', async () => {
    const familyId = randomUUID()
    const runId = randomUUID()
    const fence = '7'.repeat(64)
    const messageIds = [randomUUID(), randomUUID()]
    let consumerId = ''
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO ppe_bootstrap_family (id,family_key,current_ordinal,updated_at)
         VALUES ($1,$2,1,now())`, familyId, `b3-tools-${familyId}`,
      )
      await prisma.$executeRawUnsafe(
        `INSERT INTO ppe_run_registry
          (run_id,family_id,ordinal,invocation_operation_key,invocation_payload_sha256,
           principal,state,generation,registry_receipt_sha256,updated_at)
         VALUES ($1,$2,1,$3,$4,$5,'ACTIVE',1,$6,now())`,
        runId, familyId, `bootstrap:${runId}`, 'a'.repeat(64),
        `orchestrator:${runId}`, 'b'.repeat(64),
      )
      await prisma.$executeRawUnsafe(
        `INSERT INTO ppe_orchestrator_lease
          (run_id,generation,owner_principal,lease_expires_at,fence_sha256,status,updated_at)
         VALUES ($1,1,$2,now()+interval '1 hour',$3,'CURRENT',now())`,
        runId, `orchestrator:${runId}`, fence,
      )
      const consumer = await registerMarkedConsumer({
        run_id: runId, run_generation: 1, orchestrator_generation: 1,
        fence_sha256: fence, lane: 'lane-codex', generation: 1,
        operation_key: `register:${runId}`, config_sha256: 'c'.repeat(64),
        attestation_sha256: 'd'.repeat(64),
      })
      consumerId = consumer.consumer_id
      expect((await registerMarkedConsumer({
        run_id: runId, run_generation: 1, orchestrator_generation: 1,
        fence_sha256: fence, lane: 'lane-codex', generation: 1,
        operation_key: `register:${runId}`, config_sha256: 'c'.repeat(64),
        attestation_sha256: 'd'.repeat(64),
      })).consumer_id).toBe(consumerId)
      await expect(registerMarkedConsumer({
        run_id: runId, run_generation: 1, orchestrator_generation: 1,
        fence_sha256: fence, lane: 'lane-codex', generation: 1,
        operation_key: `register:${runId}`, config_sha256: 'f'.repeat(64),
        attestation_sha256: 'd'.repeat(64),
      })).rejects.toThrow('PPE_OPERATION_KEY_REUSE')
      for (const [index, messageId] of messageIds.entries()) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO agent_message
            (id,type,from_server,from_model,to_server,to_model,body,meta,source,status,
             ppe_protocol,ppe_run_id,ppe_operation_key,ppe_payload_sha256,
             ppe_from_principal,ppe_to_consumer_id,ppe_consumer_generation)
           VALUES ($1,'task','mac','codex','scrum4me-server','codex',$2,'{}','mcp','pending',
             'parallel-plan-execution/v1',$3,$4,$5,$6,$7,1)`,
          messageId, `marked tool ${index}`, runId, `tool:${messageId}`,
          'e'.repeat(64), `orchestrator:${runId}`, consumerId,
        )
      }
      const auth = {
        run_id: runId, run_generation: 1, orchestrator_generation: 1,
        fence_sha256: fence, consumer_id: consumerId, consumer_generation: 1,
      }
      await expect(claimMarkedMessage({
        ...auth, fence_sha256: '8'.repeat(64), types: ['task'],
      })).rejects.toThrow('PPE_FENCE_MISMATCH')
      const claim = (await claimMarkedMessage({ ...auth, types: ['task'] }))!
      expect(claim.message.id).toBe(messageIds[0])
      const stored = await prisma.ppeClaimLease.findUnique({
        where: { message_id_lease_generation: {
          message_id: messageIds[0], lease_generation: BigInt(claim.lease_generation),
        } },
      })
      expect(stored?.token_sha256).not.toBe(claim.claim_token)
      await expect(renewMarkedMessage({
        ...auth, message_id: messageIds[0], lease_generation: claim.lease_generation,
        claim_token: 'wrong',
      })).rejects.toThrow('PPE_CLAIM_FENCE')
      expect(await renewMarkedMessage({
        ...auth, message_id: messageIds[0], lease_generation: claim.lease_generation,
        claim_token: claim.claim_token,
      })).toBe(true)
      expect(await cancelMarkedMessage({
        ...auth, message_id: messageIds[0], expected_status: 'claimed',
        lease_generation: claim.lease_generation, claim_token: claim.claim_token,
      })).toBe(true)
      expect(await cancelMarkedMessage({
        ...auth, message_id: messageIds[1], expected_status: 'pending',
      })).toBe(true)
    } finally {
      await prisma.ppeClaimLease.deleteMany({ where: { message_id: { in: messageIds } } })
      await prisma.agentMessage.deleteMany({ where: { id: { in: messageIds } } })
      if (consumerId) await prisma.ppeConsumer.deleteMany({ where: { consumer_id: consumerId } })
      await prisma.ppeOrchestratorLease.deleteMany({ where: { run_id: runId } })
      await prisma.ppeRunRegistry.deleteMany({ where: { run_id: runId } })
      await prisma.ppeBootstrapFamily.deleteMany({ where: { id: familyId } })
    }
  })

  it('emit een byte-compatibele NotifyEnvelope op agent_queue bij requeue', async () => {
    const row = await insertClaimed({ claimedBy: 'mcp:inst-a:tok-notify', ageMinutes: 10 })
    const listener = new Client({ connectionString: testDatabaseUrl })
    await listener.connect()
    const payloads: string[] = []
    listener.on('notification', (n) => {
      if (n.channel === 'agent_queue' && n.payload) payloads.push(n.payload)
    })
    await listener.query('LISTEN agent_queue')
    try {
      await sweepStaleQueueClaims()
      await vi.waitFor(() => {
        expect(payloads.some((p) => p.includes(row.id))).toBe(true)
      })
      const payload = payloads.find((p) => p.includes(row.id))
      expect(payload).toBe(
        JSON.stringify({
          id: row.id,
          type: 'task',
          from_server: 'mac',
          from_model: 'claude',
          to_server: 'mac',
          to_model: 'claude',
          in_reply_to: null,
          status: 'pending',
          previous_status: 'claimed',
        }),
      )
    } finally {
      await listener.end()
    }
  })

  it('verlopen-claim-protocol: done mét token na sweep-requeue → QUEUE_CLAIM_EXPIRED (pending)', async () => {
    const row = await insertClaimed({ claimedBy: 'mcp:inst-a:tok-verlopen', ageMinutes: 10 })
    clearLeases()
    await sweepStaleQueueClaims()
    const server = makeServer()
    const result = await server.call({ message_id: row.id, claim_token: 'tok-verlopen' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^QUEUE_CLAIM_EXPIRED/)
  })

  it('herclaimd door een ander: done met eigen (nog geregistreerd) token → QUEUE_NOT_CLAIMER', async () => {
    const row = await insertClaimed({ claimedBy: 'mcp:inst-b:tok-van-b', ageMinutes: 0 })
    registerLease(row.id, { claimToken: 'tok-van-a', claimedBy: 'mcp:inst-a:tok-van-a' })
    const server = makeServer()
    const result = await server.call({ message_id: row.id, claim_token: 'tok-van-a' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^QUEUE_NOT_CLAIMER/)
  })

  it('tokenloze FIFO-bypass-reply op een gerequeued (pending) request blijft werken', async () => {
    const row = await insertClaimed({ claimedBy: 'mcp:inst-a:tok-bypass', ageMinutes: 10 })
    clearLeases()
    await sweepStaleQueueClaims()
    const server = makeServer()
    const result = await server.call({ message_id: row.id, reply: 'alsnog beantwoord' })
    expect(result.isError).toBeFalsy()
    const replies = await prisma.agentMessage.findMany({ where: { in_reply_to: row.id } })
    expect(replies).toHaveLength(1)
    expect(replies[0].body).toBe('alsnog beantwoord')
    createdIds.push(replies[0].id)
  })
})
