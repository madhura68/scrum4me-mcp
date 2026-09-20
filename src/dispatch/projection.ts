import type { Pool, PoolClient } from 'pg'
import type { DispatchProjection, DispatchProjectionMessage } from '@shared/queue-dispatch-projection.js'
import { QUEUE_CHANNEL } from '../queue/notify.js'

type Stored = { id: string; type: string; from_server: string; from_model: string; to_server: string; to_model: string; in_reply_to: string | null; status: string; dispatch_request_id: string | null; dispatch_role: string | null }
const identity = (m: DispatchProjectionMessage) => [m.id, m.type, m.from_server, m.from_model, m.to_server, m.to_model, m.in_reply_to]
function assertSame(row: Stored | undefined, m: DispatchProjectionMessage, requestId: string, role: 'ROOT' | 'REPLY'): Stored {
  // An id that already belongs to anything else is never adopted, overwritten or replied under.
  if (!row || row.dispatch_request_id !== requestId || row.dispatch_role !== role
    || JSON.stringify([row.id, row.type, row.from_server, row.from_model, row.to_server, row.to_model, row.in_reply_to]) !== JSON.stringify(identity(m))) {
    // Internal to the projector: it never travels over the dispatch HTTP surface.
    throw new Error('DISPATCH_PROJECTION_IDENTITY_CONFLICT')
  }
  return row
}
const read = async (db: PoolClient, id: string) => (await db.query<Stored>('SELECT id,type,from_server,from_model,to_server,to_model,in_reply_to,status,dispatch_request_id,dispatch_role FROM agent_message WHERE id=$1 FOR UPDATE', [id])).rows[0]
type Addressed = Pick<DispatchProjectionMessage, 'id' | 'type' | 'from_server' | 'from_model' | 'to_server' | 'to_model' | 'in_reply_to'>
const notify = (db: PoolClient, m: Addressed, status: string, previous: string | null) => db.query('SELECT pg_notify($1,$2)', [QUEUE_CHANNEL,
  JSON.stringify({ id: m.id, type: m.type, from_server: m.from_server, from_model: m.from_model, to_server: m.to_server, to_model: m.to_model, in_reply_to: m.in_reply_to, status, previous_status: previous })])

/** Projector-only entry: one queue transaction, root before reply, monotone by version. The root is upserted
 * only to a strictly higher version; the reply is inserted once and never rewritten, so a reader's claim or
 * acknowledgement survives every later root version. The messages go to the dispatch namespace and to the
 * sender's own address, never to a host address, so nothing here is claimable work. */
export async function applyDispatchProjection(client: PoolClient, projection: DispatchProjection): Promise<void> {
  const { root, reply, requestId, version } = projection
  await client.query('BEGIN')
  try {
    const before = await read(client, root.id)
    if (before) assertSame(before, root, requestId, 'ROOT')
    const terminal = ['done', 'failed', 'cancelled'].includes(root.status)
    const written = await client.query(`INSERT INTO agent_message
      (id,type,from_server,from_model,to_server,to_model,body,meta,source,status,in_reply_to,claimed_at,finished_at,dispatch_request_id,dispatch_projection_version,dispatch_role)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'mcp',$9,NULL,CASE WHEN $9<>'pending' THEN now() END,CASE WHEN $10 THEN now() END,$11,$12,'ROOT')
      ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body,meta=EXCLUDED.meta,status=EXCLUDED.status,
        claimed_at=COALESCE(agent_message.claimed_at,EXCLUDED.claimed_at),finished_at=COALESCE(agent_message.finished_at,EXCLUDED.finished_at),
        dispatch_projection_version=EXCLUDED.dispatch_projection_version
      WHERE agent_message.dispatch_request_id=EXCLUDED.dispatch_request_id AND agent_message.dispatch_role='ROOT'
        AND agent_message.dispatch_projection_version<EXCLUDED.dispatch_projection_version`,
    [root.id, root.type, root.from_server, root.from_model, root.to_server, root.to_model, root.body, JSON.stringify(root.meta), root.status, terminal, requestId, version])
    assertSame(await read(client, root.id), root, requestId, 'ROOT')
    if (written.rowCount && before?.status !== root.status) await notify(client, root, root.status, before?.status ?? null)
    if (reply) {
      const inserted = await client.query(`INSERT INTO agent_message
        (id,type,from_server,from_model,to_server,to_model,body,meta,source,status,in_reply_to,dispatch_request_id,dispatch_projection_version,dispatch_role)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'mcp','pending',$9,$10,$11,'REPLY') ON CONFLICT (id) DO NOTHING`,
      [reply.id, reply.type, reply.from_server, reply.from_model, reply.to_server, reply.to_model, reply.body, JSON.stringify(reply.meta), reply.in_reply_to, requestId, version])
      assertSame(await read(client, reply.id), reply, requestId, 'REPLY')
      if (inserted.rowCount) await notify(client, reply, 'pending', null)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

/** The CLI inbox claims a reply before it acknowledges it, and the ordinary sweep skips managed rows, so a
 * reader that crashed would hide its answer forever. After the CLI's maximum inbox lease the projector makes
 * exactly that reply readable again: read-claim fields only, never an execution slot, never a new result. */
export async function recoverForgottenReplyReads(queue: Pool, olderThan = '4 hours'): Promise<string[]> {
  const client = await queue.connect()
  try {
    await client.query('BEGIN')
    const rows = (await client.query<Addressed>(`UPDATE agent_message m SET status='pending',claimed_by=NULL,claimed_at=NULL,started_at=NULL
      FROM (SELECT id FROM agent_message WHERE dispatch_role='REPLY' AND dispatch_request_id IS NOT NULL AND status='claimed'
              AND claimed_at<now()-$1::interval ORDER BY claimed_at FOR UPDATE SKIP LOCKED) target
      WHERE m.id=target.id RETURNING m.id,m.type,m.from_server,m.from_model,m.to_server,m.to_model,m.in_reply_to`, [olderThan])).rows
    for (const row of rows) await notify(client, row, 'pending', 'claimed')
    await client.query('COMMIT')
    return rows.map(r => r.id)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

// Explicit, never SELECT *: a column added to one table later must fail here, not silently fall out of history.
const MESSAGE_COLUMNS = 'id,type,from_server,from_model,to_server,to_model,body,meta,source,status,in_reply_to,error,claimed_by,claimed_at,started_at,finished_at,created_at,idempotency_key,ppe_protocol,ppe_run_id,ppe_operation_key,ppe_payload_sha256,ppe_from_principal,ppe_to_principal,ppe_to_consumer_id,ppe_consumer_generation,ppe_lease_generation,archived_at,dispatch_projection_version,dispatch_request_id,dispatch_role'
const RECOVERY_EVENTS = ['recovery_action', 'retry_authorized', 'publication_resolved']

/** Terminal retention archives first. One queue transaction per thread copies every message to the archive,
 * proves each archived row equals its hot row, and only then deletes — reply before root, because the
 * in_reply_to foreign key would otherwise rewrite the reply. Any difference refuses the whole thread.
 * Requests that went through recovery keep their thread: it is part of the audit. */
export async function retainTerminalDispatchThreads(deps: { store: Pool; queue: Pool }, opts: { olderThan: string; limit: number }): Promise<{ archived: number; refused: number }> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 100) throw new Error('DISPATCH_INVALID_INPUT')
  const due = (await deps.store.query<{ id: string }>(`SELECT r.id FROM queue_dispatch_requests r
    WHERE r.state IN ('SUCCEEDED','FAILED','CANCELLED') AND r.updated_at<now()-$1::interval
      AND NOT EXISTS(SELECT 1 FROM queue_dispatch_events e WHERE e.request_id=r.id AND e.type=ANY($2::text[]))
      AND NOT EXISTS(SELECT 1 FROM queue_dispatch_outbox o WHERE o.request_id=r.id AND o.published_at IS NULL)
    ORDER BY r.updated_at,r.id LIMIT $3`, [opts.olderThan, RECOVERY_EVENTS, opts.limit])).rows
  let archived = 0, refused = 0
  for (const { id } of due) {
    const client = await deps.queue.connect()
    try {
      await client.query('BEGIN')
      const hot = (await client.query<{ id: string; status: string }>('SELECT id,status FROM agent_message WHERE dispatch_request_id=$1 FOR UPDATE', [id])).rows
      // Already retained, or the answer is still unread: nothing to do, and not a refusal.
      if (!hot.length || hot.some(m => !['done', 'failed', 'cancelled'].includes(m.status))) { await client.query('ROLLBACK'); continue }
      await client.query(`INSERT INTO agent_message_archive(${MESSAGE_COLUMNS}) SELECT ${MESSAGE_COLUMNS} FROM agent_message WHERE dispatch_request_id=$1 ON CONFLICT (id) DO NOTHING`, [id])
      const same = (await client.query<{ n: number }>('SELECT count(*)::int n FROM agent_message m JOIN agent_message_archive a ON a.id=m.id WHERE m.dispatch_request_id=$1 AND to_jsonb(a)=to_jsonb(m)', [id])).rows[0].n
      if (same !== hot.length) throw new Error('DISPATCH_RETENTION_CONFLICT')
      await client.query("DELETE FROM agent_message WHERE dispatch_request_id=$1 AND dispatch_role='REPLY'", [id])
      await client.query("DELETE FROM agent_message WHERE dispatch_request_id=$1 AND dispatch_role='ROOT'", [id])
      await client.query('COMMIT'); archived++
    } catch {
      await client.query('ROLLBACK').catch(() => undefined); refused++
    } finally { client.release() }
  }
  return { archived, refused }
}
