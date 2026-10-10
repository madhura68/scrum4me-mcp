// M50-1a (Taak 3, stap 2): de chatpayload van een AGENT_CHAT-job. completeTurns bepaalt welke berichten de geschiedenis
// in gaan; buildAgentChatPayload zet de payload op uit de chat, de promptversie en de berichten.
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_CHAT_MAX_HISTORY_TURNS,
  buildAgentChatPayload,
  completeTurns,
  type AgentChatMessageRow,
} from '../src/lib/agent-chat-payload.js'

const msg = (id: string, role: 'USER' | 'ASSISTANT', content: string, job_id: string | null): AgentChatMessageRow =>
  ({ id, role, content, job_id })

/** Een volledige beurt: het USER-bericht van job `j` en het ASSISTANT-antwoord met dezelfde job_id. */
const turn = (n: number): AgentChatMessageRow[] => [
  msg(`u${n}`, 'USER', `vraag ${n}`, `j${n}`),
  msg(`a${n}`, 'ASSISTANT', `antwoord ${n}`, `j${n}`),
]

const PENDING = msg('pending', 'USER', 'nieuwe vraag', 'jp')

describe('completeTurns', () => {
  it('een eerste bericht heeft een lege geschiedenis', () => {
    expect(completeTurns([PENDING], 'pending')).toEqual([])
  })

  it('één los bericht telt niet mee', () => {
    const messages = [msg('u1', 'USER', 'los', 'j1'), PENDING]
    expect(completeTurns(messages, 'pending')).toEqual([])
  })

  it('twee losse berichten na elkaar tellen niet mee', () => {
    const messages = [msg('u1', 'USER', 'los 1', 'j1'), msg('u2', 'USER', 'los 2', 'j2'), PENDING]
    expect(completeTurns(messages, 'pending')).toEqual([])
  })

  it('een geannuleerde beurt (USER zonder ASSISTANT) valt weg, een volledige beurt blijft', () => {
    const messages = [msg('u0', 'USER', 'geannuleerd', 'jx'), ...turn(1), PENDING]
    expect(completeTurns(messages, 'pending')).toEqual([
      { role: 'user', content: 'vraag 1' },
      { role: 'assistant', content: 'antwoord 1' },
    ])
  })

  it('een ASSISTANT zonder job_id telt niet mee, ook niet bij een USER-bericht ernaast', () => {
    const messages = [msg('u1', 'USER', 'vraag', 'j1'), msg('a0', 'ASSISTANT', 'losse tekst', null), PENDING]
    expect(completeTurns(messages, 'pending')).toEqual([])
  })

  it('volledige beurten staan oudste eerst en wisselen af tussen user en assistant', () => {
    const messages = [...turn(1), ...turn(2), ...turn(3), PENDING]
    const history = completeTurns(messages, 'pending')
    expect(history.map((entry) => entry.content)).toEqual(['vraag 1', 'antwoord 1', 'vraag 2', 'antwoord 2', 'vraag 3', 'antwoord 3'])
    expect(history.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
  })

  it('berichten vanaf het pending-bericht tellen niet mee', () => {
    const later = [msg('u9', 'USER', 'na de pending', 'j9'), msg('a9', 'ASSISTANT', 'antwoord 9', 'j9')]
    expect(completeTurns([...turn(1), PENDING, ...later], 'pending')).toEqual([
      { role: 'user', content: 'vraag 1' },
      { role: 'assistant', content: 'antwoord 1' },
    ])
  })

  it('bewaart hooguit 100 beurten: 101 beurten geven 100, en de oudste valt weg', () => {
    expect(AGENT_CHAT_MAX_HISTORY_TURNS).toBe(100)
    const turns = Array.from({ length: 101 }, (_, i) => turn(i + 1)).flat()
    const history = completeTurns([...turns, PENDING], 'pending')
    expect(history).toHaveLength(200)
    expect(history[0]).toEqual({ role: 'user', content: 'vraag 2' })
    expect(history[199]).toEqual({ role: 'assistant', content: 'antwoord 101' })
  })
})

describe('buildAgentChatPayload', () => {
  const config = { runtime: 'HARNESS' as const, model: 'gsq-lokaal', max_cost_usd: '0.05' }
  const product = { id: 'prod-1', name: 'Scrum4Me', code: 'SCRUM4ME' }

  /** De gedeelde lezing van de transactie: de koppelrij van de job, de berichten van de chat. */
  function fakeTx(link: unknown, messages: AgentChatMessageRow[] = []) {
    return {
      agentChatJob: { findUnique: vi.fn().mockResolvedValue(link) },
      agentChatMessage: { findMany: vi.fn().mockResolvedValue(messages) },
    }
  }
  const link = (chatId: string | null = 'chat-1') => ({
    chat: chatId === null ? null : { id: chatId, product },
    prompt_version: { content: 'Je bent de chat-agent.' },
  })

  it('zet de payload op uit de chat, de promptversie, de geschiedenis en het pending-bericht', async () => {
    const pendingRow = msg('pending', 'USER', 'nieuwe vraag', 'job-1')
    const tx = fakeTx(link(), [...turn(1), pendingRow])

    const payload = await buildAgentChatPayload(tx as never, 'job-1', config)

    expect(payload).toEqual({
      kind: 'AGENT_CHAT',
      job_id: 'job-1',
      config,
      chat: { id: 'chat-1', product },
      history: [
        { role: 'user', content: 'vraag 1' },
        { role: 'assistant', content: 'antwoord 1' },
      ],
      pending: { message_id: 'pending', content: 'nieuwe vraag' },
      system_prompt: 'Je bent de chat-agent.',
    })
    expect(tx.agentChatJob.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { job_id: 'job-1' } }))
    expect(tx.agentChatMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { chat_id: 'chat-1' } }))
  })

  it('zonder koppelrij is de chat verwijderd: een skip, geen payload', async () => {
    await expect(buildAgentChatPayload(fakeTx(null) as never, 'job-1', config)).resolves.toEqual({ skip: 'AGENT_CHAT_CHAT_DELETED' })
  })

  it('een koppelrij met chat_id NULL is ook een verwijderde chat', async () => {
    await expect(buildAgentChatPayload(fakeTx(link(null)) as never, 'job-1', config)).resolves.toEqual({ skip: 'AGENT_CHAT_CHAT_DELETED' })
  })

  it('zonder pending-bericht van deze job is de job niet te beantwoorden: een skip', async () => {
    const tx = fakeTx(link(), [...turn(1)])
    await expect(buildAgentChatPayload(tx as never, 'job-1', config)).resolves.toEqual({ skip: 'AGENT_CHAT_PENDING_MISSING' })
  })
})
