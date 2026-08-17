// Dunne wrappers om callForgejo voor de issue-endpoints (issue-tracker spec §6).
// Bewust apart van forgejo-rest.ts: dat bestand gaat over de PR-flow, dit over
// de issue-spiegel. Alles is write, want de spiegel schrijft altijd terug.
import { callForgejo } from './forgejo-rest.js'

export type ForgejoLabel = { id: number; name: string }
export type ForgejoIssue = { number: number }

export async function listLabels(owner: string, repo: string): Promise<ForgejoLabel[]> {
  const labels = await callForgejo<ForgejoLabel[]>(`/repos/${owner}/${repo}/labels?limit=100`, {
    write: true,
  })
  return Array.isArray(labels) ? labels : []
}

export async function createLabel(
  owner: string,
  repo: string,
  label: { name: string; color: string },
): Promise<ForgejoLabel> {
  return callForgejo<ForgejoLabel>(`/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    write: true,
    json: label,
  })
}

/**
 * Vindt een bestaand mirror-issue terug aan de HTML-marker in de body. Dit is
 * het vangnet na een verloren forgejo_number: zonder deze zoekactie zou een
 * tweede issue ontstaan naast het bestaande.
 */
export async function searchIssueByMarker(
  owner: string,
  repo: string,
  marker: string,
): Promise<number | null> {
  const found = await callForgejo<ForgejoIssue[]>(
    `/repos/${owner}/${repo}/issues?q=${encodeURIComponent(marker)}&type=issues&state=all&limit=1`,
    { write: true },
  )
  return Array.isArray(found) && found[0]?.number ? found[0].number : null
}

export async function createIssue(
  owner: string,
  repo: string,
  body: { title: string; body: string; closed: boolean },
): Promise<ForgejoIssue> {
  return callForgejo<ForgejoIssue>(`/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    write: true,
    json: body,
  })
}

export async function editIssue(
  owner: string,
  repo: string,
  index: number,
  body: { title: string; body: string; state: 'open' | 'closed' },
): Promise<ForgejoIssue> {
  return callForgejo<ForgejoIssue>(`/repos/${owner}/${repo}/issues/${index}`, {
    method: 'PATCH',
    write: true,
    json: body,
  })
}

/** PUT vervangt de volledige labelset — dat is precies de full-state-semantiek. */
export async function setIssueLabels(
  owner: string,
  repo: string,
  index: number,
  names: string[],
): Promise<unknown> {
  return callForgejo(`/repos/${owner}/${repo}/issues/${index}/labels`, {
    method: 'PUT',
    write: true,
    json: { labels: names },
  })
}
