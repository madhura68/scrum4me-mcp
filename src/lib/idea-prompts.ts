// Loader voor embedded idea-prompts (M12).
// De .md-bestanden in src/prompts/idea/ zijn een kopie van
// scrum4me/lib/idea-prompts/* — bewust dupliceren voor reproduceerbaarheid
// op elke worker (geen externe anthropic-skills-plugin-dependency).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ClaudeJobKind } from '@prisma/client'

let cached: { grill?: string; makePlan?: string } = {}

function loadPrompt(file: 'grill.md' | 'make-plan.md'): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/lib/idea-prompts.ts → src/lib → src → src/prompts/idea/{file}
  const path = join(here, '..', 'prompts', 'idea', file)
  return readFileSync(path, 'utf8')
}

export function getIdeaPromptText(kind: ClaudeJobKind): string {
  if (kind === 'IDEA_GRILL') {
    if (!cached.grill) cached.grill = loadPrompt('grill.md')
    return cached.grill
  }
  if (kind === 'IDEA_MAKE_PLAN') {
    if (!cached.makePlan) cached.makePlan = loadPrompt('make-plan.md')
    return cached.makePlan
  }
  // TASK_IMPLEMENTATION en future kinds: geen embedded prompt nodig.
  return ''
}
