// PBI-102 (T-1123): DRY-mirror van Scrum4Me's product-doc-parser. Wijzig
// beide bestanden bij elke aanpassing (patroon: lib/job-config.ts).

import { parse as parseYaml, YAMLParseError } from 'yaml'

import {
  productDocFrontmatterSchema,
  type ProductDocFrontmatter,
} from './product-doc-schemas.js'

export type ProductDocParseError = {
  line?: number
  message: string
  hint?: string
}

export type ProductDocParseResult =
  | { ok: true; frontmatter: ProductDocFrontmatter; body: string }
  | { ok: false; errors: ProductDocParseError[] }

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseProductDocMd(md: string): ProductDocParseResult {
  const match = md.match(FRONTMATTER_RE)
  if (!match) {
    return {
      ok: false,
      errors: [
        {
          line: 1,
          message:
            'Doc mist yaml-frontmatter. Eerste regel moet `---` zijn, gevolgd door de frontmatter en een afsluitende `---`.',
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
      const yamlLine = err.linePos?.[0]?.line
      const fileLine = yamlLine != null ? yamlLine + 1 : undefined
      return {
        ok: false,
        errors: [{ line: fileLine, message: err.message }],
      }
    }
    return {
      ok: false,
      errors: [{ message: err instanceof Error ? err.message : String(err) }],
    }
  }

  const validation = productDocFrontmatterSchema.safeParse(parsed)
  if (!validation.success) {
    return {
      ok: false,
      errors: validation.error.issues.map((iss) => ({
        message: `${iss.path.join('.') || '<root>'}: ${iss.message}`,
      })),
    }
  }

  return { ok: true, frontmatter: validation.data, body: body.trimStart() }
}
