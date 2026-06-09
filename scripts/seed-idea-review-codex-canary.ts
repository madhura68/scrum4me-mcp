// seed-idea-review-codex-canary.ts — create one claimable IDEA_REVIEW_PLAN CODEX
// job for the Phase 1 canary, against a throwaway PLAN_READY idea whose plan_md is
// deliberately improvable (so the 3-round rewrite has real work to do).
// Usage: CANARY_PRODUCT_ID=<id> npx tsx scripts/seed-idea-review-codex-canary.ts
import { prisma } from '../src/prisma.js'

const PLAN_MD = `---
pbi:
  title: Add CSV export to the report page
stories:
  - title: Export current report as CSV
    tasks:
      - title: add export button
      - title: wire the download
---

# Plan

Add a CSV export to the report page. The button calls an endpoint that returns the
rows. Probably reuse the existing query. Add a column header row. Should be quick.
`

const GRILL_MD = `## Scope
Admin report page only. CSV must reflect the same filters as the on-screen table.

## Acceptance
- Clicking Export downloads a .csv with the currently filtered rows.
- The header row matches the visible columns.
- Large exports (10k+ rows) do not block the UI.

## Risks
- Filter state must be passed to the export, not re-derived.
- Encoding / delimiter for non-ASCII content.
`

async function main() {
  const productId = process.env.CANARY_PRODUCT_ID
  if (!productId) throw new Error('CANARY_PRODUCT_ID env is required')
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, user_id: true, name: true },
  })
  if (!product) throw new Error(`product ${productId} not found`)

  const idea = await prisma.idea.create({
    data: {
      user_id: product.user_id,
      product_id: product.id,
      code: `CODEXPLANREVIEW-${Date.now()}`,
      title: 'Codex Phase 1 plan-review canary',
      status: 'PLAN_READY',
      plan_md: PLAN_MD,
      grill_md: GRILL_MD,
    },
    select: { id: true, code: true },
  })

  const job = await prisma.claudeJob.create({
    data: {
      user_id: product.user_id,
      product_id: product.id,
      idea_id: idea.id,
      kind: 'IDEA_REVIEW_PLAN',
      status: 'QUEUED',
      runtime: 'CODEX',
      source: 'SYSTEM',
      required_capability: 'review',
    },
    select: { id: true },
  })

  console.log(JSON.stringify({ ok: true, idea: idea.code, idea_id: idea.id, job_id: job.id, product: product.name }))
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
