// MCP-side port van scrum4me/lib/idea-plan-parser.ts (M12).
//
// Parser voor de plan_md die make-plan-job produceert: yaml-frontmatter
// (structuur) + markdown-body (vrije reasoning). Gebruikt door
// update_idea_plan_md voor server-side validatie vóór persistentie.
//
// LET OP: deze code is BEWUST een duplicaat van de Scrum4Me-parser. Houd
// het schema (zod-shape) in sync met scrum4me/lib/schemas/idea.ts.
// Toekomstige verhuizing naar vendor/scrum4me-shared/lib/ kan deze
// duplicatie elimineren (zie M16 platform-split design-spec sectie 3);
// tot dan: handmatige sync per PR-review.

import { parse as parseYaml, YAMLParseError } from 'yaml'
import { z } from 'zod'

const verifyRequiredEnum = z.enum(['ALIGNED', 'ALIGNED_OR_PARTIAL', 'ANY'])

const planTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  implementation_plan: z.string().max(8000).optional(),
  priority: z.number().int().min(1).max(4),
  verify_required: verifyRequiredEnum.optional(),
  verify_only: z.boolean().optional(),
})

const planStorySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  acceptance_criteria: z.string().max(4000).optional(),
  priority: z.number().int().min(1).max(4),
  tasks: z.array(planTaskSchema).min(1, 'Story moet minimaal 1 taak hebben'),
})

const planPbiSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  priority: z.number().int().min(1).max(4),
})

export const ideaPlanMdFrontmatterSchema = z.object({
  pbi: planPbiSchema,
  stories: z.array(planStorySchema).min(1, 'Plan moet minimaal 1 story bevatten'),
})

export type IdeaPlanFrontmatter = z.infer<typeof ideaPlanMdFrontmatterSchema>

export type PlanParseError = { line?: number; message: string }

export type PlanParseResult =
  | { ok: true; plan: IdeaPlanFrontmatter; body: string }
  | { ok: false; errors: PlanParseError[] }

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parsePlanMd(md: string): PlanParseResult {
  const match = md.match(FRONTMATTER_RE)
  if (!match) {
    return {
      ok: false,
      errors: [
        {
          line: 1,
          message: 'Plan ontbreekt yaml-frontmatter. Verwacht eerste regel: ---',
        },
      ],
    }
  }

  const [, frontmatterRaw, body] = match

  let parsed: unknown
  try {
    parsed = parseYaml(frontmatterRaw)
  } catch (err) {
    if (err instanceof YAMLParseError) {
      return {
        ok: false,
        errors: [{ line: err.linePos?.[0]?.line, message: err.message }],
      }
    }
    return {
      ok: false,
      errors: [{ message: err instanceof Error ? err.message : String(err) }],
    }
  }

  const validation = ideaPlanMdFrontmatterSchema.safeParse(parsed)
  if (!validation.success) {
    return {
      ok: false,
      errors: validation.error.issues.map((iss) => ({
        message: `${iss.path.join('.') || '<root>'}: ${iss.message}`,
      })),
    }
  }

  return { ok: true, plan: validation.data, body: body.trimStart() }
}
