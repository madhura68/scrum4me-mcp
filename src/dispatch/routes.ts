import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import { performance } from 'node:perf_hooks'
import { createDispatchAuth } from './auth.js'
import type { DispatchAssertionKeys } from './assertions.js'
import type { DispatchStore } from './db.js'
import { createDispatchRequests } from './requests.js'
import { DispatchError, dispatchHttpStatus } from './errors.js'
import { isQueueDispatchRequestId } from '@shared/queue-identity.js'

export type DispatchHttpLog = { operation: 'submit' | 'read'; request_id: string | null; status: number; duration_ms: number }
export type DispatchAppDependencies = {
  store: DispatchStore; assertionKeys?: DispatchAssertionKeys; enabled: boolean
  productAllowlist: readonly string[]; log?: (event: DispatchHttpLog) => void
}
export function createDispatchApp(deps: DispatchAppDependencies): Express {
  const app = express(); app.disable('x-powered-by')
  const auth = createDispatchAuth(deps); const service = createDispatchRequests({ ...deps, auth })
  function handler(operation: 'submit' | 'read') {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        let body: unknown
        if (operation === 'submit') {
          try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) } catch { throw new DispatchError('DISPATCH_BAD_JSON') }
        }
        const actor = await auth.resolveDispatchActor({ authorization: req.get('Authorization'), assertion: req.get('X-Dispatch-Assertion'),
          method: req.method, path: req.originalUrl, rawBody })
        const view = operation === 'submit'
          ? await service.submitDispatch(actor, body, req.get('Idempotency-Key') ?? '')
          : await service.getDispatch(actor, req.params.id)
        res.locals.dispatchRequestId = view.id
        res.status(200).json(view)
      } catch (error) { next(error) }
    }
  }
  function log(operation: 'submit' | 'read') {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = performance.now()
      res.on('finish', () => {
        const id = res.locals.dispatchRequestId ?? req.params.id
        try { deps.log?.({ operation, request_id: typeof id === 'string' && isQueueDispatchRequestId(id) ? id : null,
          status: res.statusCode, duration_ms: Math.round(performance.now() - start) }) } catch { /* Logging cannot fail an action. */ }
      })
      next()
    }
  }
  // Capture bytes before JSON parsing; reject compression instead of authenticating decompressed bytes.
  const raw = express.raw({ type: () => true, limit: 256 * 1024, inflate: false })
  app.post('/dispatch/v1/requests', log('submit'), raw, handler('submit'))
  app.get('/dispatch/v1/requests/:id', log('read'), raw, handler('read'))
  app.use((_req, res) => { res.status(404).json({ error: 'DISPATCH_NOT_FOUND' }) })
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof DispatchError) { res.status(dispatchHttpStatus(error)).json({ error: error.code }); return }
    const type = error && typeof error === 'object' && 'type' in error ? error.type : null
    const code = type === 'entity.too.large' ? 'DISPATCH_TOO_LARGE' : type === 'encoding.unsupported' ? 'DISPATCH_BAD_JSON' : null
    res.status(code === 'DISPATCH_TOO_LARGE' ? 413 : code ? 400 : 500).json({ error: code ?? 'DISPATCH_INTERNAL_ERROR' })
  })
  return app
}
