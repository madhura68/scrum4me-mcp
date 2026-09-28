// Vertrouwde worktree-gitlink voor local_llm-jobs. Zie de toelichting in
// het blok hieronder en spec docs/specs/2026-09-27-task-implementation-local-llm-design.md
// §4.3 stap 5, §4.5 en §5.3 (agent-harness-repo).

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { prisma } from '../prisma.js'

// ---------------------------------------------------------------------------
// Vertrouwde worktree-gitlink (Forgejo-review PR #169, BLOCKER): SAFE_GIT_CONFIG
// schakelt o.a. core.sshCommand en een onvertrouwde remote.origin.url niet
// uit. Een container die de `.git`-gitlink van de worktree ombuigt naar eigen
// administratie laat de host-git op het groene pad (push bij done, verify)
// dus zijn config draaien. De harness scant daartegen (spec §4.3 stap 5,
// §4.5); de MCP vertrouwt zijn aanroeper niet en controleert het zelf, met
// alleen fs — nooit git — vóór elke git-aanroep in een local_llm-worktree.
// Klopt de gitlink, dan komt alle config die git leest uit de clone, waar de
// container niet bij kan (spec §4.5, §6).
// ---------------------------------------------------------------------------

export class UntrustedWorktreeGitlinkError extends Error {
  constructor(readonly reason: string) {
    super(`git-administratie van de worktree wijst niet naar de clone (${reason}); geen git uitgevoerd`)
    this.name = 'UntrustedWorktreeGitlinkError'
  }
}

const MAX_GITLINK_BYTES = 4096

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

async function lstatOrNull(p: string) {
  try {
    return await fs.lstat(p)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw err
  }
}

async function realpathOrFail(p: string, what: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    throw new UntrustedWorktreeGitlinkError(`${what} bestaat niet: ${p}`)
  }
}

// Leest een klein gewoon bestand (geen symlink) met precies één regel,
// optioneel gevolgd door één newline, en geeft die regel terug.
async function readSingleLineFile(p: string, what: string): Promise<string> {
  const st = await lstatOrNull(p)
  if (!st) throw new UntrustedWorktreeGitlinkError(`${what} ontbreekt`)
  if (st.isSymbolicLink()) throw new UntrustedWorktreeGitlinkError(`${what} is een symlink`)
  if (!st.isFile()) throw new UntrustedWorktreeGitlinkError(`${what} is geen gewoon bestand`)
  if (st.size > MAX_GITLINK_BYTES) throw new UntrustedWorktreeGitlinkError(`${what} is te groot`)
  const raw = await fs.readFile(p, 'utf-8')
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  if (line === '' || /[\r\n\0]/.test(line)) {
    throw new UntrustedWorktreeGitlinkError(`${what} is niet precies één regel`)
  }
  return line
}

/**
 * Controleert, met alleen fs en zonder git, dat `<worktree>/.git` een
 * gitlink is naar de worktree-administratie van de vertrouwde clone
 * `<repoRoot>`. Gooit UntrustedWorktreeGitlinkError wanneer iets niet klopt:
 *  - `<worktree>/.git` is een gewoon bestand (geen symlink, geen map) met
 *    precies de regel `gitdir: <pad>`;
 *  - realpath(<pad>) is een directe submap van realpath(<repoRoot>/.git/worktrees);
 *  - `<gitdir>/gitdir` wijst terug naar realpath(<worktree>/.git);
 *  - `<gitdir>/commondir` wijst, als hij bestaat, naar realpath(<repoRoot>/.git);
 *  - `config.worktree`, `commondir`, `gitdir` en `HEAD` in `<gitdir>` zijn geen
 *    symlinks.
 * Een `<repoRoot>` waarvan `.git` zelf een gitlink is (in plaats van een map)
 * wordt geweigerd: de clones op max2 (`/var/lib/agent-harness/repos/`) zijn
 * gewone clones, en een tweede gitlink-laag zou een extra vertrouwensgrens
 * vragen die we niet nodig hebben.
 */
export async function assertTrustedWorktreeGitlink(
  worktreePath: string,
  repoRoot: string,
): Promise<void> {
  // De clone: <repoRoot>/.git moet een echte map zijn.
  const rootDotGit = path.join(repoRoot, '.git')
  let rootStat
  try {
    rootStat = await fs.stat(rootDotGit)
  } catch {
    throw new UntrustedWorktreeGitlinkError(`repo-root heeft geen .git: ${repoRoot}`)
  }
  if (!rootStat.isDirectory()) {
    throw new UntrustedWorktreeGitlinkError(
      `.git van de repo-root is geen map (gitlink-clone niet ondersteund): ${repoRoot}`,
    )
  }
  const realCommonDir = await realpathOrFail(rootDotGit, '.git van de repo-root')
  const realWorktreesDir = await realpathOrFail(
    path.join(rootDotGit, 'worktrees'),
    '.git/worktrees van de repo-root',
  )

  // De gitlink in de worktree.
  const dotGit = path.join(worktreePath, '.git')
  const dotGitStat = await lstatOrNull(dotGit)
  if (!dotGitStat) throw new UntrustedWorktreeGitlinkError('.git van de worktree ontbreekt')
  if (dotGitStat.isSymbolicLink()) throw new UntrustedWorktreeGitlinkError('.git van de worktree is een symlink')
  if (dotGitStat.isDirectory()) throw new UntrustedWorktreeGitlinkError('.git van de worktree is een map')
  const gitlinkLine = await readSingleLineFile(dotGit, '.git van de worktree')
  const m = /^gitdir: (.+)$/.exec(gitlinkLine)
  if (!m) throw new UntrustedWorktreeGitlinkError('.git van de worktree is geen `gitdir: <pad>`-regel')
  const realDotGit = await realpathOrFail(dotGit, '.git van de worktree')
  const realAdmin = await realpathOrFail(path.resolve(path.dirname(dotGit), m[1]), 'gitdir uit de gitlink')
  if (path.dirname(realAdmin) !== realWorktreesDir || !isWithin(realAdmin, realWorktreesDir)) {
    throw new UntrustedWorktreeGitlinkError(`gitdir ligt niet direct onder ${realWorktreesDir}: ${realAdmin}`)
  }
  const adminStat = await fs.lstat(realAdmin)
  if (!adminStat.isDirectory()) throw new UntrustedWorktreeGitlinkError('gitdir is geen map')

  // Bestanden die git voor een worktree leest: geen symlinks.
  for (const name of ['config.worktree', 'commondir', 'gitdir', 'HEAD']) {
    const st = await lstatOrNull(path.join(realAdmin, name))
    if (st?.isSymbolicLink()) throw new UntrustedWorktreeGitlinkError(`${name} in gitdir is een symlink`)
  }

  // Terugwijzer: <gitdir>/gitdir → <worktree>/.git.
  const backLine = await readSingleLineFile(path.join(realAdmin, 'gitdir'), 'terugwijzer gitdir/gitdir')
  const realBack = await realpathOrFail(path.resolve(realAdmin, backLine), 'terugwijzer gitdir/gitdir')
  if (realBack !== realDotGit) {
    throw new UntrustedWorktreeGitlinkError(`terugwijzer wijst naar ${realBack}, niet naar ${realDotGit}`)
  }

  // commondir (als aanwezig) → <repoRoot>/.git.
  const commondirPath = path.join(realAdmin, 'commondir')
  if (await lstatOrNull(commondirPath)) {
    const commonLine = await readSingleLineFile(commondirPath, 'gitdir/commondir')
    const realCommon = await realpathOrFail(path.resolve(realAdmin, commonLine), 'gitdir/commondir')
    if (realCommon !== realCommonDir) {
      throw new UntrustedWorktreeGitlinkError(`commondir wijst naar ${realCommon}, niet naar ${realCommonDir}`)
    }
  }
}

/**
 * Resolvet de clone van een local_llm-job zoals de claim dat deed (alleen
 * expliciet geconfigureerde roots, spec §6) en controleert de gitlink van de
 * worktree daartegen. Job- en repo-gegevens komen uit de DB, nooit uit de
 * worktree.
 */
export async function assertTrustedLocalJobWorktree(jobId: string, worktreePath: string): Promise<void> {
  const job = await prisma.claudeJob.findUnique({
    where: { id: jobId },
    select: { product_id: true, task: { select: { repo_url: true } } },
  })
  if (!job?.product_id) throw new UntrustedWorktreeGitlinkError('job of product onbekend')
  // Dynamische import: wait-for-job importeert deze module statisch.
  const { resolveRepoRoot } = await import('../tools/wait-for-job.js')
  const repoRoot = await resolveRepoRoot(job.product_id, job.task?.repo_url ?? null, {
    explicitRootsOnly: true,
  })
  if (!repoRoot) throw new UntrustedWorktreeGitlinkError('geen expliciete repo-root voor deze job')
  await assertTrustedWorktreeGitlink(worktreePath, repoRoot)
}

