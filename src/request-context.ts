// Per-request authentication context.
//
// The stdio entrypoint identifies a single worker via the process-wide
// SCRUM4ME_TOKEN env var. The HTTP entrypoint serves many callers from one
// process, so the identity must come from each request's Authorization header
// instead. AsyncLocalStorage carries that per-request token through the async
// call-chain so getAuth() (and every tool that calls it) resolves the right
// user without any tool-level changes.
import { AsyncLocalStorage } from 'node:async_hooks'

export type RequestContext = {
  /** Raw scrum4me API token presented by the caller (Bearer in HTTP mode). */
  token: string
}

export const requestContext = new AsyncLocalStorage<RequestContext>()

/**
 * Resolve the scrum4me token for the current call.
 *
 * HTTP mode: the token set by the request middleware via requestContext.run().
 * stdio mode: no ALS store is active, so we fall back to the process env var —
 * preserving the existing single-worker behaviour unchanged.
 */
export function getRequestToken(): string | undefined {
  return requestContext.getStore()?.token ?? process.env.SCRUM4ME_TOKEN
}
