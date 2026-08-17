// src/lib/issue-sync.ts — Forgejo-mirror-executor (issue-tracker spec §6).
//
// Zelfde algoritme als de web-executor (lib/issue-sync-server.ts in Scrum4Me):
// session-lock op een pooler-vrije verbinding, render én CAS-snapshot uit één
// verse read ná de lock, en boekhouding via de pg-client zodat updated_at
// onaangeraakt blijft.
//
// De executor verwerpt nooit: hij wordt als floating promise aangeroepen vanuit
// de tools, en een unhandled rejection zou het MCP-proces kunnen beëindigen.
import { Client } from 'pg'

import { prisma } from '../prisma.js'
import { withIssueSessionLock } from '../db/session-lock.js'
import {
  listLabels, createLabel, searchIssueByMarker, createIssue, editIssue, setIssueLabels,
} from '../git/forgejo-issues.js'
import { ForgejoError } from '../git/forgejo-rest.js'
import {
  renderIssueTitle, renderIssueBody, renderIssueLabels, renderIssueState,
  issueMarker, ISSUE_LABEL_COLORS, HOST_LABEL_COLOR, DEFAULT_APP_BASE_URL,
  type IssueMirrorIssue, type IssueMirrorProduct,
} from '@shared/issue-forgejo-mirror.js'

export type SyncOutcome = {
  outcome: 'synced' | 'skipped' | 'stale' | 'failed'
  reason?: string
}

const FORGEJO_HOST = process.env.FORGEJO_HOST ?? 'git.jp-visser.nl'

export function parseForgejoRepoPath(repoUrl: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(repoUrl)
    if (url.hostname !== FORGEJO_HOST) return null
    const [owner, repoRaw] = url.pathname.replace(/^\//, '').replace(/\/+$/, '').split('/')
    if (!owner || !repoRaw) return null
    return { owner, repo: repoRaw.replace(/\.git$/, '') }
  } catch {
    return null
  }
}

function toIsoString(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v
}

/**
 * Fouttekst voor `forgejo_error`. Dat veld reist over het gedeelde
 * NOTIFY-kanaal naar elke SSE-client met toegang tot het product en wordt in de
 * UI getoond, dus het draagt bewust géén upstream response-body: ForgejoError
 * neemt die wél mee in zijn message (nuttig in de MCP-log, niet iets om breed
 * te verspreiden). Status en code zeggen genoeg om te weten wat er mis is.
 */
function describeSyncError(err: unknown): string {
  if (err instanceof ForgejoError) {
    return err.status ? `Forgejo ${err.status} (${err.code})` : `Forgejo ${err.code}`
  }
  return err instanceof Error ? err.message : String(err)
}

export async function syncIssueToForgejo(issueId: string): Promise<SyncOutcome> {
  try {
    if (process.env.ISSUE_FORGEJO_SYNC === 'off') {
      return { outcome: 'skipped', reason: 'disabled' }
    }

    // Voorcontrole zónder render-data — bespaart alleen een lock voor rijen die
    // evident niets te spiegelen hebben.
    const pre = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { id: true, product: { select: { repo_url: true } } },
    })
    if (!pre) return { outcome: 'skipped', reason: 'issue not found' }
    if (!pre.product?.repo_url) return { outcome: 'skipped', reason: 'product has no repo' }
    if (!process.env.FORGEJO_TOKEN) return { outcome: 'skipped', reason: 'no forgejo token' }

    const locked = await withIssueSessionLock(issueId, async (client) => syncUnderLock(issueId, client))
    if (!locked.ok) {
      // Geen DIRECT_URL of de lock is elders: beide keren blijft dirty staan en
      // pakt de web-sweep het op.
      return { outcome: 'skipped', reason: locked.reason }
    }
    return locked.value
  } catch (err) {
    const message = describeSyncError(err)
    await writeFailure(issueId, message)
    return { outcome: 'failed', reason: message }
  }
}

async function syncUnderLock(issueId: string, client: Client): Promise<SyncOutcome> {
  try {
    // Post-lock: de volledige render-projectie én de seq-snapshot uit dezelfde
    // verse rij.
    const row = await prisma.issue.findUnique({
      where: { id: issueId },
      select: {
        id: true, code: true, title: true, description: true,
        research_md: true, resolution_md: true, status: true, resolution: true,
        severity: true, reported_by: true, occurrence_count: true,
        last_seen_at: true, created_at: true, archived: true,
        forgejo_repo: true, forgejo_number: true, forgejo_sync_seq: true,
        linked_pbi: { select: { code: true } },
        linked_idea: { select: { code: true } },
        product: { select: { name: true, kind: true, repo_url: true } },
      },
    })
    if (!row) return { outcome: 'skipped', reason: 'issue disappeared' }
    if (!row.product?.repo_url) {
      // Verdwenen ná de voorcontrole: bedoeld permanent dirty, dus geen
      // foutregistratie.
      return { outcome: 'skipped', reason: 'product lost its repo' }
    }

    const parsed = parseForgejoRepoPath(row.product.repo_url)
    if (!parsed) {
      await writeFailureOn(client, issueId, `repo_url is geen Forgejo-URL: ${row.product.repo_url}`)
      return { outcome: 'failed', reason: 'unsupported repo host' }
    }
    const { owner, repo } = parsed
    const repoPath = `${owner}/${repo}`

    const mirrorIssue: IssueMirrorIssue = {
      id: row.id,
      code: row.code,
      title: row.title,
      description: row.description,
      research_md: row.research_md,
      resolution_md: row.resolution_md,
      status: row.status,
      resolution: row.resolution,
      severity: row.severity,
      reported_by: row.reported_by,
      occurrence_count: row.occurrence_count,
      last_seen_at: toIsoString(row.last_seen_at),
      created_at: toIsoString(row.created_at),
      linked_pbi_code: row.linked_pbi?.code ?? null,
      linked_idea_code: row.linked_idea?.code ?? null,
      archived: row.archived,
    }
    const mirrorProduct: IssueMirrorProduct = { name: row.product.name, kind: row.product.kind }
    const appBaseUrl = process.env.SCRUM4ME_BASE_URL ?? DEFAULT_APP_BASE_URL

    const title = renderIssueTitle(mirrorIssue, mirrorProduct)
    const body = renderIssueBody(mirrorIssue, mirrorProduct, appBaseUrl)
    const labels = renderIssueLabels(mirrorIssue, mirrorProduct)
    const state = renderIssueState(mirrorIssue)

    const existingLabels = await listLabels(owner, repo)
    const have = new Set(existingLabels.map((l) => l.name))
    for (const name of labels) {
      if (have.has(name)) continue
      await createLabel(owner, repo, { name, color: ISSUE_LABEL_COLORS[name] ?? HOST_LABEL_COLOR })
    }

    let number = row.forgejo_number
    if (row.forgejo_repo && row.forgejo_repo !== repoPath) {
      await prisma.issueLog.create({
        data: {
          issue_id: issueId,
          type: 'SYNC',
          content: `doelrepo gewijzigd van ${row.forgejo_repo} naar ${repoPath} — nieuw mirror-issue`,
        },
      })
      number = null
    }

    if (!number) {
      number = await searchIssueByMarker(owner, repo, issueMarker(row.id))
    }
    if (!number) {
      const created = await createIssue(owner, repo, { title, body, closed: state === 'closed' })
      number = created.number
    } else {
      await editIssue(owner, repo, number, { title, body, state })
    }
    await setIssueLabels(owner, repo, number, labels)

    await client.query(
      'UPDATE issues SET forgejo_repo = $1, forgejo_number = $2 WHERE id = $3',
      [repoPath, number, issueId],
    )
    const cas = await client.query(
      `UPDATE issues
       SET forgejo_dirty = false, forgejo_synced_at = now(),
           forgejo_attempted_at = now(), forgejo_error = NULL
       WHERE id = $1 AND forgejo_sync_seq = $2`,
      [issueId, row.forgejo_sync_seq],
    )
    if (cas.rowCount === 0) {
      return { outcome: 'stale', reason: 'mutated during sync' }
    }
    return { outcome: 'synced' }
  } catch (err) {
    const message = describeSyncError(err)
    await writeFailureOn(client, issueId, message)
    return { outcome: 'failed', reason: message }
  }
}

async function writeFailureOn(client: Client, issueId: string, message: string): Promise<void> {
  try {
    await client.query(
      'UPDATE issues SET forgejo_error = left($1, 500), forgejo_attempted_at = now() WHERE id = $2',
      [message, issueId],
    )
  } catch (err) {
    console.error(`[issue-sync] ${issueId}: ${message}`, err)
  }
}

/** Faalpad buiten de lock om — bijvoorbeeld als connect() zelf mislukt. */
async function writeFailure(issueId: string, message: string): Promise<void> {
  const directUrl = process.env.DIRECT_URL
  if (!directUrl) {
    console.error(`[issue-sync] ${issueId}: ${message} (geen DIRECT_URL om dit vast te leggen)`)
    return
  }
  const client = new Client({ connectionString: directUrl })
  try {
    await client.connect()
    await writeFailureOn(client, issueId, message)
  } catch (err) {
    console.error(`[issue-sync] ${issueId}: ${message}`, err)
  } finally {
    try {
      await client.end()
    } catch {
      // niets meer te doen
    }
  }
}
