import type { ModelPrice } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'

import {
  buildSubscriptionRateCardCriteria,
  findSubscriptionRateCard,
} from '../../src/lib/job-usage/pricing.js'

describe('buildSubscriptionRateCardCriteria', () => {
  it('uses pricing_model_id before runtime model_id for Codex credit rate cards', () => {
    expect(
      buildSubscriptionRateCardCriteria({
        runtime: 'CODEX',
        modelId: 'gpt-5.5-codex',
        pricingModelId: 'gpt-5.4',
      }),
    ).toEqual({
      status: 'ready',
      criteria: {
        runtime: 'CODEX',
        provider: 'openai',
        modelId: 'gpt-5.4',
        billingMode: 'SUBSCRIPTION',
        billingUnit: 'CREDITS',
        serviceTier: 'standard',
      },
      where: {
        runtime_provider_model_id_billing_mode_billing_unit_service_tier: {
          runtime: 'CODEX',
          provider: 'openai',
          model_id: 'gpt-5.4',
          billing_mode: 'SUBSCRIPTION',
          billing_unit: 'CREDITS',
          service_tier: 'standard',
        },
      },
    })
  })

  it('keeps Claude subscription prices on USD proxy rows', () => {
    expect(
      buildSubscriptionRateCardCriteria({
        runtime: 'CLAUDE',
        modelId: 'claude-sonnet-4-6',
        pricingModelId: null,
      }),
    ).toMatchObject({
      status: 'ready',
      criteria: {
        runtime: 'CLAUDE',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        billingMode: 'SUBSCRIPTION',
        billingUnit: 'USD_PROXY',
        serviceTier: 'standard',
      },
    })
  })

  it('reports missing_model when neither observed nor pricing model is available', () => {
    expect(
      buildSubscriptionRateCardCriteria({
        runtime: 'CODEX',
        modelId: null,
        pricingModelId: null,
      }),
    ).toEqual({ status: 'missing_model', criteria: null, where: null })
  })
})

describe('findSubscriptionRateCard', () => {
  it('finds Codex rate cards through the subscription credits composite key', async () => {
    const rateCard = { id: 'price-1' } as ModelPrice
    const findUnique = vi.fn().mockResolvedValue(rateCard)

    const result = await findSubscriptionRateCard(
      {
        runtime: 'CODEX',
        modelId: 'gpt-5.5-codex',
        pricingModelId: 'gpt-5.4',
      },
      { modelPrice: { findUnique } },
    )

    expect(result).toEqual({
      status: 'found',
      criteria: {
        runtime: 'CODEX',
        provider: 'openai',
        modelId: 'gpt-5.4',
        billingMode: 'SUBSCRIPTION',
        billingUnit: 'CREDITS',
        serviceTier: 'standard',
      },
      rateCard,
    })
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        runtime_provider_model_id_billing_mode_billing_unit_service_tier: {
          runtime: 'CODEX',
          provider: 'openai',
          model_id: 'gpt-5.4',
          billing_mode: 'SUBSCRIPTION',
          billing_unit: 'CREDITS',
          service_tier: 'standard',
        },
      },
    })
  })

  it('returns missing_rate_card with the criteria when no row exists', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)

    const result = await findSubscriptionRateCard(
      {
        runtime: 'CLAUDE',
        modelId: 'claude-opus-4-8',
        pricingModelId: null,
      },
      { modelPrice: { findUnique } },
    )

    expect(result).toEqual({
      status: 'missing_rate_card',
      criteria: {
        runtime: 'CLAUDE',
        provider: 'anthropic',
        modelId: 'claude-opus-4-8',
        billingMode: 'SUBSCRIPTION',
        billingUnit: 'USD_PROXY',
        serviceTier: 'standard',
      },
      rateCard: null,
    })
  })

  it('does not query the database when the model id is missing', async () => {
    const findUnique = vi.fn()

    await expect(
      findSubscriptionRateCard(
        {
          runtime: 'CODEX',
          modelId: null,
          pricingModelId: null,
        },
        { modelPrice: { findUnique } },
      ),
    ).resolves.toEqual({ status: 'missing_model', criteria: null, rateCard: null })
    expect(findUnique).not.toHaveBeenCalled()
  })
})
