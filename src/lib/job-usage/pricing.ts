import type { PricingModelSource } from './types.js'

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
