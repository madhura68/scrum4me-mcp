// De kostenmelding van een HARNESS-job (M45, spec §6.2): de harness meldt bij de eindstatus van een job een bedrag in
// USD, de bron ervan en de aanbieder; update_job_status legt dat vast in job_cost_reports. Deze module is Prisma-vrij
// en puur: bedragen zijn decimale strings, nooit een number of een Decimal, en de MCP verzint er nooit een.
import { isHarnessJobKind, type HarnessCostSource } from '@shared/harness-config.js'

// Decimal(12,6): hoogstens 6 cijfers vóór en 6 cijfers na de komma.
const MAX_INTEGER_DIGITS = 6
const SCALE = 6

// Alleen gewone decimale notatie; sluit exponent (1e-2), teken, spaties, '.5' en '5.' uit. \d is in JavaScript alleen
// 0-9, en $ zonder m-vlag alleen het einde van de string (dus ook geen afsluitende newline).
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/

// Een geldig bedrag is veel korter: zes cijfers, een punt, zes decimalen en een staart die alleen meetelt als hij naar
// boven afrondt (een JS-som geeft '0.00031200000000000005', 22 tekens). Het schema van update_job_status begrenst de
// lengte van de string niet, dus de parser doet het zelf, als allereerste stap.
const MAX_INPUT_LENGTH = 64

/**
 * Een bedrag ≥ 0 in gewone decimale notatie, naar boven afgerond op 6 decimalen, dat in Decimal(12,6) past,
 * genormaliseerd; anders null. Alleen stringbewerkingen (BigInt), geen float.
 *
 * Geen exponent, geen teken, hoogstens 6 cijfers vóór de komma (ook na het afronden). Meer dan 6 decimalen wordt naar
 * boven afgerond: een JS-som van bedragen geeft al snel '0.00031200000000000005', en een weigering zou de hele
 * eindstatus van de job blokkeren. Naar boven afronden verzint geen bedrag en meldt nooit te weinig. Nullen achter de
 * zesde decimaal tellen niet: dat is geen extra bedrag. Een invoer van meer dan 64 tekens is nooit een bedrag (null),
 * ook niet als hij uit alleen nullen en een enkel cijfer bestaat.
 */
export function parseReportedCostUsd(value: string): string | null {
  // Eerst de lengte, vóór elk patroon en elke BigInt-bewerking: een lange invoer kost zo niets. Daarna is de invoer
  // hoogstens 64 tekens, dus elke bewerking hieronder is begrensd (en geen enkel patroon loopt terug).
  if (value.length > MAX_INPUT_LENGTH) return null
  if (!PLAIN_DECIMAL.test(value)) return null

  const dot = value.indexOf('.')
  const integer = dot === -1 ? value : value.slice(0, dot)
  const fraction = dot === -1 ? '' : value.slice(dot + 1)

  // Het bedrag in miljoenste dollars, als geheel getal: de cijfers vóór de komma en de eerste zes erna, exact in BigInt.
  // Een niet-nul cijfer achter de zesde decimaal telt één miljoenste bij: naar boven afronden.
  let micros = BigInt(integer + fraction.slice(0, SCALE).padEnd(SCALE, '0'))
  if (/[1-9]/.test(fraction.slice(SCALE))) micros += 1n

  const digits = micros.toString().padStart(SCALE + 1, '0')
  const whole = digits.slice(0, -SCALE)
  // Zeven of meer cijfers vóór de komma passen niet in Decimal(12,6), ook als het pas door het afronden zo wordt
  // (999999.9999999).
  if (whole.length > MAX_INTEGER_DIGITS) return null
  // Altijd precies 6 tekens, dus ook /0+$/ is hier veilig.
  const decimals = digits.slice(-SCALE).replace(/0+$/, '')
  return decimals === '' ? whole : `${whole}.${decimals}`
}

/** Het `cost`-object van update_job_status (de MCP-invoer). */
export type CostReportInput = {
  reported_cost_usd: string | null
  cost_source: HarnessCostSource
  provider?: string
}

/** De rij in job_cost_reports, zonder job_id en reported_at (die zet de handler). */
export type CostReportRow = {
  reported_cost_usd: string | null
  cost_source: HarnessCostSource
  provider: string | null
  configuration: string
}

const NOT_ALLOWED = 'VALIDATION_ERROR: COST_REPORT_NOT_ALLOWED'
const INVALID = 'VALIDATION_ERROR: COST_REPORT_INVALID'

/**
 * Mag deze job kosten melden, en klopt de melding? Alleen een job met runtime HARNESS (niet een local_llm-job: die
 * heeft runtime CLAUDE en meldt geen kosten), alleen van een soort die HARNESS draait (isHarnessJobKind: IDEA_CHAT en
 * TASK_IMPLEMENTATION) en alleen bij een eindstatus. De eigen eindpaden van DOCS_AUDIT en DEPLOY (en van elke andere
 * soort) schrijven nooit een kostenrij: een melding die daar geldig leek, zou stil verdwijnen, dus geen melding. De
 * configuratie is die van de job (`requested_model`, gezet bij de enqueue), nooit die uit de melding. Regels per bron:
 * `none` ⇔ geen bedrag, `local` vraagt bedrag 0, `provider_reported` en `litellm_computed` vragen een bedrag ≥ 0.
 *
 * De aanroeper roept dit aan vóór elk neveneffect (de verify-gate en de push), zodat een weigering geen gepushte branch
 * achterlaat bij een job die RUNNING blijft.
 */
export function checkCostReport(
  job: { kind: string; runtime: string; requested_model: string | null },
  status: 'running' | 'done' | 'failed' | 'skipped',
  cost: CostReportInput,
): { allowed: true; row: CostReportRow } | { allowed: false; error: string } {
  if (job.runtime !== 'HARNESS' || !isHarnessJobKind(job.kind) || status === 'running') {
    return { allowed: false, error: NOT_ALLOWED }
  }
  if (!job.requested_model) return { allowed: false, error: INVALID }

  const amount = cost.reported_cost_usd === null ? null : parseReportedCostUsd(cost.reported_cost_usd)
  const valid =
    cost.cost_source === 'none'
      ? cost.reported_cost_usd === null
      : cost.cost_source === 'local'
        ? amount === '0'
        : cost.cost_source === 'provider_reported' || cost.cost_source === 'litellm_computed'
          ? amount !== null
          : false // een onbekende bron wordt nooit stil geaccepteerd
  if (!valid) return { allowed: false, error: INVALID }

  return {
    allowed: true,
    row: {
      reported_cost_usd: amount,
      cost_source: cost.cost_source,
      provider: cost.provider ?? null,
      configuration: job.requested_model,
    },
  }
}
