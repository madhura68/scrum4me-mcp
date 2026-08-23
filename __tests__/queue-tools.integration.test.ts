// Fase 2 §8 — correlatie-race, claim-atomiciteit, idempotente-read-voortgang,
// eigenaarscontract-precedentiematrix en delivery/cancel tegen een echte
// Postgres (TEST_DATABASE_URL; zonder env: skip). Vereist de fase-1-migratie
// (agent_message-tabel met source='mcp' in de CHECK). Tests draaien serieel
// binnen dit bestand; FIFO-gevoelige stappen asserteren daarom expliciet
// wélke rij geclaimd werd.
//
// Serieel bínnen dit bestand is niet genoeg: queue-sweep-lease.integration.test.ts
// roept sweepStaleQueueClaims() aan, die élke stale rij in de tabel requeue't —
// ook de rijen die de eigenaarstests hieronder net op 'claimed' hebben gezet.
// Parallel draaien laat hier 3–4 tests wisselend omvallen. Draai integratietests
// daarom met `npm run test:integration` (--no-file-parallelism).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl
process.env.S4M_SERVER = 'mac'
process.env.S4M_MODEL = 'claude'

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
import { claimNextReply, claimNextRequest, rollbackQueueClaim } from '../src/queue/claim.js'
import { clearLeases, getLease, registerLease } from '../src/queue/lease-register.js'
import { registerQueuePushTool } from '../src/tools/queue-push.js'
import { registerQueueWaitReplyTool } from '../src/tools/queue-wait-reply.js'
import { registerQueueNextTool } from '../src/tools/queue-next.js'
import { registerQueueDoneTool } from '../src/tools/queue-done.js'
import { registerQueueFailTool } from '../src/tools/queue-fail.js'
import { registerQueueListTool } from '../src/tools/queue-list.js'
import { registerQueueStatusTool } from '../src/tools/queue-status.js'
import { refreshQueueLeases } from '../src/queue/lease-refresh.js'
import { sweepStaleQueueClaims } from '../src/queue/sweep.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

type ToolResult = { isError?: boolean; content: { text: string }[] }
type Extra = { signal?: AbortSignal }
type Handler = (args: Record<string, unknown>, extra?: Extra) => Promise<ToolResult>

function capture(register: (s: McpServer) => void): Handler {
  let handler: Handler | undefined
  register({
    registerTool: vi.fn((_n: string, _m: unknown, fn: Handler) => {
      handler = fn
    }),
  } as unknown as McpServer)
  return (args, extra) => handler!(args, extra)
}

const push = capture(registerQueuePushTool)
const waitReply = capture(registerQueueWaitReplyTool)
const next = capture(registerQueueNextTool)
const done = capture(registerQueueDoneTool)
const fail = capture(registerQueueFailTool)
const list = capture(registerQueueListTool)
const status = capture(registerQueueStatusTool)

const MARKER = `queue-int-${randomUUID()}`
const mark = (text: string) => `${MARKER} ${text}`
const parse = (result: ToolResult) => JSON.parse(result.content[0].text) as Record<string, any>

async function insertReply(requestId: string, text: string) {
  return prisma.agentMessage.create({
    data: {
      type: 'data',
      from_server: 'scrum4me-server',
      from_model: 'claude',
      to_server: 'mac',
      to_model: 'claude',
      body: mark(text),
      meta: {},
      source: 'cli',
      status: 'pending',
      in_reply_to: requestId,
    },
  })
}

async function insertRequest(text: string, toModel: 'claude' | 'codex' = 'claude') {
  return prisma.agentMessage.create({
    data: {
      type: 'info',
      from_server: 'max2',
      from_model: 'codex',
      to_server: 'mac',
      to_model: toModel,
      body: mark(text),
      meta: {},
      source: 'cli',
      status: 'pending',
    },
  })
}

describeWithDatabase('fase 2 — queue-tools integratie (§8, TEST_DATABASE_URL)', () => {
  beforeEach(() => clearLeases())

  afterAll(async () => {
    await prisma.agentMessage.deleteMany({ where: { body: { contains: MARKER } } })
  })

  it('correlatie-race: elke sessie krijgt het antwoord op zijn éigen request (replies in omgekeerde volgorde)', async () => {
    const a = parse(await push({ to: 'scrum4me-server:claude', type: 'info', body: mark('req A') }))
    const b = parse(await push({ to: 'scrum4me-server:claude', type: 'info', body: mark('req B') }))
    await insertReply(b.message_id, 'antwoord B')
    await insertReply(a.message_id, 'antwoord A')

    const ra = parse(await waitReply({ message_ids: [a.message_id], wait_seconds: 0 }))
    expect(ra.status).toBe('ok')
    expect(ra.replies).toHaveLength(1)
    expect(ra.replies[0].in_reply_to).toBe(a.message_id)
    expect(ra.replies[0].body).toContain('antwoord A')

    const rb = parse(await waitReply({ message_ids: [b.message_id], wait_seconds: 0 }))
    expect(rb.replies[0].in_reply_to).toBe(b.message_id)
    expect(rb.replies[0].body).toContain('antwoord B')
  })

  it('claim-atomiciteit: exact één winnaar bij parallelle claims; idempotente read levert de verliezer dezelfde reply', async () => {
    const req = parse(await push({ to: 'scrum4me-server:claude', type: 'info', body: mark('req parallel') }))
    const reply = await insertReply(req.message_id, 'antwoord parallel')

    const winners = await Promise.all([
      claimNextReply({ server: 'mac', model: 'claude', messageIds: [req.message_id], claimedBy: 'mcp:int-a' }),
      claimNextReply({ server: 'mac', model: 'claude', messageIds: [req.message_id], claimedBy: 'mcp:int-b' }),
    ])
    expect(winners.filter((w) => w !== null)).toHaveLength(1)

    const again = parse(await waitReply({ message_ids: [req.message_id], wait_seconds: 0 }))
    expect(again.status).toBe('ok')
    expect(again.replies[0].id).toBe(reply.id)
  })

  it('idempotente-read-voortgang: twee al-done replies komen samen in één respons (§5.2)', async () => {
    const c = parse(await push({ to: 'scrum4me-server:claude', type: 'info', body: mark('req C') }))
    const d = parse(await push({ to: 'scrum4me-server:claude', type: 'info', body: mark('req D') }))
    await insertReply(c.message_id, 'antwoord C')
    await insertReply(d.message_id, 'antwoord D')

    const first = parse(await waitReply({ message_ids: [c.message_id, d.message_id], wait_seconds: 0 }))
    expect(first.replies).toHaveLength(2)

    const second = parse(await waitReply({ message_ids: [c.message_id, d.message_id], wait_seconds: 0 }))
    expect(second.status).toBe('ok')
    expect(second.replies.map((r: { in_reply_to: string }) => r.in_reply_to).sort())
      .toEqual([c.message_id, d.message_id].sort())
  })

  it('eigenaarscontract: afronden met het eigen lokaal geregistreerde token slaagt (stap c slaagt)', async () => {
    const row = await insertRequest('own claim')
    const claimed = parse(await next({ wait_seconds: 0 }))
    expect(claimed.status).toBe('claimed')
    expect(claimed.message.id).toBe(row.id)
    const result = parse(await done({
      message_id: row.id, reply: mark('klaar'), claim_token: claimed.claim_token,
    }))
    expect(result.status).toBe('done')
    expect(result.reply_id).toBeTruthy()
    expect(getLease(row.id)).toBeUndefined()
  })

  it('proces B met A-token → QUEUE_CLAIM_EXPIRED, óók binnen het lease-venster (stap a)', async () => {
    const row = await insertRequest('incarnatie')
    const claimed = parse(await next({ wait_seconds: 0 }))
    expect(claimed.message.id).toBe(row.id)
    clearLeases() // nieuwe proces-incarnatie: in-memory register is leeg
    const res = await done({ message_id: row.id, claim_token: claimed.claim_token })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('QUEUE_CLAIM_EXPIRED')
  })

  it('mét token op een gerequeued (pending) bericht → QUEUE_CLAIM_EXPIRED; tokenloze bypass-reply blijft werken', async () => {
    const row = await insertRequest('requeue')
    const claimed = parse(await next({ wait_seconds: 0 }))
    expect(claimed.message.id).toBe(row.id)
    await prisma.agentMessage.update({
      where: { id: row.id },
      data: { status: 'pending', claimed_by: null, claimed_at: null, started_at: null },
    })
    clearLeases()
    const zombie = await done({ message_id: row.id, claim_token: claimed.claim_token })
    expect(zombie.isError).toBe(true)
    expect(zombie.content[0].text).toContain('QUEUE_CLAIM_EXPIRED')
    const bypass = parse(await done({ message_id: row.id, reply: mark('bypass-reply') }))
    expect(bypass.status).toBe('done')
  })

  it('entry aanwezig maar verkeerd token → QUEUE_NOT_CLAIMER (stap b)', async () => {
    const row = await insertRequest('verkeerd token')
    const claimed = parse(await next({ wait_seconds: 0 }))
    expect(claimed.message.id).toBe(row.id)
    const res = await done({ message_id: row.id, claim_token: 'niet-het-token' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('herclaim door een ander (CLI) ondanks lokale entry → QUEUE_NOT_CLAIMER (stap c)', async () => {
    const row = await insertRequest('cli herclaim')
    await prisma.agentMessage.update({
      where: { id: row.id },
      data: { status: 'claimed', claimed_by: 'mac:12345', claimed_at: new Date(), started_at: new Date() },
    })
    registerLease(row.id, { claimToken: 'tok-c', claimedBy: 'mcp:int:tok-c' })
    const res = await done({ message_id: row.id, claim_token: 'tok-c' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('tokenloze done op een CLI-geclaimde rij → QUEUE_NOT_CLAIMER (MCP rondt claims van anderen nooit af)', async () => {
    const row = await insertRequest('cli claim tokenloos')
    await prisma.agentMessage.update({
      where: { id: row.id },
      data: { status: 'claimed', claimed_by: 'mac:67890', claimed_at: new Date(), started_at: new Date() },
    })
    const res = await done({ message_id: row.id })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('cancel vóór de claim: er wordt niets geclaimd (mac:codex, geïsoleerd)', async () => {
    const row = await insertRequest('cancel vooraf', 'codex')
    const ac = new AbortController()
    ac.abort()
    const res = parse(await next({ wait_seconds: 0, as: 'codex' }, { signal: ac.signal }))
    expect(res.status).toBe('timeout')
    const after = await prisma.agentMessage.findUnique({ where: { id: row.id } })
    expect(after?.status).toBe('pending')
    // Opruimen zodat de volgende cancel-test een lege codex-queue heeft.
    await prisma.agentMessage.delete({ where: { id: row.id } })
  })

  it('cancel tijdens de wait: keert snel terug zonder claim (mac:codex, lege queue)', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const started = Date.now()
    const res = parse(await next({ wait_seconds: 8, as: 'codex' }, { signal: ac.signal }))
    expect(res.status).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(6000)
  })

  it('cancel ná de claim-transactie: rollbackQueueClaim zet claimed → pending, alleen bij exacte claimed_by-match', async () => {
    const row = await insertRequest('cancel na claim', 'codex')
    const claimed = await claimNextRequest({ server: 'mac', model: 'codex', claimedBy: 'mcp:int:tok-r' })
    expect(claimed?.id).toBe(row.id)
    await rollbackQueueClaim(row.id, 'iemand-anders') // verkeerde eigenaar: no-op
    let after = await prisma.agentMessage.findUnique({ where: { id: row.id } })
    expect(after?.status).toBe('claimed')
    await rollbackQueueClaim(row.id, 'mcp:int:tok-r') // eigenaar: rollback
    after = await prisma.agentMessage.findUnique({ where: { id: row.id } })
    expect(after?.status).toBe('pending')
    expect(after?.claimed_by).toBeNull()
  })

  it('queue_push vult meta.task.repo automatisch via git remote get-url origin', async () => {
    const res = parse(await push({
      to: 'scrum4me-server:claude',
      type: 'task',
      body: mark('task autofill'),
      cwd: process.cwd(),
      meta: { task: { objective: 'o', verification: 'v', response_format: 'rf' } },
    }))
    const row = await prisma.agentMessage.findUnique({ where: { id: res.message_id } })
    const task = (row?.meta as { task?: { repo?: string; cwd?: string } } | null)?.task
    expect(task?.cwd).toBe(process.cwd())
    expect(task?.repo).toContain('scrum4me-mcp')
  })
})

// Aanvullend op de §8-scenario's hierboven (letterlijk uit het fase-2-plan
// overgenomen): vier gedragingen die mutation testing markeerde als
// "onzichtbaar voor een gemockte Prisma-client" — de mock geeft altijd zijn
// fixture terug, ongeacht wat de query zegt, dus alleen een echte Postgres
// kan deze vier bewijzen. Elke test hieronder is vlak vóór oplevering ook
// echt tegen een moedwillig kapotgemaakte bronregel gedraaid (zie het
// taakrapport) om te bevestigen dat hij ook daadwerkelijk rood gaat.
describeWithDatabase('fase 2 — queue-tools integratie (aanvullend: mutation-testing-blinde-vlekken)', () => {
  beforeEach(() => clearLeases())

  afterAll(async () => {
    await prisma.agentMessage.deleteMany({ where: { body: { contains: MARKER } } })
  })

  it('previous_status komt uit de PRE-update rij, niet uit de nieuwe status (claimNextRequest én claimNextReply)', async () => {
    // Tegen een mock is dit onzichtbaar: elke fixture retourneert precies het
    // veld dat de test erin stopt. Hier berekent de SQL zelf previous_status
    // via de target-CTE (vóór de UPDATE) — alleen een echte query kan die
    // waarde fout krijgen door "updated.status" i.p.v. "target.status".
    const row = await insertRequest('previous-status verzoek')
    const claimedReq = await claimNextRequest({
      server: 'mac', model: 'claude', claimedBy: 'mcp:int:prevstatus-req',
    })
    expect(claimedReq?.id).toBe(row.id)
    expect(claimedReq?.status).toBe('claimed')
    expect(claimedReq?.previous_status).toBe('pending')

    await insertReply(row.id, 'previous-status antwoord')
    const claimedReply = await claimNextReply({
      server: 'mac', model: 'claude', messageIds: [row.id], claimedBy: 'mcp:int:prevstatus-reply',
    })
    expect(claimedReply?.status).toBe('done')
    expect(claimedReply?.previous_status).toBe('pending')

    // Terminaliseren zodat deze rij geen stale-maar-'claimed' landmijn wordt
    // voor de reclaim-test hierna (status 'done' is onder geen enkel
    // reclaim-interval nog claimbaar).
    await prisma.agentMessage.update({ where: { id: row.id }, data: { status: 'done', finished_at: new Date() } })
  })

  it('reclaim-interval bereikt de query: S4M_RECLAIM_DEFAULT wint het van de hardgecodeerde default', async () => {
    // reclaimInterval() had al eigen (gemockte) tests, en claim.ts had al een
    // gemockte test die checkt dát reclaimInterval()'s uitkomst als parameter
    // wordt doorgegeven — maar geen van beide bewijst dat de waarde de
    // WHERE-clause ook echt stuurt. Hier draait de vergelijking op een
    // werkelijke 'now() - claimed_at < interval' tegen een echt backdated
    // timestamp.
    const row = await insertRequest('reclaim interval')
    const first = await claimNextRequest({ server: 'mac', model: 'claude', claimedBy: 'mcp:int:reclaim-first' })
    expect(first?.id).toBe(row.id)

    await prisma.agentMessage.update({
      where: { id: row.id },
      data: { claimed_at: new Date(Date.now() - 10_000) },
    })

    // Default (4 uur): 10 seconden oud is nog lang niet stale.
    const stillLocked = await claimNextRequest({
      server: 'mac', model: 'claude', claimedBy: 'mcp:int:reclaim-second',
    })
    expect(stillLocked).toBeNull()

    const prevEnv = process.env.S4M_RECLAIM_DEFAULT
    try {
      process.env.S4M_RECLAIM_DEFAULT = '3 seconds'
      const reclaimed = await claimNextRequest({
        server: 'mac', model: 'claude', claimedBy: 'mcp:int:reclaim-third',
      })
      expect(reclaimed?.id).toBe(row.id)
      expect(reclaimed?.claimed_by).toBe('mcp:int:reclaim-third')
      expect(reclaimed?.previous_status).toBe('claimed')
    } finally {
      if (prevEnv === undefined) delete process.env.S4M_RECLAIM_DEFAULT
      else process.env.S4M_RECLAIM_DEFAULT = prevEnv
    }

    await prisma.agentMessage.update({ where: { id: row.id }, data: { status: 'done', finished_at: new Date() } })
  })

  it('queue_next claimt alleen verzoek-types; een antwoord-type dat toevallig aan mij gericht staat blijft liggen', async () => {
    // Swapping QUEUE_REQUEST_TYPES <-> QUEUE_RESPONSE_TYPES in claimNextRequest
    // liet vroeger negen gemockte tests groen (de mock antwoordt hoe dan ook
    // met zijn fixture). Hier staat een écht antwoord-type-bericht in de
    // queue en moet het NIET geclaimd worden door queue_next.
    const anchor = await insertRequest('anchor voor dwaalantwoord-FK', 'codex') // eigen queue, geen FIFO-invloed
    const stray = await insertReply(anchor.id, 'dwaalantwoord zonder eigen verzoek')

    const timeoutRes = parse(await next({ wait_seconds: 0 }))
    expect(timeoutRes.status).toBe('timeout')
    const strayAfter = await prisma.agentMessage.findUnique({ where: { id: stray.id } })
    expect(strayAfter?.status).toBe('pending')

    const row = await insertRequest('echt verzoek ná het dwaalantwoord')
    const claimedRes = parse(await next({ wait_seconds: 0 }))
    expect(claimedRes.status).toBe('claimed')
    expect(claimedRes.message.id).toBe(row.id)

    const doneRes = parse(await done({ message_id: row.id, claim_token: claimedRes.claim_token }))
    expect(doneRes.status).toBe('done')
  })

  it('doneWithReply-atomiciteit: een fout vlak vóór de done-update rolt de reply-insert mee terug (echte Postgres-transactiegrens, geen mock)', async () => {
    // Tegen een gemockte tx-client is er geen transactiegrens om te
    // observeren: splits je de reply-insert en de done-update in twee losse
    // prisma.$transaction()-calls, dan blijven alle unit-tests groen omdat de
    // mock nooit een echte COMMIT/ROLLBACK ziet. Hier forceert een
    // tijdelijke trigger op precies de done-UPDATE een echte Postgres-fout,
    // en checken we dat de eerder in dezelfde transactie ingevoegde
    // reply-rij daar samen mee terugrolt.
    const row = await insertRequest('atomiciteit')
    const claimed = parse(await next({ wait_seconds: 0 }))
    expect(claimed.message.id).toBe(row.id)

    const guardFn = 'queue_int_test_block_done'
    const guardTrg = 'queue_int_test_trg'
    async function removeGuard() {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${guardTrg} ON agent_message`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${guardFn}()`)
    }
    await removeGuard() // idempotente veiligheidsnet tegen een eerdere afgebroken run
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION ${guardFn}() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${row.id}'::uuid AND NEW.status = 'done' THEN
          RAISE EXCEPTION 'queue_int_test: forced failure between reply-insert and done-update';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${guardTrg} BEFORE UPDATE ON agent_message
      FOR EACH ROW EXECUTE FUNCTION ${guardFn}();
    `)

    try {
      const res = await done({
        message_id: row.id, reply: mark('reply die niet los mag overleven'), claim_token: claimed.claim_token,
      })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toContain('queue_int_test')

      // Atomiciteit: de INSERT (reply) zat in dezelfde transactie als de
      // UPDATE die faalde — Postgres rolt allebei terug. Geen wees-reply, de
      // request blijft in de staat van vóór de poging (claimed, niet done).
      const orphan = await prisma.agentMessage.findFirst({ where: { in_reply_to: row.id } })
      expect(orphan).toBeNull()
      const after = await prisma.agentMessage.findUnique({ where: { id: row.id } })
      expect(after?.status).toBe('claimed')
    } finally {
      await removeGuard()
    }

    // Controlegroep: met de guard weg slaagt exact dezelfde afronding alsnog
    // — de fout hierboven kwam aantoonbaar van de trigger, niet van iets
    // anders. De lease leeft nog (releaseLease() werd op het foutpad nooit
    // bereikt, want dat zit ná de succes-return in queue-done.ts).
    const retry = parse(await done({
      message_id: row.id, reply: mark('reply die nu wel mag overleven'), claim_token: claimed.claim_token,
    }))
    expect(retry.status).toBe('done')
    expect(retry.reply_id).toBeTruthy()
    const survivor = await prisma.agentMessage.findUnique({ where: { id: retry.reply_id } })
    expect(survivor?.body).toContain('reply die nu wel mag overleven')
  })
})

interface MarkedFixture {
  familyId: string
  runId: string
  consumerId: string
  requestId: string
}

async function seedMarkedRequest(label: string): Promise<MarkedFixture> {
  const familyId = randomUUID()
  const runId = randomUUID()
  const consumerId = randomUUID()
  const principal = `orchestrator:${runId}`
  await prisma.$executeRawUnsafe(`INSERT INTO ppe_bootstrap_family
    (id,family_key,current_ordinal,updated_at) VALUES
    ('${familyId}'::uuid,'${familyId}',1,now())`)
  await prisma.$executeRawUnsafe(`INSERT INTO ppe_run_registry
    (run_id,family_id,ordinal,invocation_operation_key,invocation_payload_sha256,
     principal,state,generation,registry_receipt_sha256,updated_at) VALUES
    ('${runId}'::uuid,'${familyId}'::uuid,1,'bootstrap:${runId}','${'a'.repeat(64)}',
     '${principal}','ACTIVE',1,'${'b'.repeat(64)}',now())`)
  await prisma.$executeRawUnsafe(`INSERT INTO ppe_consumer
    (consumer_id,run_id,lane,generation,operation_key,config_sha256,
     attestation_sha256,status,updated_at) VALUES
    ('${consumerId}'::uuid,'${runId}'::uuid,'lane-codex',1,'consumer:${consumerId}',
     '${'c'.repeat(64)}','${'d'.repeat(64)}','READY',now())`)
  const request = await prisma.agentMessage.create({
    data: {
      type: 'info', from_server: 'max2', from_model: 'codex',
      to_server: 'mac', to_model: 'claude', body: mark(`marked ${label}`), meta: {},
      source: 'cli', status: 'pending', ppe_protocol: 'parallel-plan-execution/v1',
      ppe_run_id: runId, ppe_operation_key: `dispatch:${label}:${runId}`,
      ppe_payload_sha256: 'e'.repeat(64), ppe_from_principal: principal,
      ppe_to_principal: null, ppe_to_consumer_id: consumerId,
      ppe_consumer_generation: 1, ppe_lease_generation: null,
    },
  })
  return { familyId, runId, consumerId, requestId: request.id }
}

async function cleanupMarkedFixture(fixture: MarkedFixture): Promise<void> {
  await prisma.agentMessage.deleteMany({ where: { ppe_run_id: fixture.runId } })
  await prisma.$executeRawUnsafe(`DELETE FROM ppe_consumer WHERE consumer_id='${fixture.consumerId}'::uuid`)
  await prisma.$executeRawUnsafe(`DELETE FROM ppe_run_registry WHERE run_id='${fixture.runId}'::uuid`)
  await prisma.$executeRawUnsafe(`DELETE FROM ppe_bootstrap_family WHERE id='${fixture.familyId}'::uuid`)
}

describeWithDatabase('B2 — legacy routes never acquire marked lifecycle authority', () => {
  beforeEach(() => clearLeases())

  it('generic request claim skips the oldest marked row and claims the later legacy row', async () => {
    const fixture = await seedMarkedRequest('claim')
    try {
      const legacy = await insertRequest('legacy after marked')
      const claimed = await claimNextRequest({ server: 'mac', model: 'claude', claimedBy: 'mcp:b2:legacy' })
      expect(claimed?.id).toBe(legacy.id)
      const marked = await prisma.agentMessage.findUnique({ where: { id: fixture.requestId } })
      expect(marked?.status).toBe('pending')
    } finally {
      await prisma.agentMessage.deleteMany({ where: { body: { contains: mark('legacy after marked') } } })
      await cleanupMarkedFixture(fixture)
    }
  })

  it('known-id, view, lease-refresh, rollback and stale-sweep routes reject a marked row', async () => {
    const fixture = await seedMarkedRequest('mutations')
    try {
      const statusResult = await status({ message_id: fixture.requestId })
      expect(statusResult.isError).toBe(true)
      expect(statusResult.content[0].text).toContain('QUEUE_NOT_FOUND')
      const listed = parse(await list({ direction: 'both', include_terminal: true }))
      expect(listed.messages.map((message: { id: string }) => message.id)).not.toContain(fixture.requestId)

      for (const result of [
        await done({ message_id: fixture.requestId, reply: mark('forbidden reply') }),
        await fail({ message_id: fixture.requestId, error: 'forbidden fail' }),
      ]) {
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('PPE_LEGACY_ROUTE_REJECTED')
      }

      await prisma.agentMessage.update({
        where: { id: fixture.requestId },
        data: {
          status: 'claimed', claimed_by: 'mcp:b2:marked',
          claimed_at: new Date(Date.now() - 5 * 60 * 60_000), started_at: new Date(),
          ppe_lease_generation: 1,
        },
      })
      registerLease(fixture.requestId, { claimToken: 'marked-token', claimedBy: 'mcp:b2:marked' })
      await refreshQueueLeases()
      expect(getLease(fixture.requestId)).toBeUndefined()
      await rollbackQueueClaim(fixture.requestId, 'mcp:b2:marked')
      await sweepStaleQueueClaims()
      const after = await prisma.agentMessage.findUnique({ where: { id: fixture.requestId } })
      expect(after?.status).toBe('claimed')
      expect(after?.claimed_by).toBe('mcp:b2:marked')
    } finally {
      await cleanupMarkedFixture(fixture)
    }
  })

  it('generic wait ignores a marked reply even for an explicitly supplied request handle', async () => {
    const fixture = await seedMarkedRequest('reply')
    try {
      await prisma.agentMessage.create({
        data: {
          type: 'data', from_server: 'mac', from_model: 'claude',
          to_server: 'max2', to_model: 'codex', body: mark('marked reply'), meta: {},
          source: 'cli', status: 'pending', in_reply_to: fixture.requestId,
          ppe_protocol: 'parallel-plan-execution/v1', ppe_run_id: fixture.runId,
          ppe_operation_key: `reply:${fixture.requestId}`, ppe_payload_sha256: 'f'.repeat(64),
          ppe_from_principal: null, ppe_to_principal: `orchestrator:${fixture.runId}`,
          ppe_to_consumer_id: null, ppe_consumer_generation: null, ppe_lease_generation: null,
        },
      })
      const result = parse(await waitReply({
        message_ids: [fixture.requestId], wait_seconds: 0, as: 'codex',
      }))
      expect(result).toEqual({ status: 'timeout', replies: [] })
    } finally {
      await cleanupMarkedFixture(fixture)
    }
  })
})
