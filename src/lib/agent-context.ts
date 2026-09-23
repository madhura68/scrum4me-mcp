import { z } from 'zod'

export const agentInputSchema = z.object({
  runtime: z.enum(['CLAUDE', 'CODEX']),
  model_id: z.string().trim().min(1).max(200).optional(),
})

export const productContextInputSchema = z.object({
  product_id: z.string().min(1),
  agent: agentInputSchema.optional(),
})

export type AgentInput = z.infer<typeof agentInputSchema>
export type AgentContext = {
  runtime: AgentInput['runtime'] | null
  model_id: string | null
  display_name: string | null
  applied_profiles: string[] | null
}

export function agentContext(
  agent: AgentInput | undefined,
  displayName: string | null = null,
  appliedProfiles: string[] | null = [],
): AgentContext {
  return {
    runtime: agent?.runtime ?? null,
    model_id: agent?.model_id ?? null,
    display_name: displayName,
    applied_profiles: appliedProfiles,
  }
}
