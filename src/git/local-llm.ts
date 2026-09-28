// local_llm-bewaking (spec docs/specs/2026-09-27-task-implementation-local-llm-design.md
// §4.5, §5.3): voor een job met required_capability = 'local_llm' draait
// model-geschreven code later in containers die de worktree read-write
// mounten. Die containers kunnen de worktree's .git-gitlink (en submodule-
// gitlinks) hebben omgebogen naar zelfgemaakte git-administratie met
// executable config (core.fsmonitor, core.sshCommand, …). Daarom mag de MCP
// voor zo'n job nooit git draaien met de worktree als werkmap buiten de claim
// (vóór de eerste container) en het groene pad ná de harness-scan — die twee
// momenten worden elders afgehandeld (Taak 4/5). Deze module legt de regel in
// de gedeelde helpers zodat elke aanroeper hem erft.
//
// "Is dit een local_llm-job?" wordt altijd uit de database beslist
// (claude_jobs.required_capability), nooit uit iets in de worktree zelf —
// die is precies het onvertrouwde stuk.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { prisma } from '../prisma.js'
import { getWorktreeRoot } from './worktree-paths.js'
import { assertTrustedLocalJobWorktree } from './worktree-gitlink.js'

const exec = promisify(execFile)

// Veilige host-git-config (spec §4.5): hooks, fsmonitor en submodule-
// verwerking uitgeschakeld zodat een omgebogen gitlink of submodule-config
// geen executable hook kan laten draaien via een host-git-aanroep.
export const SAFE_GIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.ignoreSubmodules=all',
  '-c', 'status.submoduleSummary=false',
  '-c', 'submodule.recurse=false',
] as const

/** DB-lookup; onbekende job ⇒ false. */
export async function isLocalLlmJob(jobId: string): Promise<boolean> {
  const job = await prisma.claudeJob.findUnique({
    where: { id: jobId },
    select: { required_capability: true },
  })
  return job?.required_capability === 'local_llm'
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

/** true als het pad de worktree van een local_llm-job is. */
export async function isLocalLlmWorktree(worktreePath: string): Promise<boolean> {
  const jobId = jobIdFromWorktreePath(worktreePath)
  if (!jobId) return false
  return isLocalLlmJob(jobId)
}

/**
 * fs.rm(recursive, force) van de map, daarna `git <SAFE_GIT_CONFIG> worktree
 * prune` met cwd = repoRoot. Nooit git in de worktree.
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
 * SAFE_GIT_CONFIG als de worktree van een local_llm-job is, anders [].
 *
 * Voor een local_llm-worktree controleert dit eerst de gitlink tegen de clone
 * (assertTrustedLocalJobWorktree) en gooit UntrustedWorktreeGitlinkError als
 * die niet klopt. Elke host-git-aanroep in een local_llm-worktree bouwt zijn
 * argumenten via deze functie, dus de controle loopt vóór elke zulke git-
 * aanroep (push, set-head, rev-parse, diff). Niet-lokale jobs: dezelfde
 * DB-lookups als vóór deze wijziging, geen controle, prefix [].
 */
export async function gitPrefixFor(worktreePath: string): Promise<string[]> {
  const jobId = jobIdFromWorktreePath(worktreePath)
  if (!jobId || !(await isLocalLlmJob(jobId))) return []
  await assertTrustedLocalJobWorktree(jobId, worktreePath)
  return [...SAFE_GIT_CONFIG]
}
