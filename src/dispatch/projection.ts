import type { PoolClient } from 'pg'
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
const notify = (db: PoolClient, m: DispatchProjectionMessage, status: string, previous: string | null) => db.query('SELECT pg_notify($1,$2)', [QUEUE_CHANNEL,
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
