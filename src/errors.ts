import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PermissionDeniedError } from './auth.js'

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

export function toolJson(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  }
}

export async function withToolErrors<T>(
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      return toolError(`PERMISSION_DENIED: ${err.message}`)
    }
    if (err instanceof z.ZodError) {
      return toolError(`VALIDATION_ERROR: ${formatZodError(err)}`)
    }
    if (err instanceof Error) {
      return toolError(err.message)
    }
    return toolError(String(err))
  }
}
