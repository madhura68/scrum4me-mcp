// M21 (spec §2): sprint-batch auto-deploy — eigen module zodat update-job-status
// de helper kan importeren én mocken.

// Genormaliseerde repo-bucket-key. null/undefined/lege/whitespace-only repo_url
// EN de expliciete product-repo-url (met of zonder .git-suffix) = het
// product-repo (de "product"-bucket, gerepresenteerd als null); een andere url
// = een eigen bucket. Gedeeld door maybeCreateAutoPr en de sprint-batch-helper.
export function repoBucketKey(
  repoUrl: string | null | undefined,
  productRepoUrl: string | null | undefined,
): string | null {
  const norm = (u: string | null | undefined): string | null => {
    if (u == null || u.trim() === '') return null
    return u.trim().replace(/\.git$/, '')
  }
  const r = norm(repoUrl)
  if (r === null) return null
  if (r === norm(productRepoUrl)) return null
  return r
}
