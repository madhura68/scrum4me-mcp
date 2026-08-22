// `npm run canary:stdio` — the credentialless full-surface release canary.
//
// Builds the canary stdio server (full tool metadata, every handler forbidden),
// speaks exactly `initialize` + `tools/list` to it over an in-memory transport,
// hashes the canonical tool surface and prints a single StdioCanaryResultV1
// object. It requires no token, no database and no network; any other protocol
// traffic, a poisoned handler firing, or an unexpected error makes it exit
// non-zero. CI runs it on the pinned Node to attest the published surface.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createStdioServer, SERVER_NAME, VERSION } from '../src/stdio-server.js'
import type { StdioCanaryResultV1 } from '../src/canary-mode.js'

/** A tool descriptor as returned by `tools/list`, narrowed to the fields we hash. */
interface ToolDescriptor {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  annotations?: unknown
}

/** Recursively sort object keys so JSON.stringify is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

function toolSurfaceSha256(tools: ToolDescriptor[]): string {
  const surface = tools
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(canonicalize(surface))).digest('hex')
}

function resolveReleaseCommit(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.SCRUM4ME_RELEASE_COMMIT?.trim()
  if (fromEnv) return fromEnv
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export async function runStdioCanary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StdioCanaryResultV1> {
  const server = createStdioServer({ mode: 'canary' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  // The InMemory transport lacks setProtocolVersion; adding it lets the client
  // hand us the negotiated version so we report the real one, not a constant.
  let protocolVersion = ''
  ;(clientTransport as { setProtocolVersion?: (v: string) => void }).setProtocolVersion = (v) => {
    protocolVersion = v
  }

  const client = new Client({ name: 'scrum4me-mcp-canary', version: VERSION })

  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport) // sends `initialize`
    const { tools } = await client.listTools()
    const result: StdioCanaryResultV1 = {
      version: 'scrum4me-mcp-canary/v1',
      server_name: SERVER_NAME,
      server_version: VERSION,
      release_commit: resolveReleaseCommit(env),
      protocol_version: protocolVersion,
      tool_count: tools.length,
      tool_surface_sha256: toolSurfaceSha256(tools as ToolDescriptor[]),
      ok: true,
    }
    return result
  } finally {
    await client.close()
    await server.close()
  }
}

function isMainModule(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  runStdioCanary()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.exit(0)
    })
    .catch((err) => {
      console.error('stdio canary failed:', err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
}
