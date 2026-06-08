// seed-codex-canary.ts — create one claimable SYSTEM PLAN_CHAT CODEX job for the
// Phase 0 canary. Usage: CANARY_PRODUCT_ID=<id> npx tsx scripts/seed-codex-canary.ts
import { prisma } from '../src/prisma.js'

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
      code: `CODEXCANARY-${Date.now()}`,
      title: 'Codex Phase 0 canary',
      status: 'PLAN_READY',
      plan_md: 'Minimal plan for the Phase 0 codex canary.',
    },
    select: { id: true, code: true },
  })

  await prisma.userQuestion.create({
    data: {
      idea_id: idea.id,
      user_id: product.user_id,
      question: 'Noem in een zin de volgende stap voor dit idee.',
      status: 'pending',
    },
  })

  const job = await prisma.claudeJob.create({
    data: {
      user_id: product.user_id,
      product_id: product.id,
      idea_id: idea.id,
      kind: 'PLAN_CHAT',
      status: 'QUEUED',
      runtime: 'CODEX',
      source: 'SYSTEM',
    },
    select: { id: true },
  })

  console.log(JSON.stringify({ ok: true, idea: idea.code, job_id: job.id, product: product.name }))
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
