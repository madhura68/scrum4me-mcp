// IDEA-118 spec §6.3 (v0.4): review-kinds met harde doc-/repo-scope.
// Runtime-velden conform workers manual-template 'pr-review'
// (defaultRuntime codex, capability review) en de manual-create-precedent
// (requested_model 'codex-default' bij CODEX).
import type { AgentRuntime, JobSource } from '@prisma/client'
import { prisma } from '../../prisma.js'
import { getJobConfigSnapshot } from './snapshot.js'
import { notifyJobEnqueued } from './notify.js'
import { DispatchError } from './errors.js'

// Spec §6.3 (v0.4): pr_url parsen, normaliseren (Forgejo + bekende
// mirror-vormen) en host+owner/repo matchen met Product.repo_url.
// Mirror-realiteit in dit ecosysteem: Forgejo (git.jp-visser.nl/janpeter)
// wordt gespiegeld naar GitHub (github.com/madhura68). Eén alias-tabel;
// uitbreiden = één regel.
type RepoRef = { host: string; owner: string; repo: string }

const MIRROR_ALIASES: Array<{ from: Pick<RepoRef, 'host' | 'owner'>; to: Pick<RepoRef, 'host' | 'owner'> }> = [
  { from: { host: 'github.com', owner: 'madhura68' }, to: { host: 'git.jp-visser.nl', owner: 'janpeter' } },
]

function parseRepoRef(url: string): RepoRef | null {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return null
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 2) return null
  return {
    host: parsed.host.toLowerCase(),
    owner: segments[0].toLowerCase(),
    repo: segments[1].toLowerCase().replace(/\.git$/, ''),
  }
}

function canonicalRef(ref: RepoRef): RepoRef {
  for (const alias of MIRROR_ALIASES) {
    if (ref.host === alias.from.host && ref.owner === alias.from.owner) {
      return { ...alias.to, repo: ref.repo }
    }
  }
  return ref
}

// Geldige PR-routes: Forgejo /<owner>/<repo>/pulls/<n>, GitHub /<owner>/<repo>/pull/<n>.
function hasPrRoute(prUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(prUrl.trim())
  } catch {
    return false
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  return segments.length >= 4 && ['pulls', 'pull'].includes(segments[2]) && /^\d+$/.test(segments[3])
}

export function prUrlMatchesRepo(repoUrl: string, prUrl: string): boolean {
  const repoRef = parseRepoRef(repoUrl)
  const prRef = parseRepoRef(prUrl)
  if (!repoRef || !prRef || !hasPrRoute(prUrl)) return false
  const a = canonicalRef(repoRef)
  const b = canonicalRef(prRef)
  return a.host === b.host && a.owner === b.owner && a.repo === b.repo
}

// Gedeelde velden voor review-jobs; ná de snapshot spreaden zodat
// requested_model 'codex-default' de snapshot-default overschrijft
// (zelfde gedrag als de workers-manual-create bij runtime CODEX).
const REVIEW_JOB_FIELDS: {
  status: 'QUEUED'
  source: JobSource
  runtime: AgentRuntime
  required_capability: string
  requested_model: string
} = {
  status: 'QUEUED',
  source: 'COPILOT',
  runtime: 'CODEX',
  required_capability: 'review',
  requested_model: 'codex-default',
}

export async function dispatchPrReview(opts: {
  productId: string
  prUrl: string
  userId: string
}): Promise<{ job_id: string }> {
  const product = await prisma.product.findUnique({
    where: { id: opts.productId },
    select: { repo_url: true },
  })
  if (!product?.repo_url) throw new DispatchError('Product heeft geen repo_url.')
  if (!prUrlMatchesRepo(product.repo_url, opts.prUrl)) {
    throw new DispatchError('pr_url hoort niet bij de repo van dit product.')
  }
  const snapshot = await getJobConfigSnapshot({ kind: 'PR_REVIEW', productId: opts.productId })
  const job = await prisma.claudeJob.create({
    data: {
      user_id: opts.userId,
      product_id: opts.productId,
      kind: 'PR_REVIEW',
      pr_url: opts.prUrl,
      ...snapshot,
      ...REVIEW_JOB_FIELDS,
    },
    select: { id: true },
  })
  await notifyJobEnqueued({
    job_id: job.id, user_id: opts.userId, product_id: opts.productId, kind: 'PR_REVIEW',
  })
  return { job_id: job.id }
}

export async function dispatchSpecReview(opts: {
  productId: string
  docSlug?: string
  docId?: string
  userId: string
}): Promise<{ job_id: string }> {
  let docId: string | null = null
  if (opts.docSlug) {
    const doc = await prisma.productDoc.findFirst({
      where: { product_id: opts.productId, folder: 'SPECS', slug: opts.docSlug },
      select: { id: true },
    })
    docId = doc?.id ?? null
  } else if (opts.docId) {
    const doc = await prisma.productDoc.findUnique({
      where: { id: opts.docId },
      select: { id: true, product_id: true, folder: true },
    })
    // Spec v0.4: id-pad equivalent beperkt — product én folder SPECS.
    docId = doc && doc.product_id === opts.productId && doc.folder === 'SPECS' ? doc.id : null
  }
  if (!docId) throw new DispatchError('SPECS-doc not found in this product')

  const snapshot = await getJobConfigSnapshot({ kind: 'SPEC_REVIEW', productId: opts.productId })
  const job = await prisma.claudeJob.create({
    data: {
      user_id: opts.userId,
      product_id: opts.productId,
      kind: 'SPEC_REVIEW',
      doc_id: docId,
      ...snapshot,
      ...REVIEW_JOB_FIELDS,
    },
    select: { id: true },
  })
  await notifyJobEnqueued({
    job_id: job.id, user_id: opts.userId, product_id: opts.productId, kind: 'SPEC_REVIEW',
  })
  return { job_id: job.id }
}

export async function dispatchTaskReview(opts: {
  productId: string
  taskId: string
  userId: string
}): Promise<{ job_id: string }> {
  const task = await prisma.task.findUnique({
    where: { id: opts.taskId },
    select: { id: true, story: { select: { product_id: true } } },
  })
  if (!task || task.story.product_id !== opts.productId) {
    throw new DispatchError(`Task ${opts.taskId} not found in this product`)
  }
  const snapshot = await getJobConfigSnapshot({
    kind: 'TASK_REVIEW',
    productId: opts.productId,
    taskId: opts.taskId,
  })
  const job = await prisma.claudeJob.create({
    data: {
      user_id: opts.userId,
      product_id: opts.productId,
      kind: 'TASK_REVIEW',
      task_id: opts.taskId,
      ...snapshot,
      ...REVIEW_JOB_FIELDS,
    },
    select: { id: true },
  })
  await notifyJobEnqueued({
    job_id: job.id, user_id: opts.userId, product_id: opts.productId, kind: 'TASK_REVIEW',
  })
  return { job_id: job.id }
}
