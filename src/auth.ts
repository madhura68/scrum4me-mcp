import { createHash } from 'crypto'
import type { ApiTokenKind } from '@prisma/client'
import { prisma } from './prisma.js'
import { getRequestToken } from './request-context.js'

export type AuthContext = {
  userId: string
  tokenId: string
  username: string
  isDemo: boolean
  kind: ApiTokenKind
  scopedProducts: string[]
}

export async function getAuth(): Promise<AuthContext> {
  // No process-lifetime cache: `ApiToken.user_id` can be re-pointed by an
  // admin user-migration (see `scripts/migrate-user.ts` in Scrum4Me). A long-
  // lived cache would keep writing the old user_id into ClaudeWorker rows
  // and into `claude_jobs.user_id` SQL filters until the worker is restarted.
  // One findUnique on a unique-indexed hash per request is cheap.
  // HTTP mode: token from the per-request ALS context (Bearer header).
  // stdio mode: falls back to process.env.SCRUM4ME_TOKEN (unchanged behaviour).
  const token = getRequestToken()
  if (!token) {
    throw new Error('SCRUM4ME_TOKEN is not set — see .env.example')
  }

  const tokenHash = createHash('sha256').update(token).digest('hex')
  const apiToken = await prisma.apiToken.findUnique({
    where: { token_hash: tokenHash },
    include: { user: true },
  })

  if (!apiToken || apiToken.revoked_at) {
    throw new Error('SCRUM4ME_TOKEN is invalid or revoked')
  }

  // IDEA-118 K11: een COPILOT-token zonder scope is per definitie
  // misconfiguratie — hard weigeren zodat hij nooit ongescopet draait.
  if (apiToken.kind === 'COPILOT' && apiToken.scoped_products.length === 0) {
    throw new Error('COPILOT token has empty scoped_products — token is misconfigured')
  }

  return {
    userId: apiToken.user_id,
    tokenId: apiToken.id,
    username: apiToken.user.username,
    isDemo: apiToken.user.is_demo,
    kind: apiToken.kind,
    scopedProducts: apiToken.scoped_products,
  }
}

export class PermissionDeniedError extends Error {
  constructor(message = 'Demo accounts cannot perform write operations') {
    super(message)
    this.name = 'PermissionDeniedError'
  }
}

export async function requireWriteAccess(): Promise<AuthContext> {
  const auth = await getAuth()
  if (auth.isDemo) {
    throw new PermissionDeniedError()
  }
  return auth
}

/**
 * Scope van het huidige request-token (IDEA-118 K3). [] = ongescopet.
 * Eigen goedkope findUnique i.p.v. cache: zie de cache-waarschuwing bij getAuth.
 * Faalpaden (geen/onbekend/ingetrokken token) geven [] terug — de tool faalt
 * dan toch al op getAuth(); deze helper hoeft alleen de scope-vraag te beantwoorden.
 */
export async function getTokenScopedProducts(): Promise<string[]> {
  const token = getRequestToken()
  if (!token) return []
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const row = await prisma.apiToken.findUnique({
    where: { token_hash: tokenHash },
    select: { scoped_products: true, revoked_at: true },
  })
  if (!row || row.revoked_at) return []
  return row.scoped_products
}
