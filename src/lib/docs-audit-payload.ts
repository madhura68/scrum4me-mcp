// M19 DOCS_AUDIT payload-builder. Puur zodat het zonder DB testbaar is; de
// getFullJobContext-tak levert `lastJob`/`docIndex`/`now` aan uit de DB.
import { deriveDocsAuditSince, type LastDocsAuditJob } from '@shared/docs-audit-cursor.js'

export type DocsAuditPayload = {
  product: { id: string; name: string; repo_url: string }
  since: string
  is_scrum4me: boolean
  doc_index: unknown
}

export function buildDocsAuditPayload(input: {
  product: { id: string; name: string; repo_url: string | null; code: string | null }
  lastJob: LastDocsAuditJob
  docIndex: unknown
  now: Date
}): DocsAuditPayload {
  const { product, lastJob, docIndex, now } = input
  return {
    product: { id: product.id, name: product.name, repo_url: product.repo_url ?? '' },
    since: deriveDocsAuditSince(lastJob, now).toISOString(),
    is_scrum4me: product.code === 'SCRUM4ME',
    doc_index: docIndex,
  }
}
