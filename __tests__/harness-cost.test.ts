// M45-2b Taak 4 (spec §6.2): de kostenmelding van een HARNESS-job. Twee pure functies, zonder database:
// parseReportedCostUsd zet een gemeld bedrag om naar het opslagformaat (Decimal(12,6), als string) en
// checkCostReport beslist of deze job kosten mag melden en of de melding klopt. De handler-bedrading (vóór elk
// neveneffect, in dezelfde transactie) staat in update-job-status-harness-cost.test.ts en
// update-job-status-idea-chat.test.ts.
import { describe, expect, it, vi } from 'vitest'
import { ClaudeJobKind } from '@prisma/client'
import { checkCostReport, parseReportedCostUsd } from '../src/lib/harness-cost.js'

const NOT_ALLOWED = 'VALIDATION_ERROR: COST_REPORT_NOT_ALLOWED'
const INVALID = 'VALIDATION_ERROR: COST_REPORT_INVALID'

describe('parseReportedCostUsd: gewone decimale notatie, genormaliseerd', () => {
  it.each([
    { input: '0', expected: '0' },
    { input: '0.0', expected: '0' },
    { input: '000', expected: '0' },
    { input: '0.000000', expected: '0' },
    { input: '1', expected: '1' },
    { input: '1.5', expected: '1.5' },
    { input: '1.500000', expected: '1.5' },
    { input: '007.50', expected: '7.5' },
    { input: '0.5', expected: '0.5' },
    { input: '0.000312', expected: '0.000312' },
    { input: '0.000001', expected: '0.000001' },
    { input: '5.000', expected: '5' },
  ])('$input wordt $expected', ({ input, expected }) => {
    expect(parseReportedCostUsd(input)).toBe(expected)
  })
})

describe('parseReportedCostUsd: meer dan zes decimalen wordt naar boven afgerond', () => {
  // Een JS-som van bedragen per aanroep geeft al snel 0.00031200000000000005; een weigering zou de hele eindstatus
  // van de job blokkeren. Naar boven afronden verzint geen bedrag en meldt nooit te weinig.
  it.each([
    { input: '0.00031200000000000005', expected: '0.000313' },
    { input: '0.0000001', expected: '0.000001' },
    { input: '0.0000009', expected: '0.000001' },
    { input: '0.1000001', expected: '0.100001' },
    { input: '2.0000000000000000000001', expected: '2.000001' },
    // Nullen na de zesde decimaal tellen niet mee: dat is geen extra bedrag.
    { input: '0.0000010', expected: '0.000001' },
    { input: '0.1000000', expected: '0.1' },
    { input: '3.50000000000000000000', expected: '3.5' },
    // Het optellen kan doorlopen naar het gehele deel.
    { input: '0.9999999', expected: '1' },
    { input: '9.9999995', expected: '10' },
    { input: '0.1999999', expected: '0.2' },
  ])('$input wordt $expected', ({ input, expected }) => {
    expect(parseReportedCostUsd(input)).toBe(expected)
  })

  it('rekent exact in decimalen, niet met floats: een niet-nul cijfer ver achter de komma telt nog mee', () => {
    // Number('0.0000010000000000000001') is 0.000001: een float-implementatie ziet het laatste cijfer niet en meldt
    // te weinig. Exact decimaal is het bedrag groter dan 0.000001, dus afgerond naar boven 0.000002.
    expect(parseReportedCostUsd('0.0000010000000000000001')).toBe('0.000002')
  })

  it('weigert een zeer lange invoer snel (geen regex die kwadratisch terugloopt)', () => {
    // Het schema van de tool begrenst de string niet; een patroon als /0+$/ over een lange rij nullen gevolgd door een 1 loopt
    // kwadratisch terug. De parser weigert elke invoer boven 64 tekens vóór enig patroon of BigInt-werk (zie het blok
    // hieronder), dus 100.000 tekens kosten niets en de test loopt niet in zijn tijdslimiet.
    const long = '0.' + '0'.repeat(100_000) + '1'
    expect(parseReportedCostUsd(long)).toBeNull()
    expect(parseReportedCostUsd('0'.repeat(100_000) + '5')).toBeNull()
    expect(parseReportedCostUsd('1.5' + '0'.repeat(100_000))).toBeNull()
  }, 2_000)
})

describe('parseReportedCostUsd: de lengte van de invoer is begrensd op 64 tekens', () => {
  // Een geldig bedrag is veel korter: zes cijfers, een punt, zes decimalen en een staart die alleen meetelt als hij naar
  // boven afrondt. Het schema van de tool begrenst de lengte niet, dus de parser doet het zelf, als allereerste stap.
  const padded = (length: number) => '0.' + '0'.repeat(length - 3) + '1' // geldig bedrag, rondt af naar 0.000001

  it('neemt een invoer van precies 64 tekens nog aan', () => {
    expect(padded(64)).toHaveLength(64)
    expect(parseReportedCostUsd(padded(64))).toBe('0.000001')
  })

  it('weigert een invoer van 65 tekens, ook als hij verder een geldig bedrag is', () => {
    expect(padded(65)).toHaveLength(65)
    expect(parseReportedCostUsd(padded(65))).toBeNull()
    expect(parseReportedCostUsd('0'.repeat(65))).toBeNull()
    expect(parseReportedCostUsd('1' + '0'.repeat(64))).toBeNull()
  })

  it.each([100, 1_000, 100_000])('weigert een invoer van %i tekens zonder BigInt- of patroonwerk', (length) => {
    // Deterministisch, geen tijdmeting: een lange invoer mag geen enkele BigInt-aanroep en geen enkel patroon raken. De
    // spionnen staan alleen om de parser heen: de assertions zelf (die intern ook patronen gebruiken) komen erna.
    const bigInt = vi.spyOn(globalThis, 'BigInt')
    const test = vi.spyOn(RegExp.prototype, 'test')
    let result: string | null
    let bigIntCalls: number
    let testCalls: number
    try {
      result = parseReportedCostUsd(padded(length))
    } finally {
      bigIntCalls = bigInt.mock.calls.length
      testCalls = test.mock.calls.length
      bigInt.mockRestore()
      test.mockRestore()
    }
    expect(result).toBeNull()
    expect(bigIntCalls).toBe(0)
    expect(testCalls).toBe(0)
  })

  it('de grens zit in de parser, dus ook checkCostReport weigert een bedrag van 65 tekens als ongeldig', () => {
    const job = { kind: 'TASK_IMPLEMENTATION', runtime: 'HARNESS', requested_model: 'gsq-lokaal' }
    expect(checkCostReport(job, 'done', { reported_cost_usd: padded(65), cost_source: 'provider_reported' })).toEqual({
      allowed: false,
      error: INVALID,
    })
    expect(checkCostReport(job, 'done', { reported_cost_usd: padded(64), cost_source: 'provider_reported' })).toMatchObject({
      allowed: true,
      row: { reported_cost_usd: '0.000001' },
    })
  })
})

describe('parseReportedCostUsd: past in Decimal(12,6), hoogstens zes cijfers vóór de komma', () => {
  it('neemt het grootste bedrag dat past', () => {
    expect(parseReportedCostUsd('999999.999999')).toBe('999999.999999')
    expect(parseReportedCostUsd('999999')).toBe('999999')
  })

  it.each(['1000000', '1000000.5', '1234567', '10000000'])('weigert %s: zeven cijfers vóór de komma', (input) => {
    expect(parseReportedCostUsd(input)).toBeNull()
  })

  it('weigert een bedrag dat pas door het naar boven afronden over de grens gaat', () => {
    expect(parseReportedCostUsd('999999.9999999')).toBeNull()
    expect(parseReportedCostUsd('999999.9999990000001')).toBeNull()
    // Nullen erachter veranderen niets: dit past nog.
    expect(parseReportedCostUsd('999999.9999990000000')).toBe('999999.999999')
  })

  it('telt voorloopnullen niet mee voor de grens', () => {
    expect(parseReportedCostUsd('0000000001')).toBe('1')
    expect(parseReportedCostUsd('0000999999.5')).toBe('999999.5')
  })
})

describe('parseReportedCostUsd: weigert alles wat geen gewone decimale notatie is', () => {
  it.each([
    { label: 'een lege string', input: '' },
    { label: 'alleen spaties', input: '   ' },
    { label: 'een exponent (kleine e)', input: '1e5' },
    { label: 'een exponent (hoofdletter E)', input: '1E5' },
    { label: 'een negatieve exponent', input: '1e-7' },
    { label: 'een min-teken', input: '-1' },
    { label: 'een negatieve nul', input: '-0' },
    { label: 'een min-teken voor een decimaal', input: '-0.5' },
    { label: 'een plus-teken', input: '+1' },
    { label: 'geen cijfer vóór de komma', input: '.5' },
    { label: 'geen cijfer achter de komma', input: '5.' },
    { label: 'twee punten', input: '1.2.3' },
    { label: 'een komma als scheidingsteken', input: '1,5' },
    { label: 'een underscore', input: '1_000' },
    { label: 'hexadecimaal', input: '0x10' },
    { label: 'tekst', input: 'abc' },
    { label: 'NaN', input: 'NaN' },
    { label: 'Infinity', input: 'Infinity' },
    { label: 'een spatie ervoor', input: ' 1' },
    { label: 'een spatie erachter', input: '1 ' },
    { label: 'een newline erachter', input: '1\n' },
    { label: 'cijfers uit een ander schrift (brede cijfers)', input: '１２' },
  ])('weigert $label', ({ input }) => {
    expect(parseReportedCostUsd(input)).toBeNull()
  })
})

describe('checkCostReport: wie mag kosten melden', () => {
  const cost = { reported_cost_usd: '0.000313', cost_source: 'provider_reported', provider: 'openrouter' } as const

  it.each([
    { label: 'een Claude-job', runtime: 'CLAUDE' },
    { label: 'een Codex-job', runtime: 'CODEX' },
  ])('weigert $label: alleen een HARNESS-job meldt kosten', ({ runtime }) => {
    expect(checkCostReport({ kind: 'TASK_IMPLEMENTATION', runtime, requested_model: 'gsq-lokaal' }, 'done', cost)).toEqual({
      allowed: false,
      error: NOT_ALLOWED,
    })
  })

  it('weigert een melding bij running: kosten horen bij de eindstatus', () => {
    expect(checkCostReport({ kind: 'TASK_IMPLEMENTATION', runtime: 'HARNESS', requested_model: 'gsq-lokaal' }, 'running', cost)).toEqual({
      allowed: false,
      error: NOT_ALLOWED,
    })
  })

  it.each(['done', 'failed', 'skipped'] as const)('staat een melding toe bij %s', (status) => {
    const result = checkCostReport({ kind: 'TASK_IMPLEMENTATION', runtime: 'HARNESS', requested_model: 'gsq-lokaal' }, status, cost)
    expect(result.allowed).toBe(true)
  })
})

describe('checkCostReport: de soort van de job begrenst de melding', () => {
  const cost = { reported_cost_usd: '0.000313', cost_source: 'provider_reported', provider: 'openrouter' } as const
  const HARNESS_KINDS = ['IDEA_CHAT', 'TASK_IMPLEMENTATION']

  it.each(HARNESS_KINDS)('staat een melding van een HARNESS-job van soort %s toe', (kind) => {
    const result = checkCostReport({ kind, runtime: 'HARNESS', requested_model: 'gsq-lokaal' }, 'done', cost)
    expect(result.allowed).toBe(true)
  })

  // De eindpaden van DOCS_AUDIT en DEPLOY (en van elke andere soort dan de twee HARNESS-soorten) schrijven nooit een
  // kostenrij: een melding die daar geldig leek, zou stil verdwijnen. Dus ook bij runtime HARNESS geen melding. Een
  // nieuwe soort in de enum valt hier vanzelf onder "geweigerd" tot iemand bewust anders beslist.
  it.each(Object.values(ClaudeJobKind).filter((kind) => !HARNESS_KINDS.includes(kind)))(
    'weigert een melding van een HARNESS-job van soort %s: dat eindpad schrijft geen kostenrij',
    (kind) => {
      for (const status of ['done', 'failed', 'skipped'] as const) {
        expect(checkCostReport({ kind, runtime: 'HARNESS', requested_model: 'gsq-lokaal' }, status, cost)).toEqual({
          allowed: false,
          error: NOT_ALLOWED,
        })
      }
    },
  )

  it('de soortgrens komt vóór de inhoudelijke controle: een ongeldige melding van een niet-HARNESS-soort is NOT_ALLOWED, niet INVALID', () => {
    expect(
      checkCostReport(
        { kind: 'DEPLOY', runtime: 'HARNESS', requested_model: 'gsq-lokaal' },
        'done',
        { reported_cost_usd: '1e-5', cost_source: 'provider_reported' },
      ),
    ).toEqual({ allowed: false, error: NOT_ALLOWED })
  })
})

describe('checkCostReport: de regels per bron', () => {
  const job = { kind: 'TASK_IMPLEMENTATION', runtime: 'HARNESS', requested_model: 'gsq-lokaal' }

  it.each([
    // none ⇔ geen bedrag: de harness verzint er geen.
    { source: 'none', amount: null, stored: null },
    // local vraagt precies 0 (een gemeten feit); de nul mag in elke notatie.
    { source: 'local', amount: '0', stored: '0' },
    { source: 'local', amount: '0.000', stored: '0' },
    // provider_reported en litellm_computed vragen een bedrag ≥ 0.
    { source: 'provider_reported', amount: '0.000313', stored: '0.000313' },
    { source: 'provider_reported', amount: '0', stored: '0' },
    { source: 'provider_reported', amount: '12.5', stored: '12.5' },
    { source: 'litellm_computed', amount: '0.0042', stored: '0.0042' },
    { source: 'litellm_computed', amount: '0', stored: '0' },
    // Het bedrag gaat door parseReportedCostUsd: naar boven afgerond op zes decimalen.
    { source: 'provider_reported', amount: '0.00031200000000000005', stored: '0.000313' },
    { source: 'litellm_computed', amount: '0.0000001', stored: '0.000001' },
  ] as const)('accepteert $source met bedrag $amount en bewaart $stored', ({ source, amount, stored }) => {
    const result = checkCostReport(job, 'done', { reported_cost_usd: amount, cost_source: source })
    expect(result).toEqual({
      allowed: true,
      row: { reported_cost_usd: stored, cost_source: source, provider: null, configuration: 'gsq-lokaal' },
    })
  })

  it.each([
    { label: 'none met een bedrag', source: 'none', amount: '0' },
    { label: 'none met een positief bedrag', source: 'none', amount: '0.5' },
    { label: 'local zonder bedrag', source: 'local', amount: null },
    { label: 'local met een positief bedrag', source: 'local', amount: '0.01' },
    // Een bedrag onder de zesde decimaal rondt naar boven af, en 0.000001 is niet 0: local blijft dan geweigerd.
    { label: 'local met een bedrag dat naar boven afrondt tot meer dan nul', source: 'local', amount: '0.0000001' },
    { label: 'provider_reported zonder bedrag', source: 'provider_reported', amount: null },
    { label: 'provider_reported met een lege string', source: 'provider_reported', amount: '' },
    { label: 'provider_reported met een negatief bedrag', source: 'provider_reported', amount: '-1' },
    { label: 'provider_reported met een exponent', source: 'provider_reported', amount: '1e-5' },
    { label: 'provider_reported met zeven cijfers vóór de komma', source: 'provider_reported', amount: '1000000' },
    { label: 'litellm_computed zonder bedrag', source: 'litellm_computed', amount: null },
    { label: 'litellm_computed met een teken', source: 'litellm_computed', amount: '+1' },
    { label: 'litellm_computed met tekst', source: 'litellm_computed', amount: 'veel' },
    { label: 'een onbekende bron', source: 'gokje', amount: '0.1' },
  ] as const)('weigert $label', ({ source, amount }) => {
    const result = checkCostReport(job, 'done', { reported_cost_usd: amount, cost_source: source as never })
    expect(result).toEqual({ allowed: false, error: INVALID })
  })
})

describe('checkCostReport: de rij die geschreven wordt', () => {
  it('neemt de configuratie van de job, niet van de melding', () => {
    const result = checkCostReport(
      { kind: 'TASK_IMPLEMENTATION', runtime: 'HARNESS', requested_model: 'qwen3-coder' },
      'done',
      { reported_cost_usd: '0.5', cost_source: 'provider_reported', provider: 'openrouter' },
    )
    expect(result).toEqual({
      allowed: true,
      row: { reported_cost_usd: '0.5', cost_source: 'provider_reported', provider: 'openrouter', configuration: 'qwen3-coder' },
    })
  })

  it.each([
    { label: 'null', requested_model: null },
    { label: 'een lege string', requested_model: '' },
  ])('weigert een job zonder configuratie ($label): de MCP verzint er geen', ({ requested_model }) => {
    const result = checkCostReport(
      { kind: 'TASK_IMPLEMENTATION', runtime: 'HARNESS', requested_model },
      'done',
      { reported_cost_usd: '0.5', cost_source: 'provider_reported' },
    )
    expect(result).toEqual({ allowed: false, error: INVALID })
  })

  it('schrijft provider als null als de melding er geen heeft', () => {
    const result = checkCostReport(
      { kind: 'TASK_IMPLEMENTATION', runtime: 'HARNESS', requested_model: 'gsq-lokaal' },
      'failed',
      { reported_cost_usd: null, cost_source: 'none' },
    )
    expect(result).toEqual({
      allowed: true,
      row: { reported_cost_usd: null, cost_source: 'none', provider: null, configuration: 'gsq-lokaal' },
    })
  })
})
