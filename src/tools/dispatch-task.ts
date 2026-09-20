import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { buildInput, commonFields, submit, withDispatchErrors } from './dispatch-common.js'

const inputSchema = z.object({
  ...commonFields,
  access: z.enum(['read', 'repo_write']),
  environment_keys: z.array(z.string()).optional(),
  repository: z.object({ product_id: z.string().min(1), base_sha: z.string().min(1) }).optional().describe('Required for repo_write.'),
  publish: z.enum(['artifact', 'branch', 'pull_request']).optional().describe("Defaults to 'artifact'; read access allows nothing else."),
  task_id: z.string().min(1).optional().describe('An existing Scrum4Me Task to implement. Only this selects task_implementation.'),
})

export function registerDispatchTaskTool(server: McpServer) {
  server.registerTool(
    'dispatch_task',
    {
      title: 'Dispatch task',
      description:
        'Hand a task to automatic dispatch: a suitable job worker runs it, or a registered host agent when the ' +
        'requirements need one, and one final answer comes back to reply_to in Messages. Without task_id this is a ' +
        'free task; with task_id it implements that Scrum4Me Task. To send work to one specific watcher yourself, ' +
        'use queue_push instead — that path is unchanged and creates no job.',
      inputSchema,
    },
    async ({ idempotency_key, access, runtime, environment_keys, repository, publish, ...rest }) =>
      withDispatchErrors(async () => submit(buildInput({
        version: 1, ...rest, action: rest.task_id ? 'task_implementation' : 'free_task',
        requirements: { ...(runtime ? { runtime } : {}), access, environment_keys: environment_keys ?? [], ...(repository ? { repository } : {}) },
        publish: publish ?? 'artifact',
      }), idempotency_key)),
  )
}
