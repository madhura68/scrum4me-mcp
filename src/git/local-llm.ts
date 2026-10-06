// Bewaking van jobs waarvan model-geschreven code buiten de MCP draait (spec
// docs/specs/2026-09-27-task-implementation-local-llm-design.md §4.5, §5.3; voor
// de HARNESS-runtime M45 spec §5.6): voor een job met runtime = 'HARNESS' of
// required_capability = 'local_llm' draait model-geschreven code later in
// containers die de worktree read-write mounten. Die containers kunnen de
// worktree's .git-gitlink (en submodule-gitlinks) hebben omgebogen naar
// zelfgemaakte git-administratie met executable config (core.fsmonitor,
// core.sshCommand, …). Daarom mag de MCP voor zo'n job nooit git draaien met de
// worktree als werkmap buiten de claim (vóór de eerste container) en het groene
// pad ná de harness-scan — die twee momenten worden elders afgehandeld
// (Taak 4/5). Deze module legt de regel in de gedeelde helpers zodat elke
// aanroeper hem erft.
//
// "Is dit een bewaakte job?" is één predicaat (isHarnessJob / isHarnessJobRow)
// en wordt altijd uit de database beslist (claude_jobs.runtime en
// claude_jobs.required_capability), nooit uit iets in de worktree zelf — die is
// precies het onvertrouwde stuk. De namen hieronder die nog "local_llm"
// zeggen (isLocalLlmWorktree, gitPrefixFor, SAFE_GIT_CONFIG, …) dateren van
// vóór M45 en volgen dat predicaat.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { prisma } from '../prisma.js'
import { getWorktreeRoot } from './worktree-paths.js'
import { assertTrustedLocalJobWorktree } from './worktree-gitlink.js'

const exec = promisify(execFile)

/**
 * Veilige host-git-config (spec §4.5): hooks, fsmonitor en submodule-
 * verwerking uitgeschakeld zodat een omgebogen gitlink of submodule-config
 * geen executable hook kan laten draaien via een host-git-aanroep. Geldt voor
 * elke job waarvoor `isHarnessJob` waar is (HARNESS én local_llm).
 */
export const SAFE_GIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.ignoreSubmodules=all',
  '-c', 'status.submoduleSummary=false',
  '-c', 'submodule.recurse=false',
] as const

/**
 * Spec §5.6: één predicaat voor alle bewaking; de local_llm-tak blijft permanent.
 *
 * Een HARNESS-job (`runtime`) en een local_llm-job (`required_capability`) krijgen dezelfde
 * git-bescherming. De local_llm-tak blijft ook als die capability niet meer wordt uitgegeven: de
 * worktrees van oude, afgesloten local_llm-jobs kunnen nog op een branch staan en blijven bewaakt.
 */
export function isHarnessJobRow(job: { runtime: string; required_capability: string | null }): boolean {
  return job.runtime === 'HARNESS' || job.required_capability === 'local_llm'
}

/**
 * DB-lookup van beide velden (nooit uit de worktree); onbekende job ⇒ false. Geen statusfilter:
 * ook een afgesloten job blijft bewaakt.
 */
export async function isHarnessJob(jobId: string): Promise<boolean> {
  const job = await prisma.claudeJob.findUnique({
    where: { id: jobId },
    select: { runtime: true, required_capability: true },
  })
  return !!job && isHarnessJobRow(job)
}

// Best-effort realpath: valt terug op het onopgeloste pad wanneer het (nog)
// niet bestaat of om een andere reden niet resolvebaar is — nooit throwen.
function tryRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function relativeJobId(root: string, worktreePath: string): string | null {
  const rel = path.relative(root, worktreePath)
  if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  if (rel.includes(path.sep)) return null // dieper dan één niveau onder de root
  return rel
}

/**
 * <worktreeRoot>/<jobId> ⇒ jobId; elk ander pad ⇒ null (dan is het geen
 * job-worktree).
 *
 * `git worktree list --porcelain` print realpath'de paden (symlinks
 * opgelost), terwijl `getWorktreeRoot()` en de paden die deze module zelf
 * opbouwt het onopgeloste pad gebruiken (bv. `SCRUM4ME_AGENT_WORKTREE_DIR`
 * of `$HOME` via een symlink, zoals macOS' `/tmp` → `/private/tmp`). Zonder
 * realpath-vergelijking mist die mismatch dan een local_llm-bezetter-
 * worktree stil — vergelijk daarom zowel het onopgeloste als het
 * gerealpathte pad aan beide kanten.
 */
export function jobIdFromWorktreePath(worktreePath: string): string | null {
  const root = getWorktreeRoot()
  const realRoot = tryRealpath(root)
  const realWorktreePath = tryRealpath(worktreePath)
  return (
    relativeJobId(root, worktreePath)
    ?? relativeJobId(root, realWorktreePath)
    ?? relativeJobId(realRoot, worktreePath)
    ?? relativeJobId(realRoot, realWorktreePath)
  )
}

/**
 * true als het pad de worktree van een bewaakte job is (`isHarnessJob`: HARNESS of local_llm; de
 * naam is van vóór M45).
 */
export async function isLocalLlmWorktree(worktreePath: string): Promise<boolean> {
  const jobId = jobIdFromWorktreePath(worktreePath)
  if (!jobId) return false
  return isHarnessJob(jobId)
}

/**
 * fs.rm(recursive, force) van de map, daarna `git <SAFE_GIT_CONFIG> worktree
 * prune` met cwd = repoRoot. Nooit git in de worktree. Voor de worktree van een
 * job waarvoor `isHarnessJob` waar is (de naam is van vóór M45).
 */
export async function removeWorktreeWithoutGit(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  await fs.rm(worktreePath, { recursive: true, force: true })
  await exec('git', [...SAFE_GIT_CONFIG, 'worktree', 'prune'], { cwd: repoRoot }).catch(() => {})
}

// Vertrouwde worktree-gitlink (Forgejo-review PR #169): de controle staat in
// een eigen module zodat tests van de prefix-argumenten hem kunnen stubben;
// hier opnieuw geëxporteerd zodat aanroepers alles uit local-llm.js halen.
export {
  UntrustedWorktreeGitlinkError,
  assertTrustedWorktreeGitlink,
  assertTrustedLocalJobWorktree,
} from './worktree-gitlink.js'

/**
 * SAFE_GIT_CONFIG als de worktree van een bewaakte job is (`isHarnessJob`: HARNESS
 * of local_llm), anders [].
 *
 * Voor zo'n worktree controleert dit eerst de gitlink tegen de clone
 * (assertTrustedLocalJobWorktree) en gooit UntrustedWorktreeGitlinkError als
 * die niet klopt. Elke host-git-aanroep in een bewaakte worktree bouwt zijn
 * argumenten via deze functie, dus de controle loopt vóór elke zulke git-
 * aanroep (push, set-head, rev-parse, diff). Gewone jobs: dezelfde
 * DB-lookups als vóór deze wijziging, geen controle, prefix [].
 */
export async function gitPrefixFor(worktreePath: string): Promise<string[]> {
  const jobId = jobIdFromWorktreePath(worktreePath)
  if (!jobId || !(await isHarnessJob(jobId))) return []
  await assertTrustedLocalJobWorktree(jobId, worktreePath)
  return [...SAFE_GIT_CONFIG]
}
