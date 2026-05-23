#!/usr/bin/env node
// Centralized HTTP entrypoint for scrum4me-mcp.
//
// One process serves many callers. Unlike the stdio entrypoint (one process =
// one worker via SCRUM4ME_TOKEN), identity here is per request: the caller's
// scrum4me token is the HTTP Bearer credential, resolved to a user on every
// call (see request-context.ts + auth.ts). Only the shared DB/network tools are
// exposed — worktree-bound tools must run co-located with the agent (stdio).
//
// Transport is stateless: every POST /mcp is self-contained
// (sessionIdGenerator: undefined), the pattern proven in the standalone
// private-mcp server. No per-session transport map to leak.
import express, { type Request, type Response, type NextFunction } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { registerSharedTools } from './register.js'
import { getAuth } from './auth.js'
import { requestContext } from './request-context.js'
import { INSTRUCTIONS } from './instructions.js'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function readPkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', 'package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
const VERSION = readPkgVersion()

const port = Number(process.env.PORT ?? 8000)
const host = process.env.HOST ?? '0.0.0.0'

const app = express()
app.use(express.json({ limit: '4mb' }))

// Structured access log (one line per request).
app.use((req: Request, res: Response, next: NextFunction) => {
  const startedAt = Date.now()
  res.on('finish', () => {
    console.log(
      JSON.stringify({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      }),
    )
  })
  next()
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'scrum4me-mcp-http', version: VERSION })
})

function extractBearer(req: Request): string | null {
  const header = req.header('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'scrum4me-mcp', version: VERSION }, { instructions: INSTRUCTIONS })
  registerSharedTools(server)
  return server
}

function jsonRpcError(res: Response, httpStatus: number, code: number, message: string): void {
  res.status(httpStatus).json({ jsonrpc: '2.0', error: { code, message }, id: null })
}

app.post('/mcp', async (req: Request, res: Response) => {
  const token = extractBearer(req)
  if (!token) {
    jsonRpcError(res, 401, -32001, 'Missing Bearer token')
    return
  }

  // Bind the per-request token for the whole async chain so getAuth() — and
  // every tool that calls it — resolves THIS caller. The token is validated up
  // front (one cheap indexed lookup) for a clean 401 instead of per-tool errors.
  await requestContext.run({ token }, async () => {
    try {
      await getAuth()
    } catch {
      jsonRpcError(res, 401, -32001, 'Invalid or revoked scrum4me token')
      return
    }

    const server = createMcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close()
      server.close()
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
})

// Stateless mode: no standalone SSE stream or session to GET/DELETE.
function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: use POST /mcp' },
    id: null,
  })
}
app.get('/mcp', methodNotAllowed)
app.delete('/mcp', methodNotAllowed)

app.listen(port, host, () => {
  console.log(`scrum4me-mcp HTTP ${VERSION} listening on ${host}:${port}`)
})
