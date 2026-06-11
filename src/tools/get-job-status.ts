// src/tools/get-job-status.ts
// IDEA-118 spec §6.3: id-resolutie — job → product → scope; buiten scope
// exact dezelfde 404 als niet-bestaand (geen id-probing-oracle).
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({ job_id: z.string().min(1) })

export async function handleGetJobStatus(input: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const { job_id } = inputSchema.parse(input)
    const auth = await getAuth()
    const job = await prisma.claudeJob.findUnique({
      where: { id: job_id },
      select: {
        id: true, kind: true, status: true, product_id: true,
        summary: true, error: true, pr_url: true,
        created_at: true, finished_at: true,
      },
    })
    if (!job || !(await userCanAccessProduct(job.product_id, auth.userId))) {
      return toolError(`Job ${job_id} not found`)
    }
    return toolJson({
      id: job.id,
      kind: job.kind,
      status: job.status,
      summary: job.summary,
      error: job.error,
      pr_url: job.pr_url,
      created_at: job.created_at,
      finished_at: job.finished_at,
    })
  })
}

export function registerGetJobStatusTool(server: McpServer) {
  server.registerTool(
    'get_job_status',
    {
      title: 'Get job status',
      description: 'Status, summary and error of a single job (scoped: only jobs of accessible products).',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => handleGetJobStatus(input),
  )
}
