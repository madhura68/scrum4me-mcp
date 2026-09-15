import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { DispatchInput } from '@shared/queue-dispatch.js'
import type { DispatchActor } from './ports.js'
import { verifyDispatchAssertion, type AssertionRequest, type DispatchAssertionKeys } from './assertions.js'
import { DispatchError } from './errors.js'

export type DispatchOperation = 'read' | 'submit' | 'cancel' | 'claim' | 'start' | 'publish' | 'recover' | 'profile'
type Db = Pool | PoolClient
export type DispatchAuthRequest = AssertionRequest & { authorization?: string; assertion?: string }
type TokenRow = { id: string; user_id: string; kind: string; scoped_products: string[]; scoped_repos: string[] }
const forbidden = (): never => { throw new DispatchError('DISPATCH_FORBIDDEN') }
const unauthenticated = (): never => { throw new DispatchError('DISPATCH_UNAUTHENTICATED') }
const tokenSelect = `SELECT id,user_id,kind,scoped_products,scoped_repos FROM api_tokens
 WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`
function tokenActor(t: TokenRow): DispatchActor {
  if (!['IMPLEMENTATION', 'PLANNING', 'COPILOT', 'WORKERS_UI'].includes(t.kind)
    || (t.kind === 'COPILOT' && t.scoped_products.length === 0)) return unauthenticated()
  return { userId: t.user_id, principalKey: `bearer:${t.user_id}:${t.id}`, tokenId: t.id,
    source: 'bearer', isDemo: false, scopedProducts: t.scoped_products, scopedRepos: t.scoped_repos, tokenKind: t.kind }
}

export function createDispatchAuth(deps: { store: Pool; assertionKeys?: DispatchAssertionKeys }) {
  async function refreshActor(actor: DispatchActor, db: Db = deps.store): Promise<DispatchActor> {
    let current: DispatchActor
    if (actor.source === 'bearer') {
      const row = (await db.query<TokenRow>(`${tokenSelect} AND id=$1 AND user_id=$2`, [actor.tokenId, actor.userId])).rows[0]
      if (!row) return unauthenticated()
      current = tokenActor(row)
    } else {
      if (!['workers', 'web'].includes(actor.source) || actor.tokenId !== null) return unauthenticated()
      current = { ...actor, principalKey: `${actor.source}:${actor.userId}`, scopedProducts: [], scopedRepos: [], tokenKind: null }
    }
    if (actor.principalKey !== current.principalKey) return unauthenticated()
    const user = (await db.query<{ is_demo: boolean; admin: boolean }>(`SELECT u.is_demo,
      EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role='ADMIN') AS admin
      FROM users u WHERE u.id=$1`, [current.userId])).rows[0]
    if (!user) return unauthenticated()
    if (user.is_demo || (current.source === 'workers' && !user.admin)) return forbidden()
    return current
  }
  async function resolveDispatchActor(req: DispatchAuthRequest): Promise<DispatchActor> {
    if (req.authorization && req.assertion) return unauthenticated()
    if (req.assertion) {
      const c = verifyDispatchAssertion({ ...req, assertion: req.assertion, keys: deps.assertionKeys ?? {} })
      const source = c.iss === 'scrum4me-workers' ? 'workers' : 'web'
      return refreshActor({ userId: c.sub, principalKey: `${source}:${c.sub}`, tokenId: null, source,
        isDemo: false, scopedProducts: [], scopedRepos: [], tokenKind: null })
    }
    const match = /^Bearer ([^\s]+)$/.exec(req.authorization ?? '')
    if (!match) return unauthenticated()
    const row = (await deps.store.query<TokenRow>(`${tokenSelect} AND token_hash=$1`, [createHash('sha256').update(match[1]).digest('hex')])).rows[0]
    if (!row) return unauthenticated()
    return refreshActor(tokenActor(row))
  }
  async function productAccess(actor: DispatchActor, productId: string, write: boolean, db: Db) {
    if (actor.scopedProducts.length && !actor.scopedProducts.includes(productId)) return forbidden()
    const row = (await db.query<{ owner: boolean; access: string | null; role: string | null; repo_url: string | null; admin: boolean }>(
      `SELECT p.user_id=$2 AS owner,p.repo_url,m.access,m.role,
       EXISTS(SELECT 1 FROM user_roles WHERE user_id=$2 AND role='ADMIN') AS admin
       FROM products p LEFT JOIN product_members m ON m.product_id=p.id AND m.user_id=$2 WHERE p.id=$1`, [productId, actor.userId])).rows[0]
    if (!row || (!row.owner && (write ? row.access !== 'READ_WRITE' : !['READ_ONLY', 'READ_WRITE'].includes(row.access ?? '')))) return forbidden()
    return row
  }
  function repositoryScope(actor: DispatchActor, repoUrl: string | null) {
    // R8: scoped_repos contains exact registered Product.repo_url values, not ids/globs.
    if (!repoUrl || (actor.scopedRepos.length && !actor.scopedRepos.includes(repoUrl))) return forbidden()
  }
  async function authorizeDispatch(actor: DispatchActor, input: DispatchInput, operation: DispatchOperation, db: Db = deps.store): Promise<void> {
    const current = await refreshActor(actor, db)
    if (current.source === 'web' && !['read', 'cancel'].includes(operation)) return forbidden()
    const execution = ['submit', 'claim', 'start', 'publish'].includes(operation)
    const write = execution && (input.requirements.access === 'repo_write' || input.action === 'task_implementation')
    if (write && ['PLANNING', 'WORKERS_UI'].includes(current.tokenKind ?? '')) return forbidden()
    const main = await productAccess(current, input.product_id, write, db)
    if (['profile', 'recover'].includes(operation)
      && !(main.owner || (main.role === 'PRODUCT_OWNER' && main.access === 'READ_WRITE') || main.admin)) return forbidden()
    const repo = input.requirements.repository
    if (repo) repositoryScope(current, (await productAccess(current, repo.product_id, write, db)).repo_url)
    for (const ref of input.review_documents?.items ?? []) {
      const product = await productAccess(current, ref.product_id, false, db)
      if (ref.source === 'git') repositoryScope(current, product.repo_url)
    }
    if (operation === 'submit') {
      const address = await db.query('SELECT 1 FROM queue_dispatch_reply_addresses WHERE user_id=$1 AND address=$2 AND enabled', [current.userId, input.reply_to])
      if (!address.rowCount) return forbidden()
    }
  }
  async function authorizeRequestRead(actor: DispatchActor, input: DispatchInput, ownerId: string): Promise<void> {
    await authorizeDispatch(actor, input, 'read')
    if (actor.userId === ownerId) return
    if (actor.source === 'web') return forbidden()
    const current = await refreshActor(actor)
    const p = await productAccess(current, input.product_id, false, deps.store)
    if (!(p.owner || (p.role === 'PRODUCT_OWNER' && p.access === 'READ_WRITE') || p.admin)) return forbidden()
  }
  return { resolveDispatchActor, refreshActor, authorizeDispatch, authorizeRequestRead }
}
export type DispatchAuth = ReturnType<typeof createDispatchAuth>
