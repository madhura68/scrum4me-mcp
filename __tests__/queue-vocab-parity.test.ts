// PARITEITSGATE — tool-schema's versus het gedeelde queue-vocabulaire.
//
// Waarom dit bestand bestaat: het queue-vocabulaire staat canoniek in
// @shared/queue-identity.js, maar vier tools hadden ['claude','codex','jp']
// overgetypt en queue_push deed hetzelfde met de verzoek-types. Die drift kon
// niet rood worden — src/queue/types.ts importeert alleen de *types*, niet de
// runtime-arrays, dus tsc zag geen verschil — en kwam pas aan het licht toen
// 'kimi' toegevoegd werd en `as: 'kimi'` stil door Zod geweigerd bleek.
//
// LEES HET SCHEMA, NIET DE HANDLER. Het mock-serverpatroon in deze repo roept
// handlers rechtstreeks aan en slaat Zod dus over: een test die alleen
// `server.call({ as: 'kimi' })` doet is óók groen onder een hardgecodeerde
// lijst en bewijst niets. Deze gate leest daarom het inputSchema zoals het bij
// registerTool is aangeboden en toetst dáár de toegestane waarden op.
//
// De gate vangt drift in BEIDE richtingen:
//   • een ontbrekende waarde  (enum smaller dan de gedeelde lijst)
//   • een extra waarde        (enum breder — bv. een overgetypte 'gemini')
//   • een verdwenen enum      (veld naar z.string(): vocabulaire niet afgedwongen)
//   • een verdwenen veld      (dekkingstest hieronder)
//   • een nieuwe queue-tool die opnieuw overtypt (sweep hieronder)
//
// Zie ook queue-identity.test.ts (vocabulaire zelf) en
// Scrum4Me/__tests__/db/agent-message-queue-migration.test.ts (dezelfde soort
// gate, maar tussen de gedeelde module en de CHECK-constraints in de migratie).
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { registerQueueTools } from '../src/register.js'
import {
  QUEUE_MODELS,
  QUEUE_REQUEST_TYPES,
  QUEUE_RESPONSE_TYPES,
} from '@shared/queue-identity.js'

// ---------------------------------------------------------------------------
// De verwachtingstabel: welk veld van welke tool is aan welke gedeelde lijst
// gebonden. Bindt een nieuwe tool nóg een veld aan het vocabulaire, zet het
// hier neer — de sweep onderaan weigert een vocabulaire-veld dat hier ontbreekt.
// ---------------------------------------------------------------------------

const SHARED_VOCABULARIES = {
  QUEUE_MODELS,
  QUEUE_REQUEST_TYPES,
} as const satisfies Record<string, readonly string[]>

type VocabularyName = keyof typeof SHARED_VOCABULARIES

// Waarden die de enum móet weigeren. Voor de types zijn dat bewust de
// antwoord-types: queue_push verstuurt verzoeken, dus result/data/reviewed
// horen daar niet in — dat bewijst de gate meteen mee.
const REJECT_PROBES: Record<VocabularyName, readonly string[]> = {
  QUEUE_MODELS: ['gemini', 'gpt', 'llama'],
  QUEUE_REQUEST_TYPES: [...QUEUE_RESPONSE_TYPES, 'gemini'],
}

const A_UUID = 'aaaaaaaa-0000-4000-8000-000000000001'

interface BoundField {
  tool: string
  field: string
  vocabulary: VocabularyName
  /** Minimaal geldige rest van de payload; het veld zelf wordt ingevuld. */
  sample: Record<string, unknown>
}

const BOUND_FIELDS: readonly BoundField[] = [
  {
    tool: 'queue_push',
    field: 'as',
    vocabulary: 'QUEUE_MODELS',
    sample: { to: 'scrum4me-server:claude', type: 'info', body: 'x' },
  },
  {
    tool: 'queue_push',
    field: 'type',
    vocabulary: 'QUEUE_REQUEST_TYPES',
    sample: { to: 'scrum4me-server:claude', body: 'x' },
  },
  { tool: 'queue_next', field: 'as', vocabulary: 'QUEUE_MODELS', sample: {} },
  { tool: 'queue_list', field: 'as', vocabulary: 'QUEUE_MODELS', sample: {} },
  {
    tool: 'queue_wait_reply',
    field: 'as',
    vocabulary: 'QUEUE_MODELS',
    sample: { message_ids: [A_UUID] },
  },
]

// Enum-velden die bewust NIET aan de gedeelde module hangen: tool-eigen
// vocabulaire dat alleen binnen deze MCP bestaat. Alles wat hier noch in
// BOUND_FIELDS staat, laat de sweep rood worden.
const TOOL_LOCAL_ENUM_FIELDS: readonly string[] = [
  // queue_list.direction ('sent'/'received'/'both') is een presentatiefilter van
  // deze tool; de queue kent het begrip niet.
  'queue_list.direction',
]

// ---------------------------------------------------------------------------
// Schema-uitlezing
// ---------------------------------------------------------------------------

/**
 * Registreert de queue-tools op een neptserver en houdt de meta vast die aan
 * registerTool is meegegeven. Bewust via registerQueueTools() en niet via de
 * losse registrars: een nieuwe queue-tool valt dan automatisch onder de gate.
 */
function captureRegisteredTools(): Map<string, unknown> {
  const captured = new Map<string, unknown>()
  const server = {
    registerTool(name: string, meta: { inputSchema?: unknown }) {
      captured.set(name, meta)
    },
  }
  registerQueueTools(server as unknown as McpServer)
  return captured
}

const REGISTERED = captureRegisteredTools()

function metaOf(tool: string): { inputSchema?: unknown; description?: string } {
  const meta = REGISTERED.get(tool)
  if (!meta) {
    throw new Error(
      `tool '${tool}' is niet geregistreerd door registerQueueTools — ` +
        'hernoemd of verwijderd? Werk BOUND_FIELDS bij.',
    )
  }
  return meta as { inputSchema?: unknown; description?: string }
}

/**
 * Normaliseert het geregistreerde inputSchema naar een ZodObject. De MCP SDK
 * accepteert beide vormen (AnySchema óf een kale ZodRawShape); deze repo geeft
 * een z.object() mee, maar de gate mag niet omvallen als dat ooit wijzigt.
 */
function objectSchemaOf(tool: string): z.ZodObject<z.ZodRawShape> {
  const raw = metaOf(tool).inputSchema
  if (raw === undefined || raw === null) {
    throw new Error(`${tool}: geen inputSchema geregistreerd`)
  }
  const candidate = raw as { parse?: unknown; shape?: unknown }
  if (typeof candidate.parse === 'function') {
    if (!candidate.shape) {
      throw new Error(`${tool}: inputSchema is een Zod-schema maar geen object-schema`)
    }
    return raw as z.ZodObject<z.ZodRawShape>
  }
  return z.object(raw as z.ZodRawShape)
}

interface JsonSchemaProperty {
  enum?: unknown[]
  const?: unknown
}

/**
 * Zet het schema om naar JSON Schema — dezelfde voorstelling die de SDK via
 * toJsonSchemaCompat() aan de client stuurt bij tools/list, met dezelfde opties
 * (draft-7, io: 'input'). We lezen dus de toegestane waarden zoals de aanroeper
 * ze te zien krijgt, niet een Zod-intern veld.
 */
function jsonPropertiesOf(tool: string): Record<string, JsonSchemaProperty> {
  const json = z.toJSONSchema(objectSchemaOf(tool), {
    target: 'draft-7',
    io: 'input',
  }) as { properties?: Record<string, JsonSchemaProperty> }
  return json.properties ?? {}
}

/** De toegestane literalen van één veld; gooit als het veld geen enum ís. */
function allowedValuesOf(tool: string, field: string): string[] {
  const property = jsonPropertiesOf(tool)[field]
  if (!property) {
    throw new Error(
      `${tool}: veld '${field}' bestaat niet in het inputSchema — verwijderd of hernoemd?`,
    )
  }
  const values =
    property.enum ?? (property.const !== undefined ? [property.const] : undefined)
  if (!values) {
    throw new Error(
      `${tool}.${field}: het inputSchema legt geen waardenlijst op (geen enum/const). ` +
        'Een vrij veld dwingt het gedeelde vocabulaire niet af.',
    )
  }
  return values.map((value) => String(value))
}

/** Alle enum-velden van een tool — voert de sweep onderaan. */
function enumFieldsOf(tool: string): string[] {
  return Object.entries(jsonPropertiesOf(tool))
    .filter(([, property]) => Array.isArray(property.enum))
    .map(([field]) => field)
}

function parserOf(tool: string): (value: unknown) => unknown {
  const schema = objectSchemaOf(tool)
  return (value: unknown) => schema.parse(value)
}

/**
 * Bronniveau: welk argument krijgt z.enum() voor dit veld?
 *
 * Waardepariteit hierboven vangt drift zodra de lijsten inhoudelijk uiteen
 * lopen — maar een lijst die je vandaag overtypt is vandaag nog identiek, dus
 * dan blijft die groen. Precies zo ontstond deze sprint: queue_push had
 * ['task','info','review_request'] staan, exact QUEUE_REQUEST_TYPES, en het
 * werd pas een bug op het moment dat de gedeelde lijst bewoog. Deze laag
 * verbiedt de praktijk in plaats van alleen de uitkomst.
 *
 * Vindt de regex het veld niet (andere opmaak, veld weg), dan faalt de test —
 * nooit stilzwijgend groen.
 */
function enumArgumentInSource(tool: string, field: string): string {
  const path = `src/tools/${tool.replace(/_/g, '-')}.ts`
  const source = readFileSync(path, 'utf8')
  const match = new RegExp(String.raw`\b${field}:\s*z\.enum\(([^)]*)\)`).exec(source)
  if (!match) {
    throw new Error(
      `${path}: geen \`${field}: z.enum(...)\` gevonden — hernoemd, anders opgemaakt ` +
        'of geen enum meer? Werk BOUND_FIELDS of deze test bij.',
    )
  }
  return match[1].trim()
}

function importsFromSharedModule(tool: string, identifier: string): boolean {
  const source = readFileSync(`src/tools/${tool.replace(/_/g, '-')}.ts`, 'utf8')
  const importLine = /import\s*\{([^}]*)\}\s*from\s*'@shared\/queue-identity\.js'/.exec(source)
  if (!importLine) return false
  return importLine[1]
    .split(',')
    .map((name) => name.trim())
    .includes(identifier)
}

// ---------------------------------------------------------------------------
// De gate
// ---------------------------------------------------------------------------

// `$tool.$field` werkt niet als titel: vitest leest dat als één padexpressie en
// rendert 'undefined'. Een voorberekend label houdt de faalregel leesbaar — je
// moet aan de rode test kunnen zien wélke tool gedrift is.
const LABELLED_BOUND_FIELDS = BOUND_FIELDS.map((bound) => ({
  ...bound,
  label: `${bound.tool}.${bound.field} ↔ ${bound.vocabulary}`,
}))

describe('pariteitsgate — tool-schema ↔ @shared/queue-identity', () => {
  describe.each(LABELLED_BOUND_FIELDS)('$label', (bound) => {
    const shared = SHARED_VOCABULARIES[bound.vocabulary]

    it('laat exact het gedeelde vocabulaire toe — geen ontbrekende, geen extra waarde', () => {
      // Als verzameling: de volgorde van een enum heeft hier geen betekenis,
      // maar het lidmaatschap wél. Beide richtingen tellen als drift.
      const allowed = allowedValuesOf(bound.tool, bound.field)
      expect(new Set(allowed), `${bound.label}: schema en gedeelde lijst lopen uiteen`).toEqual(
        new Set(shared),
      )
      // Geen dubbelen: een verzameling zou een overgetypte dubbele waarde verbergen.
      expect(allowed, `${bound.label}: dubbele waarde in de enum`).toHaveLength(shared.length)
    })

    it('accepteert bij parse() elke waarde uit de gedeelde lijst', () => {
      // Tweede, onafhankelijke laag: bewijst dat de JSON-Schema-uitlezing
      // hierboven het echte validatiegedrag beschrijft en niet iets afgeleids.
      const parse = parserOf(bound.tool)
      for (const value of shared) {
        expect(
          () => parse({ ...bound.sample, [bound.field]: value }),
          `${bound.label}: '${value}' staat in de gedeelde lijst maar wordt geweigerd`,
        ).not.toThrow()
      }
    })

    it('verwijst in de bron naar de gedeelde constante en typt geen lijst over', () => {
      // Derde laag, op bronniveau: waardepariteit kan een overgetypte lijst die
      // vandaag toevallig klopt niet zien. Deze wél.
      const argument = enumArgumentInSource(bound.tool, bound.field)
      expect(
        argument,
        `${bound.tool}.${bound.field}: z.enum(${argument}) typt het vocabulaire over — ` +
          `gebruik z.enum(${bound.vocabulary}) uit @shared/queue-identity.js`,
      ).toBe(bound.vocabulary)
      expect(
        importsFromSharedModule(bound.tool, bound.vocabulary),
        `${bound.tool} importeert ${bound.vocabulary} niet uit @shared/queue-identity.js`,
      ).toBe(true)
    })

    it('weigert bij parse() waarden buiten de gedeelde lijst', () => {
      const parse = parserOf(bound.tool)
      for (const value of REJECT_PROBES[bound.vocabulary]) {
        expect(
          () => parse({ ...bound.sample, [bound.field]: value }),
          `${bound.tool}.${bound.field} had '${value}' moeten weigeren`,
        ).toThrow()
      }
    })
  })

  it('bindt élk enum-veld van élke queue-tool bewust: gebonden of expliciet tool-eigen', () => {
    // Dekkingstest én sweep in één. Hij wordt rood wanneer:
    //   • een nieuwe queue-tool een 'as'/'type'-enum overtypt (niet in de tabel)
    //   • een gebonden veld uit een schema verdwijnt of geen enum meer is
    //     (dan mist het paar in `found` en klopt de vergelijking niet meer)
    const bound = new Set(BOUND_FIELDS.map((f) => `${f.tool}.${f.field}`))
    const local = new Set(TOOL_LOCAL_ENUM_FIELDS)
    const found = new Set<string>()
    for (const tool of REGISTERED.keys()) {
      for (const field of enumFieldsOf(tool)) found.add(`${tool}.${field}`)
    }
    expect(found).toEqual(new Set([...bound, ...local]))
  })

  it('somt in de queue_push-omschrijving het echte modelvocabulaire op', () => {
    // De omschrijving is wat de aanroeper leest vóór hij een payload bouwt; die
    // mag niet over kimi liegen terwijl het schema hem wél accepteert.
    const description = metaOf('queue_push').description ?? ''
    for (const model of QUEUE_MODELS) {
      expect(description, `queue_push-omschrijving noemt '${model}' niet`).toContain(model)
    }
  })
})

// M30 P0.4: de pin-witness — de gevendorde module draagt het job-namespace.
// Geen nieuwe entries in de pariteitstabel hierboven (de gesloten enums zijn
// ongewijzigd; de discriminatie leeft in parseQueueAddress), maar wél één
// acceptatieprobe zodat een terugval van de gitlink naar een pre-M30 SHA hier
// rood wordt in plaats van pas bij een echte push.
describe('M30 job-namespace via de pin', () => {
  it('de gevendorde module accepteert een scrum4us-job-adres', async () => {
    const shared = await import('@shared/queue-identity.js')
    expect(shared.QUEUE_JOB_SERVER).toBe('scrum4us-job')
    expect(shared.parseQueueAddress('scrum4us-job:cmxyzjobid1')).toEqual({
      server: 'scrum4us-job',
      jobId: 'cmxyzjobid1',
    })
  })
})
