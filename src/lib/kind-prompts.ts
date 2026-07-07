// Loader voor embedded prompts per ClaudeJob-kind (+ optionele runtime-variant).
//
// De .md-bestanden in src/prompts/<kind>/ worden meegebakken zodat elke runner ze
// kan inlezen zonder externe plugin-dependency. De docker-runner leest de juiste
// prompt via getKindPromptText(ctx.kind, runtime) en geeft die door als prompt.
//
// Variabele-vervanging ($PAYLOAD_PATH) gebeurt door de runner zelf.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ClaudeJobKind } from '@prisma/client'
import type { WorkerRuntime } from '../worker-runtime.js'

const cache = new Map<string, string>()

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
  IDEA_CHAT: 'idea-chat/chat.md',
  TASK_IMPLEMENTATION: 'task/implementation.md',
  SPRINT_IMPLEMENTATION: 'sprint/implementation.md',
  PLAN_CHAT: 'plan-chat/chat.md',
  PR_REVIEW: 'pr/review.md',
  SPEC_REVIEW: 'spec/review.md',
  TASK_REVIEW: 'task/review.md',
  DEPLOY: 'deploy/run.md',
  DOCS_AUDIT: 'docs-audit/audit.md',
}

// Runtime-specifieke overrides. Ontbreekt een (runtime, kind)-override, dan valt de
// selectie terug op KIND_TO_PROMPT_PATH (= het bestaande, runtime-neutrale pad).
const RUNTIME_PROMPT_OVERRIDES: Partial<Record<WorkerRuntime, Partial<Record<ClaudeJobKind, string>>>> = {
  CODEX: {
    IDEA_REVIEW_PLAN: 'idea/review-plan.codex.md',
    PR_REVIEW: 'pr/review.codex.md',
    SPEC_REVIEW: 'spec/review.codex.md',
    TASK_REVIEW: 'task/review.codex.md',
  },
}

export function getKindPromptText(kind: ClaudeJobKind, runtime: WorkerRuntime = 'CLAUDE'): string {
  const rel = RUNTIME_PROMPT_OVERRIDES[runtime]?.[kind] ?? KIND_TO_PROMPT_PATH[kind]
  if (!rel) return ''
  const key = `${runtime}:${kind}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const text = loadPrompt(rel)
  cache.set(key, text)
  return text
}

// Back-compat re-export voor de idea-kinds + PLAN_CHAT; threadt runtime door.
export function getIdeaPromptText(kind: ClaudeJobKind, runtime: WorkerRuntime = 'CLAUDE'): string {
  if (
    kind !== 'IDEA_GRILL' &&
    kind !== 'IDEA_MAKE_PLAN' &&
    kind !== 'IDEA_REVIEW_PLAN' &&
    kind !== 'IDEA_CHAT' &&
    kind !== 'PLAN_CHAT'
  ) return ''
  return getKindPromptText(kind, runtime)
}
