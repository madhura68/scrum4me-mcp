import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DispatchInput } from '@shared/queue-dispatch.js'
import { parseDispatchInput } from '@shared/queue-dispatch-validation.js'
import { createDispatchClient, DispatchClientError, type DispatchClient } from '../dispatch/client.js'
import { DispatchError } from '../dispatch/errors.js'
import { getRequestToken } from '../request-context.js'
import { toolError, toolJson } from '../errors.js'

/** The central dispatch API authorizes the caller, so the client carries exactly the token this call arrived
 * with: the request's bearer in HTTP mode, SCRUM4ME_TOKEN in stdio mode. There is deliberately no service
 * identity to fall back on — a caller whose token lacks a right is refused, not quietly upgraded. */
export function requestDispatchClient(): DispatchClient {
  const baseUrl = process.env.S4M_DISPATCH_URL?.trim(), token = getRequestToken()
  if (!baseUrl || !token) throw new Error('DISPATCH_NOT_CONFIGURED: S4M_DISPATCH_URL and a caller token are required')
  return createDispatchClient({ baseUrl, token })
}
export const idempotencyKey = z.string().uuid().optional().describe('Reuse the same key to retry a submit safely; omitted → one is generated and returned.')
export const commonFields = {
  product_id: z.string().min(1), objective: z.string().min(1), verification: z.string().min(1), response_format: z.string().min(1),
  runtime: z.enum(['CLAUDE', 'CODEX']).optional(),
  work_item: z.object({ task_id: z.string().optional(), story_id: z.string().optional(), pbi_id: z.string().optional() }).optional()
    .describe('A label for traceability only. It never selects the action and grants nothing.'),
  reply_to: z.string().min(1).describe("Your own authorized queue address, e.g. 'mac:jp'; the final answer is delivered there."),
  idempotency_key: idempotencyKey,
}
/** Central validation is the authority; validating here too means a malformed request never leaves the host. */
export function buildInput(value: unknown): DispatchInput {
  try { return parseDispatchInput(value) } catch { throw new DispatchError('DISPATCH_INVALID_INPUT') }
}
export async function submit(input: DispatchInput, key: string | undefined) {
  const idempotency_key = key ?? randomUUID()
  return toolJson({ idempotency_key, dispatch: await requestDispatchClient().submitDispatch(input, idempotency_key) })
}
export async function withDispatchErrors(fn: () => Promise<ReturnType<typeof toolJson>>) {
  try { return await fn() } catch (error) {
    if (error instanceof DispatchClientError) return toolError(`${error.code} (HTTP ${error.status})`)
    if (error instanceof DispatchError) return toolError(error.code)
    return toolError(error instanceof Error && error.message.startsWith('DISPATCH_') ? error.message : 'DISPATCH_TOOL_FAILED')
  }
}
