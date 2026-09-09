// PR-automatisering tegen Forgejo (`git.jp-visser.nl`) via de REST-API in
// `./forgejo-rest.ts`. Vervangt de eerdere GitHub-CLI (`gh`) subprocess
// implementatie. De exports behouden hun signatures zodat callers in
// `flow/effects.ts`, `update-job-status.ts` en `cancel/pbi-cascade.ts`
// niets hoeven aan te passen.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'

import { getWorktreeRoot } from './worktree-paths.js'
import {
  ForgejoError,
  callForgejo,
  discoverForgejo,
  encodePathSegment,
  forgejoFetch,
  getRepoRefFromWorktree,
  parseForgejoPrUrl,
  parseForgejoRemoteUrl,
} from './forgejo-rest.js'

const exec = promisify(execFile)

// =========================================================================
// Re-exports voor caller-compat
// =========================================================================

export type { AutoMergeFailReason } from './forgejo-rest.js'
import type { AutoMergeFailReason } from './forgejo-rest.js'

export type EnableAutoMergeResult =
  | { ok: true; mode: 'merged' | 'scheduled' }
  | { ok: false; reason: AutoMergeFailReason; stderr: string }

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

export type PrInfo = {
  state: PrState
  mergeCommit: string | null
  baseRefName: string
  title: string
  /** Head SHA — bruikbaar voor `deleteRemoteBranch`-guard na een PR-close. */
  headSha: string | null
}

// =========================================================================
// Helpers
// =========================================================================

const WIP_PREFIX_RE = /^(?:WIP: |\[WIP\] )/

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}`
}

function forgejoErrorToAutoMergeResult(err: unknown): EnableAutoMergeResult {
  if (err instanceof ForgejoError) {
    return {
      ok: false,
      reason: err.autoMergeReason ?? 'UNKNOWN',
      stderr: err.message.slice(0, 500),
    }
  }
  const msg = (err as Error).message || String(err)
  return { ok: false, reason: 'UNKNOWN', stderr: msg.slice(0, 500) }
}

type ForgejoPullResponse = {
  number: number
  html_url: string
  state: 'open' | 'closed'
  merged: boolean
  merge_commit_sha: string | null
  title: string
  body: string
  base: { ref: string }
  head: { ref: string; sha: string }
}

// =========================================================================
// createPullRequest
// =========================================================================

export async function createPullRequest(opts: {
  worktreePath: string
  branchName: string
  title: string
  body: string
  /** Open als draft-PR. Forgejo 15.0.2 heeft geen draft-veld → title krijgt `WIP: ` prefix. */
  draft?: boolean
  /**
   * PBI-47 (P0): default false. Auto-merge wordt apart aangezet via
   * `enableAutoMergeOnPr` met head-SHA-guard. Voor compatibility blijft de
   * legacy `true`-pad bestaan: fire-and-forget zonder head-guard.
   */
  enableAutoMerge?: boolean
}): Promise<{ url: string } | { error: string }> {
  const { worktreePath, branchName, title, body, draft = false, enableAutoMerge = false } = opts

  let repoRef
  try {
    repoRef = await getRepoRefFromWorktree(worktreePath)
  } catch (err) {
    return { error: `Forgejo repo-detectie faalde: ${(err as Error).message.slice(0, 300)}` }
  }

  const finalTitle = draft ? `WIP: ${title}` : title

  let pr: ForgejoPullResponse
  try {
    pr = await callForgejo<ForgejoPullResponse>(
      `${repoPath(repoRef.owner, repoRef.repo)}/pulls`,
      {
        method: 'POST',
        write: true,
        host: repoRef.host,
        json: {
          head: branchName,
          base: 'main',
          title: finalTitle,
          body,
        },
      },
    )
  } catch (err) {
    return { error: `Forgejo pr-create failed: ${(err as Error).message.slice(0, 300)}` }
  }

  const url = pr.html_url || ''
  if (!url.startsWith('http')) {
    return { error: `Forgejo pr-create produced unexpected html_url: ${String(url).slice(0, 200)}` }
  }

  // Legacy opt-in: enableAutoMerge=true en niet draft → fire-and-forget zonder head-guard.
  if (enableAutoMerge && !draft) {
    const result = await enableAutoMergeOnPr({ prUrl: url })
    if (!result.ok) {
      console.warn(
        `[createPullRequest] auto-merge enable failed for ${url}: ${result.reason} ${result.stderr.slice(0, 200)}`,
      )
    }
  }

  return { url }
}

// =========================================================================
// enableAutoMergeOnPr
// =========================================================================

/**
 * Zet auto-merge (squash) aan op een Forgejo PR met optionele head-SHA guard.
 *
 * PBI-47 (P0): wanneer `expectedHeadSha` meegegeven wordt sturen we
 * `head_commit_id` mee in de merge-body; Forgejo activeert dan alleen
 * auto-merge wanneer de remote head nog matcht. Dit voorkomt dat een
 * latere worker-push een ongewenste commit-set mergt.
 *
 * Wanneer de Forgejo-instance `merge_when_checks_succeed` niet ondersteunt
 * (discovery faalt op dat veld) retourneren we `AUTO_MERGE_NOT_ALLOWED`
 * zónder een merge-call te doen.
 *
 * PBI-130: de opportunistische directe squash-merge (stap 2) draait alléén ná
 * een geslaagde schedule (stap 1). De echte veiligheidslaag is branch-protection
 * (required checks), die Forgejo server-side afdwingt — óók voor de directe
 * merge; Forgejo/Gitea kent GÉÉN repo-niveau "Allow auto-merge"-schakelaar
 * (anders dan GitHub). Schedule-first blijft de voorkeur: huidig gedrag, de
 * directe-merge-fout hoeft niet geclassificeerd te worden, en op CI-repos faalt
 * stap 2 onschadelijk (Forgejo weigert vóór required checks) → de schedule blijft
 * staan → geen STORY-regressie. De directe merge maakt de flow betrouwbaar op
 * repos zónder CI-checks, waar de schedule anders nooit getriggerd wordt.
 */
export async function enableAutoMergeOnPr(opts: {
  prUrl: string
  expectedHeadSha?: string
  cwd?: string
  directMergeBackoffMs?: number
}): Promise<EnableAutoMergeResult> {
  let prRef
  try {
    prRef = parseForgejoPrUrl(opts.prUrl)
  } catch (err) {
    return forgejoErrorToAutoMergeResult(err)
  }

  try {
    const discovery = await discoverForgejo(prRef.host)
    if (!discovery.supportsAutoMerge) {
      return {
        ok: false,
        reason: 'AUTO_MERGE_NOT_ALLOWED',
        stderr: `Forgejo ${discovery.version} mist merge_when_checks_succeed in OpenAPI`,
      }
    }
  } catch (err) {
    return forgejoErrorToAutoMergeResult(err)
  }

  // Stap 1: scheduled auto-merge (ongewijzigd gedrag). NB: Forgejo kent geen
  // repo-niveau "Allow auto-merge"-schakelaar; de veiligheid zit in
  // branch-protection (required checks, server-side) — niet in een gate hier.
  // Faalt deze POST → surface. De directe merge (stap 2) draait alléén ná succes.
  const mergePath = `${repoPath(prRef.owner, prRef.repo)}/pulls/${prRef.index}/merge`
  const scheduleBody: Record<string, unknown> = { Do: 'squash', merge_when_checks_succeed: true }
  if (opts.expectedHeadSha) scheduleBody.head_commit_id = opts.expectedHeadSha

  try {
    await callForgejo(mergePath, { method: 'POST', write: true, host: prRef.host, json: scheduleBody })
  } catch (err) {
    return forgejoErrorToAutoMergeResult(err)
  }

  // Stap 2: opportunistische directe squash-merge (zónder merge_when_checks_succeed),
  // met bounded retry voor transiënte mergeability. Slaagt 'ie → nú gemerged.
  // Faalt 'ie (checks pending, conflict, head-move, aanhoudend transient) → we
  // branchen NIET op de fout; de schedule uit stap 1 blijft staan.
  const directBody: Record<string, unknown> = { Do: 'squash' }
  if (opts.expectedHeadSha) directBody.head_commit_id = opts.expectedHeadSha

  const DIRECT_MERGE_MAX_ATTEMPTS = 3
  const backoffMs = opts.directMergeBackoffMs ?? 400
  let lastErr: unknown
  for (let attempt = 1; attempt <= DIRECT_MERGE_MAX_ATTEMPTS; attempt++) {
    try {
      await callForgejo(mergePath, { method: 'POST', write: true, host: prRef.host, json: directBody })
      return { ok: true, mode: 'merged' }
    } catch (err) {
      lastErr = err
      if (attempt < DIRECT_MERGE_MAX_ATTEMPTS && backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
      }
    }
  }
  console.warn(
    `[enableAutoMergeOnPr] directe merge niet mogelijk voor ${opts.prUrl} na ${DIRECT_MERGE_MAX_ATTEMPTS} pogingen; scheduled auto-merge blijft actief: ${
      (lastErr as Error)?.message?.slice(0, 200) ?? String(lastErr)
    }`,
  )
  return { ok: true, mode: 'scheduled' }
}

// =========================================================================
// markPullRequestReady
//
// Forgejo 15.0.2 heeft geen ready-transition endpoint. Implementatie: lees
// de PR, strip de `WIP: ` of `[WIP] ` prefix uit de title, schrijf terug
// via PATCH. Idempotent: als er geen prefix is, no-op return ok.
// =========================================================================

export async function markPullRequestReady(opts: {
  prUrl: string
  cwd?: string
}): Promise<{ ok: true } | { error: string }> {
  let prRef
  try {
    prRef = parseForgejoPrUrl(opts.prUrl)
  } catch (err) {
    return { error: `markPullRequestReady: ${(err as Error).message.slice(0, 300)}` }
  }

  let current: ForgejoPullResponse
  try {
    current = await callForgejo<ForgejoPullResponse>(
      `${repoPath(prRef.owner, prRef.repo)}/pulls/${prRef.index}`,
      { host: prRef.host },
    )
  } catch (err) {
    return { error: `Forgejo pr-get failed: ${(err as Error).message.slice(0, 300)}` }
  }

  if (!WIP_PREFIX_RE.test(current.title)) {
    // Geen prefix → al ready (of nooit draft geweest). Idempotent ok.
    return { ok: true }
  }

  const newTitle = current.title.replace(WIP_PREFIX_RE, '')
  try {
    await callForgejo(
      `${repoPath(prRef.owner, prRef.repo)}/pulls/${prRef.index}`,
      {
        method: 'PATCH',
        write: true,
        host: prRef.host,
        json: { title: newTitle },
      },
    )
    return { ok: true }
  } catch (err) {
    return { error: `Forgejo pr-patch failed: ${(err as Error).message.slice(0, 300)}` }
  }
}

// =========================================================================
// getPullRequestState
// =========================================================================

export async function getPullRequestState(opts: {
  prUrl: string
  cwd?: string
}): Promise<PrInfo | { error: string }> {
  let prRef
  try {
    prRef = parseForgejoPrUrl(opts.prUrl)
  } catch (err) {
    return { error: `getPullRequestState: ${(err as Error).message.slice(0, 300)}` }
  }

  let pr: ForgejoPullResponse
  try {
    pr = await callForgejo<ForgejoPullResponse>(
      `${repoPath(prRef.owner, prRef.repo)}/pulls/${prRef.index}`,
      { host: prRef.host },
    )
  } catch (err) {
    return { error: `Forgejo pr-get failed: ${(err as Error).message.slice(0, 300)}` }
  }

  let state: PrState
  if (pr.state === 'open') {
    state = 'OPEN'
  } else if (pr.state === 'closed' && pr.merged) {
    state = 'MERGED'
  } else if (pr.state === 'closed') {
    state = 'CLOSED'
  } else {
    return { error: `unexpected PR state: ${pr.state}` }
  }

  return {
    state,
    mergeCommit: state === 'MERGED' ? pr.merge_commit_sha : null,
    baseRefName: pr.base?.ref ?? '',
    title: pr.title,
    headSha: pr.head?.sha ?? null,
  }
}

// =========================================================================
// listPullRequestFiles
// =========================================================================

type ForgejoChangedFile = { filename: string }

export async function listPullRequestFiles(opts: {
  prUrl: string
  cwd?: string
}): Promise<string[] | { error: string }> {
  let prRef
  try {
    prRef = parseForgejoPrUrl(opts.prUrl)
  } catch (err) {
    return { error: `listPullRequestFiles: ${(err as Error).message.slice(0, 300)}` }
  }

  try {
    const files = await callForgejo<ForgejoChangedFile[]>(
      `${repoPath(prRef.owner, prRef.repo)}/pulls/${prRef.index}/files`,
      { host: prRef.host },
    )
    return Array.isArray(files)
      ? files.map((f) => f.filename).filter((s): s is string => typeof s === 'string')
      : []
  } catch (err) {
    return { error: `Forgejo pr-files failed: ${(err as Error).message.slice(0, 300)}` }
  }
}

// =========================================================================
// closePullRequest
//
// Plaatst eerst een cascade-comment en zet daarna state:closed. De caller
// (pbi-cascade.ts) is verantwoordelijk voor de branch-delete daarna.
// =========================================================================

export async function closePullRequest(opts: {
  prUrl: string
  comment: string
  cwd?: string
}): Promise<{ ok: true } | { error: string }> {
  let prRef
  try {
    prRef = parseForgejoPrUrl(opts.prUrl)
  } catch (err) {
    return { error: `closePullRequest: ${(err as Error).message.slice(0, 300)}` }
  }

  // 1. Comment (issues-endpoint deelt nummers met pulls in Forgejo/Gitea).
  try {
    await callForgejo(
      `${repoPath(prRef.owner, prRef.repo)}/issues/${prRef.index}/comments`,
      {
        method: 'POST',
        write: true,
        host: prRef.host,
        json: { body: opts.comment },
      },
    )
  } catch (err) {
    // Comment is best-effort — als het faalt willen we de close-actie nog wél proberen.
    console.warn(
      `[closePullRequest] comment failed for ${opts.prUrl}: ${(err as Error).message.slice(0, 200)}`,
    )
  }

  // 2. State patch.
  try {
    await callForgejo(
      `${repoPath(prRef.owner, prRef.repo)}/pulls/${prRef.index}`,
      {
        method: 'PATCH',
        write: true,
        host: prRef.host,
        json: { state: 'closed' },
      },
    )
    return { ok: true }
  } catch (err) {
    return { error: `Forgejo pr-close failed: ${(err as Error).message.slice(0, 300)}` }
  }
}

// =========================================================================
// createRevertPullRequest
//
// Worktree-revert (parent-count-aware: squash-merges hebben 1 parent; merge-
// commits hebben er meerdere en vereisen `-m 1`). De revert-PR wordt
// bewust ZONDER auto-merge geopend.
// =========================================================================

export async function createRevertPullRequest(opts: {
  repoRoot: string
  mergeSha: string
  baseRef: string
  originalTitle: string
  originalBranch: string
  jobId: string
  pbiCode: string | null
}): Promise<{ url: string } | { error: string }> {
  const {
    repoRoot,
    mergeSha,
    baseRef,
    originalTitle,
    originalBranch,
    jobId,
    pbiCode,
  } = opts

  const worktreeDir = getWorktreeRoot()
  const wtPath = path.join(worktreeDir, `revert-${jobId}`)
  const revertBranch = `revert/${originalBranch}-${jobId.slice(-8)}`

  const run = async (cmd: string, args: string[], cwd: string) => {
    await exec(cmd, args, { cwd })
  }

  const cleanup = async () => {
    try {
      await exec('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoRoot })
    } catch {
      // ignore — worktree mag al weg zijn als creatie faalde
    }
  }

  try {
    await run('git', ['fetch', 'origin', baseRef, mergeSha], repoRoot)
    await run('git', ['worktree', 'add', '-b', revertBranch, wtPath, `origin/${baseRef}`], repoRoot)

    // Parent-count detectie: squash-merge = 1 parent (geen -m), echte
    // merge-commit = ≥2 parents (vereist -m 1).
    let revertArgs: string[]
    try {
      const { stdout } = await exec('git', ['cat-file', '-p', mergeSha], { cwd: wtPath })
      const parents = stdout.split('\n').filter((l) => l.startsWith('parent '))
      revertArgs = parents.length > 1
        ? ['revert', '-m', '1', mergeSha, '--no-edit']
        : ['revert', mergeSha, '--no-edit']
    } catch (err) {
      await cleanup()
      const msg = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
      return { error: `git cat-file failed for ${mergeSha}: ${msg.slice(0, 200)}` }
    }

    try {
      await run('git', revertArgs, wtPath)
    } catch (err) {
      await cleanup()
      const msg = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
      if (/conflict/i.test(msg)) {
        return { error: `git revert conflicts on ${mergeSha}: ${msg.slice(0, 200)}` }
      }
      return { error: `git revert failed: ${msg.slice(0, 200)}` }
    }

    await run('git', ['push', '-u', 'origin', revertBranch], wtPath)

    let repoRef
    try {
      repoRef = await getRepoRefFromWorktree(wtPath)
    } catch (err) {
      await cleanup()
      return { error: `Forgejo repo-detectie faalde: ${(err as Error).message.slice(0, 300)}` }
    }

    const pbiTag = pbiCode ? `PBI ${pbiCode}` : 'PBI'
    const title = `Revert: ${originalTitle}`
    const body = [
      `Auto-revert by Scrum4Me agent.`,
      ``,
      `Reason: ${pbiTag} failed (cascade from job \`${jobId}\`).`,
      `Reverts merge commit \`${mergeSha}\`.`,
      ``,
      `**Review carefully before merging** — auto-merge is intentionally NOT enabled on revert PRs.`,
    ].join('\n')

    let pr: ForgejoPullResponse
    try {
      pr = await callForgejo<ForgejoPullResponse>(
        `${repoPath(repoRef.owner, repoRef.repo)}/pulls`,
        {
          method: 'POST',
          write: true,
          host: repoRef.host,
          json: { head: revertBranch, base: baseRef, title, body },
        },
      )
    } catch (err) {
      await cleanup()
      return { error: `Forgejo pr-create (revert) failed: ${(err as Error).message.slice(0, 300)}` }
    }

    const url = pr.html_url || ''
    if (!url.startsWith('http')) {
      await cleanup()
      return { error: `Forgejo pr-create produced unexpected html_url: ${String(url).slice(0, 200)}` }
    }

    await cleanup()
    return { url }
  } catch (err) {
    await cleanup()
    const msg = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
    return { error: `revert worktree setup failed: ${msg.slice(0, 300)}` }
  }
}

// =========================================================================
// fetchPrDiff — Phase 2: unified diff van een PR via de .diff-endpoint.
// .diff is text/plain → forgejoFetch (callForgejo zou JSON parsen).
// Forgejo's `.diff` path-suffix wint van de meegezonden `Accept: application/json`-header
// (path-based content-negotiation), dus de raw-Response-route is veilig.
// =========================================================================

export async function fetchPrDiff(opts: {
  prUrl: string
}): Promise<string | { error: string }> {
  let prRef
  try {
    prRef = parseForgejoPrUrl(opts.prUrl)
  } catch (err) {
    return { error: `fetchPrDiff: ${(err as Error).message.slice(0, 300)}` }
  }
  try {
    const res = await forgejoFetch(
      `${repoPath(prRef.owner, prRef.repo)}/pulls/${prRef.index}.diff`,
      { host: prRef.host },
    )
    if (!res.ok) {
      return { error: `Forgejo pr-diff failed: ${res.status}` }
    }
    return await res.text()
  } catch (err) {
    return { error: `Forgejo pr-diff failed: ${(err as Error).message.slice(0, 300)}` }
  }
}

// =========================================================================
// postPullRequestReview — Phase 2: post een review-state op een PR.
// =========================================================================

export async function postPullRequestReview(opts: {
  prUrl: string
  event: 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT'
  body: string
  commitId?: string
}): Promise<{ ok: true; reviewId?: number } | { error: string }> {
  let prRef
  try {
    prRef = parseForgejoPrUrl(opts.prUrl)
  } catch (err) {
    return { error: `postPullRequestReview: ${(err as Error).message.slice(0, 300)}` }
  }
  try {
    const review = await callForgejo<{ id?: number }>(
      `${repoPath(prRef.owner, prRef.repo)}/pulls/${prRef.index}/reviews`,
      {
        method: 'POST',
        write: true,
        host: prRef.host,
        json: { event: opts.event, body: opts.body, commit_id: opts.commitId },
      },
    )
    return { ok: true, reviewId: review?.id }
  } catch (err) {
    return { error: `Forgejo pr-review-post failed: ${(err as Error).message.slice(0, 300)}` }
  }
}

// =========================================================================
// fetchCompareDiff — unified diff van een commit-range.
//
// De Forgejo-API kent GEEN raw diff voor een range. Blijkens de swagger van
// de instance produceert /repos/{o}/{r}/compare/{basehead} uitsluitend
// application/json, en `.diff` op dat pad is 404. Alleen
// /git/commits/{sha}.{diffType} en /pulls/{index}.{diffType} leveren
// text/plain.
//
// De vorige implementatie loste dat op met de WEB-route
// (/{owner}/{repo}/compare/{base}...{head}.diff) en een kale fetch zonder
// credential. Dat was bewust en gedocumenteerd, met de PR-diff als bedoelde
// fallback. De web-route kent echter geen token-auth, dus op een PRIVATE repo
// gaf hij onvoorwaardelijk 404 — voor elke range, altijd. En een TASK_REVIEW
// uit een sprint-execution heeft geen pr_url, dus daar bestond de fallback
// niet: de job requeuede eeuwig en blokkeerde als oudste rij de hele
// reviewrij (ISS-5).
//
// Nu haalt de compare-JSON de commits van de range op en levert
// /git/commits/{sha}.diff per commit de diff — allebei via forgejoFetch, dus
// mét token. Het resultaat is de reeks commit-diffs in chronologische
// volgorde (`git log -p base..head`), NIET de samengevouwen drie-punts-diff
// die de web-route gaf: een bestand dat in twee commits is aangeraakt komt
// twee keer voor. Voor een review is dat een andere, eerder rijkere vorm.
// De API geeft commits nieuwste-eerst; die volgorde wordt hier omgedraaid.
//
// Een drie-punts-range trekt merge-historie mee (gemeten: HEAD~4...HEAD gaf
// 16 commits), dus zijn er harde grenzen op aantal en omvang. Wordt een
// grens geraakt, dan is dat een expliciete fout en geen stil afgekapte diff:
// een half aangeleverde review is erger dan een geweigerde.
// =========================================================================

const COMPARE_MAX_COMMITS = 50
const COMPARE_MAX_BYTES = 4_000_000

export async function fetchCompareDiff(opts: {
  repoUrl: string
  baseSha: string
  headSha: string
}): Promise<string | { error: string }> {
  if (!opts.baseSha || !opts.headSha || opts.baseSha === opts.headSha) {
    return { error: 'fetchCompareDiff: lege range (base/head ontbreekt of base === head)' }
  }
  let repoRef
  try {
    repoRef = parseForgejoRemoteUrl(opts.repoUrl)
  } catch (err) {
    return { error: `fetchCompareDiff: ${(err as Error).message.slice(0, 300)}` }
  }
  const base = repoPath(repoRef.owner, repoRef.repo)
  const range = `${encodePathSegment(opts.baseSha)}...${encodePathSegment(opts.headSha)}`

  let shas: string[]
  try {
    const res = await forgejoFetch(`${base}/compare/${range}`, { host: repoRef.host })
    if (!res.ok) {
      return { error: `Forgejo compare failed: ${res.status}` }
    }
    const body = (await res.json()) as { commits?: { sha?: unknown }[] }
    if (!Array.isArray(body.commits)) {
      return { error: 'Forgejo compare: antwoord zonder commits-array' }
    }
    // Nieuwste-eerst uit de API → chronologisch, zodat de diffs in de volgorde
    // staan waarin ze zijn ontstaan.
    shas = body.commits
      .map((c) => (typeof c.sha === 'string' ? c.sha : null))
      .filter((sha): sha is string => Boolean(sha))
      .reverse()
  } catch (err) {
    return { error: `Forgejo compare failed: ${(err as Error).message.slice(0, 300)}` }
  }

  if (shas.length === 0) {
    return { error: 'Forgejo compare: lege range (geen commits tussen base en head)' }
  }
  if (shas.length > COMPARE_MAX_COMMITS) {
    return {
      error:
        `Forgejo compare: ${shas.length} commits in de range, maximaal ${COMPARE_MAX_COMMITS} ` +
        '(drie-punts-ranges trekken merge-historie mee)',
    }
  }

  const delen: string[] = []
  let bytes = 0
  for (const sha of shas) {
    let deel: string
    try {
      const res = await forgejoFetch(`${base}/git/commits/${encodePathSegment(sha)}.diff`, {
        host: repoRef.host,
      })
      if (!res.ok) {
        return { error: `Forgejo commit-diff failed voor ${sha.slice(0, 10)}: ${res.status}` }
      }
      deel = await res.text()
    } catch (err) {
      return {
        error: `Forgejo commit-diff failed voor ${sha.slice(0, 10)}: ${(err as Error).message.slice(0, 300)}`,
      }
    }
    // Een merge-commit levert een lege diff; die overslaan houdt het resultaat
    // leesbaar zonder informatie te verliezen.
    if (deel.trim() === '') continue
    if (!deel.startsWith('diff --git')) {
      return {
        error: `Forgejo commit-diff voor ${sha.slice(0, 10)}: geen unified diff: ${deel.slice(0, 120)}`,
      }
    }
    bytes += Buffer.byteLength(deel, 'utf8')
    if (bytes > COMPARE_MAX_BYTES) {
      return {
        error: `Forgejo compare: diff groter dan ${COMPARE_MAX_BYTES} bytes over ${shas.length} commits`,
      }
    }
    delen.push(deel.endsWith('\n') ? deel : `${deel}\n`)
  }

  if (delen.length === 0) {
    return { error: 'Forgejo compare: alle commits in de range leverden een lege diff' }
  }
  return delen.join('')
}
