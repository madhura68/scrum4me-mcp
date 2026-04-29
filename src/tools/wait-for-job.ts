// wait_for_job — blokkeert tot een QUEUED ClaudeJob beschikbaar is, claimt 'm
// atomisch via FOR UPDATE SKIP LOCKED, en retourneert de volledige task-context.
// Registreert ook de worker-presence (ClaudeWorker upsert + heartbeat).

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from 'pg'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, toolError, withToolErrors } from '../errors.js'

const MAX_WAIT_SECONDS = 600
const POLL_INTERVAL_MS = 5_000
const STALE_CLAIMED_INTERVAL = "30 minutes"
const WORKER_HEARTBEAT_INTERVAL_MS = 5_000

const inputSchema = z.object({
  product_id: z.string().min(1).optional(),
  wait_seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(300),
})

async function resetStaleClaimedJobs(userId: string) {
  await prisma.$executeRaw`
    UPDATE claude_jobs
    SET status = 'QUEUED', claimed_by_token_id = NULL, claimed_at = NULL
    WHERE user_id = ${userId}
      AND status = 'CLAIMED'
      AND claimed_at < NOW() - INTERVAL '30 minutes'
  `
}

async function tryClaimJob(
  userId: string,
  tokenId: string,
  productId?: string,
): Promise<string | null> {
  // Atomic claim in a single transaction
  const rows = await prisma.$transaction(async (tx) => {
    // SELECT FOR UPDATE SKIP LOCKED — skip jobs another worker has locked
    const found = productId
      ? await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM claude_jobs
          WHERE user_id = ${userId}
            AND product_id = ${productId}
            AND status = 'QUEUED'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `
      : await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM claude_jobs
          WHERE user_id = ${userId}
            AND status = 'QUEUED'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `

    if (found.length === 0) return []

    const jobId = found[0].id
    await tx.$executeRaw`
      UPDATE claude_jobs
      SET status = 'CLAIMED',
          claimed_by_token_id = ${tokenId},
          claimed_at = NOW()
      WHERE id = ${jobId}
    `
    return [{ id: jobId }]
  })

  return rows.length > 0 ? rows[0].id : null
}

async function upsertWorker(userId: string, tokenId: string, productId?: string) {
  await prisma.claudeWorker.upsert({
    where: { token_id: tokenId },
    create: {
      user_id: userId,
      token_id: tokenId,
      product_id: productId ?? null,
    },
    update: {
      last_seen_at: new Date(),
      product_id: productId ?? null,
    },
  })
}

async function deleteWorker(tokenId: string) {
  await prisma.claudeWorker.deleteMany({ where: { token_id: tokenId } })
}

async function getFullJobContext(jobId: string) {
  const job = await prisma.claudeJob.findUnique({
    where: { id: jobId },
    include: {
      task: {
        include: {
          story: {
            include: {
              pbi: { select: { id: true, title: true, priority: true, status: true } },
              sprint: { select: { id: true, sprint_goal: true, status: true } },
            },
          },
        },
      },
      product: { select: { id: true, name: true, repo_url: true } },
    },
  })
  if (!job) return null

  const { task } = job
  const { story } = task
  const { pbi, sprint } = story

  return {
    job_id: job.id,
    status: 'claimed',
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      implementation_plan: task.implementation_plan,
      priority: task.priority,
    },
    story: {
      id: story.id,
      title: story.title,
      description: story.description,
      acceptance_criteria: story.acceptance_criteria,
    },
    pbi: {
      id: pbi.id,
      title: pbi.title,
      priority: pbi.priority,
      status: pbi.status,
    },
    sprint: sprint
      ? { id: sprint.id, goal: sprint.sprint_goal, status: sprint.status }
      : null,
    product: {
      id: job.product.id,
      name: job.product.name,
      repo_url: job.product.repo_url,
    },
    branch_suggestion: `feat/job-${job.id.slice(-8)}`,
  }
}

export function registerWaitForJobTool(server: McpServer) {
  server.registerTool(
    'wait_for_job',
    {
      title: 'Wait for job',
      description:
        'Block until a QUEUED ClaudeJob is available for this user, then claim it atomically ' +
        'and return full task context (implementation_plan, story, pbi, sprint, repo_url). ' +
        'Registers worker presence so the Scrum4Me UI can show "Agent verbonden". ' +
        'Resets stale CLAIMED jobs (>30min) back to QUEUED before scanning. ' +
        'Pass optional product_id to scope to a specific product. ' +
        'Returns { status: "timeout" } when wait_seconds elapses without a job. ' +
        'Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ product_id, wait_seconds }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        const { userId, tokenId } = auth

        // Register presence
        await upsertWorker(userId, tokenId, product_id)

        // Notify worker_connected (best-effort — geen fatal error bij mislukken)
        try {
          const pg = new Client({ connectionString: process.env.DATABASE_URL })
          await pg.connect()
          await pg.query(
            `SELECT pg_notify('scrum4me_changes', $1)`,
            [JSON.stringify({ type: 'worker_connected', user_id: userId, product_id: product_id ?? null, token_id: tokenId })],
          )
          await pg.end()
        } catch {
          // non-fatal
        }

        try {
          // 1. Reset stale claimed jobs
          await resetStaleClaimedJobs(userId)

          // 2. Try immediate claim
          let jobId = await tryClaimJob(userId, tokenId, product_id)
          if (jobId) {
            const ctx = await getFullJobContext(jobId)
            if (!ctx) return toolError('Job claimed but context fetch failed')
            return toolJson(ctx)
          }

          // 3. No job available — LISTEN and poll until timeout
          const deadline = Date.now() + wait_seconds * 1000
          const listenClient = new Client({ connectionString: process.env.DATABASE_URL })
          await listenClient.connect()
          await listenClient.query('LISTEN scrum4me_changes')

          const heartbeatTimer = setInterval(async () => {
            try {
              await upsertWorker(userId, tokenId, product_id)
            } catch {
              // non-fatal
            }
          }, WORKER_HEARTBEAT_INTERVAL_MS)

          try {
            while (Date.now() < deadline) {
              // Wait for a notification or poll interval
              await new Promise<void>((resolve) => {
                const pollTimer = setTimeout(resolve, POLL_INTERVAL_MS)
                listenClient.once('notification', (msg) => {
                  try {
                    const payload = JSON.parse(msg.payload ?? '{}')
                    if (
                      payload.type === 'claude_job_enqueued' &&
                      payload.user_id === userId &&
                      (!product_id || payload.product_id === product_id)
                    ) {
                      clearTimeout(pollTimer)
                      resolve()
                    }
                  } catch {
                    // ignore parse errors
                  }
                })
              })

              await resetStaleClaimedJobs(userId)
              jobId = await tryClaimJob(userId, tokenId, product_id)
              if (jobId) {
                const ctx = await getFullJobContext(jobId)
                if (!ctx) return toolError('Job claimed but context fetch failed')
                return toolJson(ctx)
              }
            }
          } finally {
            clearInterval(heartbeatTimer)
            await listenClient.end().catch(() => {})
          }

          return toolJson({ status: 'timeout', message: 'No job available within wait window' })
        } finally {
          // Deregister presence and notify
          await deleteWorker(tokenId).catch(() => {})
          try {
            const pg = new Client({ connectionString: process.env.DATABASE_URL })
            await pg.connect()
            await pg.query(
              `SELECT pg_notify('scrum4me_changes', $1)`,
              [JSON.stringify({ type: 'worker_disconnected', user_id: userId, token_id: tokenId })],
            )
            await pg.end()
          } catch {
            // non-fatal
          }
        }
      }),
  )
}
