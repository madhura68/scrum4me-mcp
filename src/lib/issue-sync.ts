// src/lib/issue-sync.ts — Forgejo-mirror-executor (issue-tracker spec §6).
// Deze eerste versie synct bewust niets: elke mutatie laat forgejo_dirty staan
// en de repair-sweep in Scrum4Me is het gegarandeerde pad. Task 15 vervangt de
// body door de volledige executor (session-lock + render + HTTP + CAS).
export async function syncIssueToForgejo(_issueId: string): Promise<void> {
  return
}
