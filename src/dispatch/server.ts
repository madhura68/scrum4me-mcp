import { pathToFileURL } from 'node:url'
import { createDispatchStore } from './db.js'
import { createDispatchApp } from './routes.js'
export { createDispatchApp } from './routes.js'

/** Intake/read entrypoint only. Tick and remaining route wiring arrive in IP-13. */
export function startDispatchServer(env: NodeJS.ProcessEnv = process.env) {
  const store = createDispatchStore(env.DISPATCH_DATABASE_URL ?? '')
  const app = createDispatchApp({ store, enabled: env.DISPATCH_ENABLED === '1',
    productAllowlist: (env.DISPATCH_PRODUCT_ALLOWLIST ?? '').split(',').map(id => id.trim()).filter(Boolean),
    assertionKeys: {
      workers: env.DISPATCH_WORKERS_ASSERTION_KEY ? Buffer.from(env.DISPATCH_WORKERS_ASSERTION_KEY, 'utf8') : undefined,
      web: env.DISPATCH_WEB_ASSERTION_KEY ? Buffer.from(env.DISPATCH_WEB_ASSERTION_KEY, 'utf8') : undefined,
    }, log: event => process.stdout.write(`${JSON.stringify(event)}\n`) })
  const server = app.listen(Number(env.DISPATCH_PORT ?? 4319), env.DISPATCH_HOST ?? '127.0.0.1')
  const close = async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await store.end() }
  return { server, close }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const running = startDispatchServer()
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void running.close().catch(() => { process.exitCode = 1 }) })
  } catch { process.stderr.write('DISPATCH_START_FAILED\n'); process.exitCode = 1 }
}
