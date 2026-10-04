// Alleen-lezen praktijkproef voor de plan-lookup van de PR-review (ST-052, ST-053).
// Draait dezelfde functies als wait-for-job tegen de echte DB en Forgejo en print
// per PR alleen metadata: geen planinhoud, geen tokens.
//
//   npx tsx scripts/probe-pr-linked-plan.ts [--recent N] [<pr-url> ...]
//
// Vereist DATABASE_URL en FORGEJO_TOKEN in de omgeving.
import { createHash } from 'node:crypto'
import { prisma } from '../src/prisma.js'
import { getTokenScopedProducts } from '../src/auth.js'
import { getPullRequestState } from '../src/git/pr.js'
import {
  candidateProductIds,
  createResolveContext,
  resolvePlanViaCrossProductRefs,
  resolvePrLinkedPlan,
  LINKED_PLAN_BUDGET,
  type LinkedPlan,
} from '../src/lib/pr-linked-plan.js'

function parseArgs(argv: string[]): { recent: number; urls: string[] } {
  const out = { recent: 0, urls: [] as string[] }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--recent') out.recent = Number(argv[++i])
    else out.urls.push(argv[i])
  }
  return out
}

/** Product en eigenaar van een PR: via de PR_REVIEW-job, anders via `Product.repo_url`. */
async function bindingFor(prUrl: string): Promise<{ product_id: string; user_id: string } | null> {
  const job = await prisma.claudeJob.findFirst({
    where: { kind: 'PR_REVIEW', pr_url: prUrl },
    orderBy: { created_at: 'desc' },
    select: { product_id: true, user_id: true },
  })
  if (job) return job
  const repo = prUrl.replace(/\/pulls\/\d+$/, '')
  const product = await prisma.product.findFirst({
    where: { repo_url: { in: [repo, `${repo}.git`] } },
    select: { id: true, user_id: true },
  })
  return product ? { product_id: product.id, user_id: product.user_id } : null
}

const hash = (plan: LinkedPlan | null) =>
  plan ? createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 12) : '-'
const step = (plan: LinkedPlan | null, cross: boolean) =>
  !plan ? '-' : plan.source === 'job' || plan.source === 'pbi' ? plan.source
    : `${plan.source === 'pr_refs' ? 'A' : 'B'}${cross ? '×' : ''}`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const scope = await getTokenScopedProducts()
  console.log(`token-scope: ${scope.length ? `gescoped (${scope.length} producten) — dekking kan lager uitvallen dan op productie` : 'ongescopet'}`)

  const urls = [...args.urls]
  if (args.recent > 0) {
    const rows = await prisma.claudeJob.groupBy({
      by: ['pr_url'],
      where: { kind: 'PR_REVIEW', pr_url: { not: null } },
      _max: { created_at: true },
      orderBy: { _max: { created_at: 'desc' } },
      take: args.recent,
    })
    for (const r of rows) if (r.pr_url && !urls.includes(r.pr_url)) urls.push(r.pr_url)
  }

  let before = 0
  let after = 0
  let changed = 0
  let overBudget = 0
  const unsignalled: string[] = []
  for (const url of urls) {
    const label = url.replace(/^https:\/\/[^/]+\/[^/]+\//, '')
    const binding = await bindingFor(url)
    if (!binding) {
      console.log(`${label}\tgeen job/product`)
      continue
    }
    const info = await getPullRequestState({ prUrl: url })
    const pr = 'error' in info ? { body: '', head_sha: null } : { body: info.body, head_sha: info.headSha }
    const base = { id: '<probe>', pr_url: url, product_id: binding.product_id }

    // Zonder user_id = ST-052-gedrag; met user_id = inclusief A× en B×.
    const own = await resolvePrLinkedPlan(base, pr)
    const plan = await resolvePrLinkedPlan({ ...base, user_id: binding.user_id }, pr)
    const cross = !own && Boolean(plan)
    if (own) before += 1
    if (plan) after += 1
    if (own && hash(own) !== hash(plan)) changed += 1
    const size = plan ? JSON.stringify(plan).length : 0
    if (size > LINKED_PLAN_BUDGET && plan?.source !== 'job' && plan?.source !== 'pbi') overBudget += 1

    // Welke A×-koppelingen bestaan alleen dankzij K1 (unieke match zonder signaal)?
    if (cross && plan?.source === 'pr_refs') {
      const candidates = await candidateProductIds(binding.user_id, binding.product_id)
      const strict = await resolvePlanViaCrossProductRefs(
        { ...base, user_id: binding.user_id }, pr, createResolveContext(url), candidates, { allowUnsignalledUnique: false },
      )
      for (const ref of plan.references ?? []) if (!(strict?.references ?? []).includes(ref)) unsignalled.push(`${label}: ${ref}`)
    }

    const products = [...new Set((plan?.stories ?? []).map((s) => s.product).filter(Boolean))]
    console.log([
      label,
      `stap=${step(plan, cross)}`,
      `refs=${(plan?.references ?? []).join(',') || '-'}`,
      `omitted=${(plan?.omitted ?? []).join(',') || '-'}`,
      `product=${products.join(',') || '-'}`,
      `chars=${size}`,
      `hash_eigen=${hash(own)}`,
      `hash_na=${hash(plan)}`,
      'error' in info ? 'pr_meta_fout' : '',
    ].filter(Boolean).join('\t'))
  }

  console.log(
    `\nPR's: ${urls.length} · plan vóór (ST-052): ${before} · plan na: ${after}` +
      ` · eigen-plan met andere hash: ${changed} · A/B boven budget: ${overBudget}`,
  )
  console.log(`A×-koppelingen zonder signaal (K1): ${unsignalled.length}`)
  for (const u of unsignalled) console.log(`  ${u}`)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
