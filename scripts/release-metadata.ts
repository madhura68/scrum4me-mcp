// `npm run release:metadata` — collect fail-closed, reproducible build metadata
// for a Scrum4Me-MCP companion release (IDEA-187).
//
// The collector attests an EXACT `origin/main` merge commit and nothing else. It
// verifies, in order and fail-closed: Git merge ancestry against the remote ref,
// the pinned Node toolchain, clean recursive submodules, a committed generated
// Prisma schema, well-formed release-gate evidence, and that every content digest
// is bound by the gate that attests it:
//
//   - `schema`       gate evidence == sha256(prisma/schema.prisma)
//   - `typecheck`    gate evidence == sha256(package-lock.json)  (the exact
//                    dependency closure the typecheck ran against)
//   - `stdio_canary` gate evidence == sha256(.release/tool-surface.json)
//   - `tests`        gate evidence == opaque run digest (present + 64-hex only)
//
// Any deviation throws a typed error; the metadata object is only constructed
// once all facts hold. Git, filesystem, Node version and gate evidence are
// injected (`ReleaseMetadataDependencies`) so every failure mode is deterministic
// in unit tests (`__tests__/release-metadata.test.ts`). Evidence records only
// command identifiers, exit status and digests — never stdout, env or secrets.

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile as fsReadFile, writeFile, mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)

export const RELEASE_REPOSITORY =
  'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git'
export const RELEASE_SOURCE_REF = 'refs/remotes/origin/main'
export const RELEASE_NODE_VERSION = '24.19.0'

export type ReleaseGateId = 'schema' | 'typecheck' | 'tests' | 'stdio_canary'

/** Fixed order in which gates are recorded and validated. */
export const RELEASE_GATE_IDS: readonly ReleaseGateId[] = [
  'schema',
  'typecheck',
  'tests',
  'stdio_canary',
]

export interface Scrum4MeMcpBuildMetadataV1 {
  version: 'scrum4me-mcp-build/v1'
  repository: 'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git'
  source_ref: 'refs/remotes/origin/main'
  commit: string
  attested_merge_parents: readonly [string, string]
  submodules: Readonly<Record<string, string>>
  package_lock_sha256: string
  generated_schema_sha256: string
  node_version: '24.19.0'
  tool_surface_sha256: string
  gates: readonly {
    id: ReleaseGateId
    result: 'passed'
    evidence_sha256: string
  }[]
}

export interface ReleaseMetadataDependencies {
  git(args: readonly string[]): Promise<string>
  readFile(path: string): Promise<Buffer>
  nodeVersion(): string
  gateEvidence(): Promise<ReadonlyMap<string, string>>
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Parse `git submodule status --recursive`. Every entry must be clean: the
 * leading flag is a space. `-` (uninitialised), `+` (checkout differs from the
 * recorded commit) and `U` (merge conflict) all fail closed.
 */
function parseSubmodules(status: string): Record<string, string> {
  const submodules: Record<string, string> = {}
  for (const raw of status.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    if (line[0] !== ' ') throw new Error('SUBMODULE_NOT_CLEAN')
    const match = line.slice(1).match(/^([0-9a-f]{40})\s+(\S+)/)
    if (!match) throw new Error('SUBMODULE_NOT_CLEAN')
    submodules[match[2]] = match[1]
  }
  return submodules
}

export async function collectReleaseMetadata(
  deps: ReleaseMetadataDependencies,
): Promise<Scrum4MeMcpBuildMetadataV1> {
  // 1. Immutable Git facts: an exact two-parent merge that IS origin/main.
  const head = (await deps.git(['rev-parse', 'HEAD'])).trim()
  const originMain = (await deps.git(['rev-parse', RELEASE_SOURCE_REF])).trim()
  const parents = (await deps.git(['show', '-s', '--format=%P', 'HEAD']))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (head !== originMain || parents.length !== 2) {
    throw new Error('RELEASE_COMMIT_NOT_ORIGIN_MAIN_MERGE')
  }

  // 2. Pinned toolchain.
  if (deps.nodeVersion() !== `v${RELEASE_NODE_VERSION}`) {
    throw new Error('NODE_VERSION_MISMATCH')
  }

  // 3. Clean recursive submodules.
  const submodules = parseSubmodules(
    await deps.git(['submodule', 'status', '--recursive']),
  )

  // 4. The generated Prisma schema must be committed, not a dirty working copy.
  const schemaStatus = (
    await deps.git(['status', '--porcelain', '--', 'prisma/schema.prisma'])
  ).trim()
  if (schemaStatus !== '') throw new Error('GENERATED_SCHEMA_NOT_COMMITTED')

  // 5. Gate evidence: exactly the required keys, each a well-formed sha256.
  const evidence = await deps.gateEvidence()
  for (const id of RELEASE_GATE_IDS) {
    const digest = evidence.get(id)
    if (digest === undefined) throw new Error(`GATE_EVIDENCE_MISSING:${id}`)
    if (!SHA256_HEX.test(digest)) throw new Error(`GATE_EVIDENCE_MALFORMED:${id}`)
  }
  for (const key of evidence.keys()) {
    if (!RELEASE_GATE_IDS.includes(key as ReleaseGateId)) {
      throw new Error(`GATE_EVIDENCE_UNKNOWN_KEY:${key}`)
    }
  }

  // 6. Content digests, each bound by the gate that attests it.
  const packageLockSha256 = sha256(await deps.readFile('package-lock.json'))
  const generatedSchemaSha256 = sha256(await deps.readFile('prisma/schema.prisma'))
  const toolSurfaceSha256 = sha256(await deps.readFile('.release/tool-surface.json'))

  if (packageLockSha256 !== evidence.get('typecheck')) {
    throw new Error('LOCK_HASH_MISMATCH')
  }
  if (generatedSchemaSha256 !== evidence.get('schema')) {
    throw new Error('SCHEMA_HASH_MISMATCH')
  }
  if (toolSurfaceSha256 !== evidence.get('stdio_canary')) {
    throw new Error('TOOL_SURFACE_HASH_MISMATCH')
  }

  return {
    version: 'scrum4me-mcp-build/v1',
    repository: RELEASE_REPOSITORY,
    source_ref: RELEASE_SOURCE_REF,
    commit: head,
    attested_merge_parents: [parents[0], parents[1]],
    submodules,
    package_lock_sha256: packageLockSha256,
    generated_schema_sha256: generatedSchemaSha256,
    node_version: RELEASE_NODE_VERSION,
    tool_surface_sha256: toolSurfaceSha256,
    gates: RELEASE_GATE_IDS.map((id) => ({
      id,
      result: 'passed' as const,
      evidence_sha256: evidence.get(id) as string,
    })),
  }
}

/**
 * Real dependencies rooted at the repository. `gateEvidence` reads
 * `.release/gates.json` — a `{ gateId: sha256 }` map the release sequence writes
 * from its already-green gates (see the Forgejo push-CI job on `main`).
 */
export function defaultReleaseMetadataDependencies(
  root: string,
): ReleaseMetadataDependencies {
  return {
    git: async (args) => {
      const { stdout } = await execFileAsync('git', [...args], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      })
      return stdout
    },
    readFile: (path) => fsReadFile(join(root, path)),
    nodeVersion: () => process.version,
    gateEvidence: async () => {
      const raw = await fsReadFile(join(root, '.release', 'gates.json'), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, string>
      return new Map(Object.entries(parsed))
    },
  }
}

function parseOutputFlag(argv: readonly string[]): string {
  const index = argv.indexOf('--output')
  if (index === -1) throw new Error('MISSING_OUTPUT_FLAG: pass --output <path>')
  const output = argv[index + 1]
  if (!output) throw new Error('MISSING_OUTPUT_FLAG: --output requires a path')
  return output
}

function isMainModule(): boolean {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    )
  } catch {
    return false
  }
}

if (isMainModule()) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const outputPath = parseOutputFlag(process.argv.slice(2))
  collectReleaseMetadata(defaultReleaseMetadataDependencies(repoRoot))
    .then(async (metadata) => {
      const absolute = join(repoRoot, outputPath)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, `${JSON.stringify(metadata, null, 2)}\n`)
      process.stdout.write(`${metadata.commit}\n`)
      process.exit(0)
    })
    .catch((err) => {
      console.error(
        'release metadata failed:',
        err instanceof Error ? err.message : String(err),
      )
      process.exit(1)
    })
}
