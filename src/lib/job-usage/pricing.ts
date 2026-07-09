export type PricingModelSource = 'observed' | 'job_config' | 'pricing_default'

export type ResolvedPricingModel = {
  pricing_model_id: string
  pricing_model_source: PricingModelSource
}
