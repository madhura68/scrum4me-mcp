import type { ModelPrice } from '@prisma/client'

import { prisma } from '../../prisma.js'
import type { PricingModelSource } from './types.js'
import type { WorkerRuntime } from './types.js'

export type CodexPricingModelInput = {
  observedModelId?: string | null
  cliModelId?: string | null
  pricingDefaultModelId?: string | null
}

export type ResolvedCodexPricingModel = {
  modelId: string | null
  pricingModelId: string | null
  pricingModelSource: PricingModelSource | null
}

export type SubscriptionRateCardCriteria = {
  runtime: WorkerRuntime
  provider: 'anthropic' | 'openai'
  modelId: string
  billingMode: 'SUBSCRIPTION'
  billingUnit: 'USD_PROXY' | 'CREDITS'
  serviceTier: string
}

export type SubscriptionRateCardWhere = {
  runtime_provider_model_id_billing_mode_billing_unit_service_tier: {
    runtime: WorkerRuntime
    provider: 'anthropic' | 'openai'
    model_id: string
    billing_mode: 'SUBSCRIPTION'
    billing_unit: 'USD_PROXY' | 'CREDITS'
    service_tier: string
  }
}

export type BuildSubscriptionRateCardCriteriaResult =
  | { status: 'ready'; criteria: SubscriptionRateCardCriteria; where: SubscriptionRateCardWhere }
  | { status: 'missing_model'; criteria: null; where: null }

export type FindSubscriptionRateCardResult =
  | { status: 'found'; criteria: SubscriptionRateCardCriteria; rateCard: ModelPrice }
  | { status: 'missing_rate_card'; criteria: SubscriptionRateCardCriteria; rateCard: null }
  | { status: 'missing_model'; criteria: null; rateCard: null }

type RateCardLookupClient = {
  modelPrice: {
    findUnique(args: { where: SubscriptionRateCardWhere }): Promise<ModelPrice | null>
  }
}

function cleanModelId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function getCodexPricingModelDefault(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return cleanModelId(env.CODEX_PRICING_MODEL_ID)
}

export function resolveCodexPricingModel(
  input: CodexPricingModelInput,
): ResolvedCodexPricingModel {
  const observedModelId = cleanModelId(input.observedModelId)
  if (observedModelId) {
    return {
      modelId: observedModelId,
      pricingModelId: observedModelId,
      pricingModelSource: 'observed_event',
    }
  }

  const cliModelId = cleanModelId(input.cliModelId)
  if (cliModelId) {
    return {
      modelId: cliModelId,
      pricingModelId: cliModelId,
      pricingModelSource: 'cli_model',
    }
  }

  const pricingDefaultModelId = cleanModelId(input.pricingDefaultModelId)
  if (pricingDefaultModelId) {
    return {
      modelId: null,
      pricingModelId: pricingDefaultModelId,
      pricingModelSource: 'pricing_default',
    }
  }

  return {
    modelId: null,
    pricingModelId: null,
    pricingModelSource: null,
  }
}

export function buildSubscriptionRateCardCriteria(input: {
  runtime: WorkerRuntime
  modelId?: string | null
  pricingModelId?: string | null
  serviceTier?: string | null
}): BuildSubscriptionRateCardCriteriaResult {
  const modelId = cleanModelId(input.pricingModelId) ?? cleanModelId(input.modelId)
  if (!modelId) {
    return { status: 'missing_model', criteria: null, where: null }
  }

  const provider = input.runtime === 'CODEX' ? 'openai' : 'anthropic'
  const billingUnit = input.runtime === 'CODEX' ? 'CREDITS' : 'USD_PROXY'
  const serviceTier = cleanModelId(input.serviceTier) ?? 'standard'
  const criteria: SubscriptionRateCardCriteria = {
    runtime: input.runtime,
    provider,
    modelId,
    billingMode: 'SUBSCRIPTION',
    billingUnit,
    serviceTier,
  }

  return {
    status: 'ready',
    criteria,
    where: {
      runtime_provider_model_id_billing_mode_billing_unit_service_tier: {
        runtime: criteria.runtime,
        provider: criteria.provider,
        model_id: criteria.modelId,
        billing_mode: criteria.billingMode,
        billing_unit: criteria.billingUnit,
        service_tier: criteria.serviceTier,
      },
    },
  }
}

export async function findSubscriptionRateCard(
  input: Parameters<typeof buildSubscriptionRateCardCriteria>[0],
  client: RateCardLookupClient = prisma,
): Promise<FindSubscriptionRateCardResult> {
  const lookup = buildSubscriptionRateCardCriteria(input)
  if (lookup.status === 'missing_model') {
    return { status: 'missing_model', criteria: null, rateCard: null }
  }

  const rateCard = await client.modelPrice.findUnique({ where: lookup.where })
  if (!rateCard) {
    return { status: 'missing_rate_card', criteria: lookup.criteria, rateCard: null }
  }

  return { status: 'found', criteria: lookup.criteria, rateCard }
}
