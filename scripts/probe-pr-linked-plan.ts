// Alleen-lezen praktijkproef voor de plan-lookup van de PR-review (ST-052, Taak 4).
// Draait dezelfde functies als wait-for-job tegen de echte DB en Forgejo en print
// per PR alleen metadata: geen planinhoud, geen tokens.
//
//   npx tsx scripts/probe-pr-linked-plan.ts [--recent N] [<pr-url> ...]
//
// Vereist DATABASE_URL en FORGEJO_TOKEN in de omgeving.
import { prisma } from '../src/prisma.js'
import { getPullRequestState } from '../src/git/pr.js'
import {
  resolvePlanViaCommits,
  resolvePrLinkedPlan,
  LINKED_PLAN_BUDGET,
} from '../src/lib/pr-linked-plan.js'

function parseArgs(argv: string[]): { recent: number; urls: string[] } {
  const out = { recent: 0, urls: [] as string[] }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--recent') out.recent = Number(argv[++i])
    else out.urls.push(argv[i])
  }
  return out
}

async function productFor(prUrl: string): Promise<string | null> {
  const job = await prisma.claudeJob.findFirst({
    where: { kind: 'PR_REVIEW', pr_url: prUrl },
    orderBy: { created_at: 'desc' },
    select: { product_id: true },
  })
  if (job) return job.product_id
  const repo = prUrl.replace(/\/pulls\/\d+$/, '')
  const product = await prisma.product.findFirst({
    where: { repo_url: { in: [repo, `${repo}.git`] } },
    select: { id: true },
  })
  return product?.id ?? null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
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
  let bAlone = 0
  let biggestLegacy = 0
  let overBudget = 0
  for (const url of urls) {
    const label = url.replace(/^https:\/\/[^/]+\/[^/]+\//, '')
    const productId = await productFor(url)
    if (!productId) {
      console.log(`${label}\tgeen job/product`)
      continue
    }
    const job = { id: '<probe>', pr_url: url, product_id: productId }
    const info = await getPullRequestState({ prUrl: url })
    const pr = 'error' in info ? { body: '', head_sha: null } : { body: info.body, head_sha: info.headSha }

    const legacy = await resolvePrLinkedPlan(job)
    const plan = await resolvePrLinkedPlan(job, pr)
    const size = plan ? JSON.stringify(plan).length : 0
    const viaB = plan?.source === 'pr_refs' ? await resolvePlanViaCommits(job) : null

    if (legacy) {
      before += 1
      biggestLegacy = Math.max(biggestLegacy, JSON.stringify(legacy).length)
    }
    if (plan) after += 1
    if (plan?.source === 'commits' || viaB) bAlone += 1
    if ((plan?.source === 'pr_refs' || plan?.source === 'commits') && size > LINKED_PLAN_BUDGET) overBudget += 1

    console.log([
      label,
      `source=${plan?.source ?? 'null'}`,
      `refs=${(plan?.references ?? []).join(',') || '-'}`,
      `omitted=${(plan?.omitted ?? []).join(',') || '-'}`,
      `chars=${size}`,
      `ook_B=${plan?.source === 'pr_refs' ? (viaB ? (viaB.references ?? []).join(',') : 'nee') : '-'}`,
      'error' in info ? `pr_meta_fout` : '',
    ].filter(Boolean).join('\t'))
  }

  console.log(
    `\nPR's: ${urls.length} · plan vóór (bestaande routes): ${before} · plan na: ${after}` +
      ` · B vond iets: ${bAlone} · A/B boven budget: ${overBudget} · grootste job/pbi-payload: ${biggestLegacy} tekens`,
  )
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
