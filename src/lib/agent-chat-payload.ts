// M50-1a (chat-agent-spec §5.3): de payload van een geclaimde AGENT_CHAT-job, het contract dat de harness in 1b leest.
// Een beurt is een USER-bericht met een ASSISTANT-antwoord met dezelfde job_id. Alleen volledige beurten gaan de
// geschiedenis in: een los bericht, een geannuleerde beurt en een ASSISTANT zonder job_id vallen weg.
import type { Prisma } from '@prisma/client'
import type { RuntimeJobConfig } from '@shared/job-config.js'

/** Hooguit zoveel volledige beurten in de geschiedenis; de oudste vallen eerst weg. */
export const AGENT_CHAT_MAX_HISTORY_TURNS = 100

export type AgentChatHistoryEntry = { role: 'user' | 'assistant'; content: string }

export type AgentChatMessageRow = {
  id: string
  role: 'USER' | 'ASSISTANT'
  content: string
  job_id: string | null
}

export type AgentChatPayload = {
  kind: 'AGENT_CHAT'
  job_id: string
  config: RuntimeJobConfig
  chat: { id: string; product: { id: string; name: string; code: string | null } }
  history: AgentChatHistoryEntry[]
  pending: { message_id: string; content: string }
  system_prompt: string
}

/** Waarom een geclaimde chatjob geen payload krijgt; de claim zet de job dan op SKIPPED. */
export type AgentChatSkipReason = 'AGENT_CHAT_CHAT_DELETED' | 'AGENT_CHAT_PENDING_MISSING'

/**
 * De volledige beurten vóór het pending-bericht, oudste eerst, op hooguit AGENT_CHAT_MAX_HISTORY_TURNS beurten.
 * `messages` is de chat, oudste eerst. Een beurt telt alleen als zijn USER-bericht een job_id heeft waarvoor
 * een ASSISTANT-bericht bestaat; berichten vanaf het pending-bericht tellen niet mee.
 */
export function completeTurns(messages: AgentChatMessageRow[], pendingId: string): AgentChatHistoryEntry[] {
  const pendingIndex = messages.findIndex((message) => message.id === pendingId)
  const before = pendingIndex < 0 ? [] : messages.slice(0, pendingIndex)

  const answers = new Map<string, AgentChatMessageRow>()
  for (const message of before) {
    if (message.role === 'ASSISTANT' && message.job_id) answers.set(message.job_id, message)
  }

  const turns: AgentChatHistoryEntry[][] = []
  for (const message of before) {
    if (message.role !== 'USER' || !message.job_id) continue
    const answer = answers.get(message.job_id)
    if (!answer) continue
    turns.push([
      { role: 'user', content: message.content },
      { role: 'assistant', content: answer.content },
    ])
  }
  return turns.slice(-AGENT_CHAT_MAX_HISTORY_TURNS).flat()
}

/**
 * De payload van job `jobId`, in één transactie aangeroepen door de claim. Een chat die weg is (de koppelrij of
 * de chat zelf ontbreekt) of een job zonder eigen pending-bericht geeft een skip-uitkomst, geen payload.
 */
export async function buildAgentChatPayload(
  tx: Prisma.TransactionClient,
  jobId: string,
  config: RuntimeJobConfig,
): Promise<AgentChatPayload | { skip: AgentChatSkipReason }> {
  const link = await tx.agentChatJob.findUnique({
    where: { job_id: jobId },
    select: {
      chat: { select: { id: true, product: { select: { id: true, name: true, code: true } } } },
      prompt_version: { select: { content: true } },
    },
  })
  if (!link?.chat) return { skip: 'AGENT_CHAT_CHAT_DELETED' }

  const messages = await tx.agentChatMessage.findMany({
    where: { chat_id: link.chat.id },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { id: true, role: true, content: true, job_id: true },
  })
  const pending = messages.find((message) => message.role === 'USER' && message.job_id === jobId)
  if (!pending) return { skip: 'AGENT_CHAT_PENDING_MISSING' }

  return {
    kind: 'AGENT_CHAT',
    job_id: jobId,
    config,
    chat: { id: link.chat.id, product: link.chat.product },
    history: completeTurns(messages, pending.id),
    pending: { message_id: pending.id, content: pending.content },
    system_prompt: link.prompt_version.content,
  }
}
