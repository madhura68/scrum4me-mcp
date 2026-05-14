// Loader voor embedded prompts per ClaudeJob-kind.
//
// De .md-bestanden in src/prompts/<kind>/ worden bewust meegebakken zodat
// elke runner ze kan inlezen zonder externe plugin-dependency. De runner
// (scrum4me-docker/bin/run-one-job.ts) leest de juiste prompt via
// getKindPromptText() en geeft die door als `claude -p`-prompt.
//
// Variabele-vervanging gebeurt door de runner zelf (bv. $PAYLOAD_PATH).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ClaudeJobKind } from '@prisma/client'

const cache: Partial<Record<ClaudeJobKind, string>> = {}

function loadPrompt(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/lib/kind-prompts.ts → src/lib → src → src/prompts/<rel>
  const path = join(here, '..', 'prompts', rel)
  return readFileSync(path, 'utf8')
}

const KIND_TO_PROMPT_PATH: Partial<Record<ClaudeJobKind, string>> = {
  IDEA_GRILL: 'idea/grill.md',
  IDEA_MAKE_PLAN: 'idea/make-plan.md',
  IDEA_REVIEW_PLAN: 'idea/review-plan.md',
  TASK_IMPLEMENTATION: 'task/implementation.md',
  SPRINT_IMPLEMENTATION: 'sprint/implementation.md',
  PLAN_CHAT: 'plan-chat/chat.md',
}

export function getKindPromptText(kind: ClaudeJobKind): string {
  if (cache[kind]) return cache[kind]!
  const rel = KIND_TO_PROMPT_PATH[kind]
  if (!rel) return ''
  const text = loadPrompt(rel)
  cache[kind] = text
  return text
}

// Back-compat re-export. wait-for-job.ts roept getIdeaPromptText aan voor
// de drie idea-kinds; behouden zodat we de bestaande call-site niet hoeven
// te wijzigen tot een aparte cleanup-pass.
export function getIdeaPromptText(kind: ClaudeJobKind): string {
  if (kind !== 'IDEA_GRILL' && kind !== 'IDEA_MAKE_PLAN' && kind !== 'IDEA_REVIEW_PLAN') return ''
  return getKindPromptText(kind)
}
