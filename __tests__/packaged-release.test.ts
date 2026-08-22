import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse } from 'yaml'

import { runStdioCanary } from '../scripts/stdio-canary.js'
import {
  verifyReleasePackage,
  type PackagedReleaseIdentityV1,
} from '../scripts/verify-release-package.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const releases: string[] = []
const execFileAsync = promisify(execFile)
const sha256 = (contents: string | Buffer): string =>
  createHash('sha256').update(contents).digest('hex')

type ReleasePackageModule = {
  copyReleaseSourceFiles?: (
    sourceRoot: string,
    releaseRoot: string,
    paths: readonly string[],
  ) => Promise<void>
  copyTrackedFiles?: (sourceRoot: string, releaseRoot: string) => Promise<void>
  preflightReleaseArchive?: (archivePath: string) => Promise<void>
}

async function releasePackageModule(): Promise<ReleasePackageModule> {
  return (await import('../scripts/verify-release-package.js')) as ReleasePackageModule
}

function writeTarString(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = Buffer.from(value)
  if (bytes.length > length) throw new Error('test tar field too long')
  bytes.copy(target, offset)
}

function writeTarOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  writeTarString(target, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

function makeTarGzip(entries: readonly {
  name: string
  type: string
  linkName?: string
  contents?: string
}[], mutateHeader?: (header: Buffer) => void): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? '')
    const header = Buffer.alloc(512)
    writeTarString(header, 0, 100, entry.name)
    writeTarOctal(header, 100, 8, 0o644)
    writeTarOctal(header, 108, 8, 0)
    writeTarOctal(header, 116, 8, 0)
    writeTarOctal(header, 124, 12, contents.length)
    writeTarOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    writeTarString(header, 156, 1, entry.type)
    writeTarString(header, 157, 100, entry.linkName ?? '')
    writeTarString(header, 257, 6, 'ustar\0')
    writeTarString(header, 263, 2, '00')
    writeTarOctal(header, 329, 8, 0)
    writeTarOctal(header, 337, 8, 0)
    mutateHeader?.(header)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
    chunks.push(header, contents)
    const remainder = contents.length % 512
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

async function makePackagedRelease(options: {
  removeGit: boolean
}): Promise<string> {
  const releaseRoot = await mkdtemp(join(tmpdir(), 'scrum4me-mcp-packaged-'))
  releases.push(releaseRoot)

  for (const path of ['scripts', 'src', 'vendor']) {
    await cp(join(REPO_ROOT, path), join(releaseRoot, path), { recursive: true })
  }
  for (const path of ['package.json', 'tsconfig.json']) {
    await cp(join(REPO_ROOT, path), join(releaseRoot, path))
  }
  await symlink(join(REPO_ROOT, 'node_modules'), join(releaseRoot, 'node_modules'))

  if (!options.removeGit) {
    await cp(join(REPO_ROOT, '.git'), join(releaseRoot, '.git'), { recursive: true })
  }
  return releaseRoot
}

async function runPackagedCanary(
  releaseRoot: string,
  envOverrides: NodeJS.ProcessEnv,
): Promise<unknown> {
  const child = spawn(
    process.execPath,
    [TSX_CLI, join(releaseRoot, 'scripts', 'stdio-canary.ts')],
    {
      cwd: releaseRoot,
      env: {
        ...process.env,
        ...envOverrides,
        TSX_TSCONFIG_PATH: join(releaseRoot, 'tsconfig.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (status !== 0) throw new Error(stderr.trim() || `canary exited ${status}`)
  return JSON.parse(stdout.trim()) as unknown
}

afterEach(async () => {
  await Promise.all(releases.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('packaged release identity', () => {
  it('runs without .git and rejects an unknown packaged commit', async () => {
    const release = await makePackagedRelease({ removeGit: true })
    await expect(
      runPackagedCanary(release, {
        SCRUM4ME_RELEASE_COMMIT: undefined,
      }),
    ).rejects.toThrow('PACKAGED_RELEASE_IDENTITY_MISSING')
  })

  it('uses the packaged identity as the only commit source without .git', async () => {
    const release = await makePackagedRelease({ removeGit: true })
    const commit = 'a'.repeat(40)
    const surface = (await runStdioCanary({
      SCRUM4ME_RELEASE_COMMIT: commit,
    })).tool_surface_sha256
    await mkdir(join(release, 'release'), { recursive: true })
    await writeFile(
      join(release, 'release', 'package-identity.v1.json'),
      `${JSON.stringify({
        version: 'scrum4me-mcp-package-identity/v1',
        repository: 'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git',
        commit,
        tree_oid: 'b'.repeat(40),
        tool_surface_sha256: surface,
        content_manifest_sha256: 'd'.repeat(64),
      })}\n`,
    )

    const result = (await runPackagedCanary(release, {
      SCRUM4ME_RELEASE_COMMIT: undefined,
    })) as { release_commit: string }

    expect(result.release_commit).toBe(commit)
  })

  it('rejects a packaged identity whose surface differs from the live tool surface', async () => {
    const release = await makePackagedRelease({ removeGit: true })
    await mkdir(join(release, 'release'), { recursive: true })
    await writeFile(
      join(release, 'release', 'package-identity.v1.json'),
      `${JSON.stringify({
        version: 'scrum4me-mcp-package-identity/v1',
        repository: 'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git',
        commit: 'a'.repeat(40),
        tree_oid: 'b'.repeat(40),
        tool_surface_sha256: '0'.repeat(64),
        content_manifest_sha256: 'd'.repeat(64),
      })}\n`,
    )

    await expect(
      runPackagedCanary(release, { SCRUM4ME_RELEASE_COMMIT: undefined }),
    ).rejects.toThrow('PACKAGED_RELEASE_TOOL_SURFACE_MISMATCH')
  })
})

describe('verifyReleasePackage', () => {
  it('verifies the identity-bound manifest and rejects changed package bytes', async () => {
    const release = await mkdtemp(join(tmpdir(), 'scrum4me-mcp-verified-'))
    releases.push(release)
    const payload = 'export const value = 1\n'
    await mkdir(join(release, 'src'), { recursive: true })
    await mkdir(join(release, 'release'), { recursive: true })
    await writeFile(join(release, 'src', 'example.ts'), payload)

    const identityBase = {
      version: 'scrum4me-mcp-package-identity/v1' as const,
      repository: 'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git' as const,
      commit: 'a'.repeat(40),
      tree_oid: 'b'.repeat(40),
      tool_surface_sha256: 'c'.repeat(64),
    }
    const manifestBytes = `${JSON.stringify(
      {
        version: 'scrum4me-mcp-content-manifest/v1',
        repository: identityBase.repository,
        package_identity: identityBase,
        files: [
          {
            path: 'src/example.ts',
            bytes: Buffer.byteLength(payload),
            sha256: sha256(payload),
          },
        ],
      },
      null,
      2,
    )}\n`
    const identity: PackagedReleaseIdentityV1 = {
      ...identityBase,
      content_manifest_sha256: sha256(manifestBytes),
    }
    await writeFile(
      join(release, 'release', 'content-manifest.v1.json'),
      manifestBytes,
    )
    await writeFile(
      join(release, 'release', 'package-identity.v1.json'),
      `${JSON.stringify(identity, null, 2)}\n`,
    )

    await expect(verifyReleasePackage(release, identity)).resolves.toBeUndefined()

    await writeFile(join(release, 'src', 'example.ts'), 'export const value = 2\n')
    await expect(verifyReleasePackage(release, identity)).rejects.toThrow(
      'PACKAGE_CONTENT_MISMATCH:src/example.ts',
    )
  })
})

describe('release package source closure', () => {
  it('rejects an escaping tracked symlink before copying its target bytes', async () => {
    const source = await mkdtemp(join(tmpdir(), 'scrum4me-mcp-source-'))
    const release = await mkdtemp(join(tmpdir(), 'scrum4me-mcp-copy-'))
    const outside = join(tmpdir(), `scrum4me-mcp-outside-${process.pid}.txt`)
    releases.push(source, release)
    await mkdir(join(source, 'src'), { recursive: true })
    await writeFile(outside, 'outside bytes must not enter the package\n')
    await symlink(outside, join(source, 'src', 'escape.ts'))
    try {
      await execFileAsync('git', ['init'], { cwd: source })
      await execFileAsync('git', ['add', 'src/escape.ts'], { cwd: source })
      const copyTrackedFiles = (await releasePackageModule()).copyTrackedFiles
      if (!copyTrackedFiles) throw new Error('COPY_TRACKED_FILES_MISSING')
      await expect(
        copyTrackedFiles(source, release),
      ).rejects.toThrow('PACKAGE_SOURCE_NOT_REGULAR:src/escape.ts')
      await expect(readFile(join(release, 'src', 'escape.ts'))).rejects.toThrow()
    } finally {
      await rm(outside)
    }
  })
})

describe('release archive preflight', () => {
  it('accepts a strict ustar archive containing only regular files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scrum4me-mcp-tar-'))
    releases.push(root)
    const archive = join(root, 'valid.tar.gz')
    await writeFile(
      archive,
      makeTarGzip([{ name: 'src/example.ts', type: '0', contents: 'ok\n' }]),
    )
    const preflightReleaseArchive = (await releasePackageModule())
      .preflightReleaseArchive
    if (!preflightReleaseArchive) throw new Error('PREFLIGHT_RELEASE_ARCHIVE_MISSING')
    await expect(preflightReleaseArchive(archive)).resolves.toBeUndefined()
  })

  it('accepts GNU tar 1.35 empty device fields for non-device members', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scrum4me-mcp-tar-'))
    releases.push(root)
    const archive = join(root, 'gnu-1.35.tar.gz')
    await writeFile(
      archive,
      makeTarGzip(
        [{ name: 'src/example.ts', type: '0', contents: 'ok\n' }],
        (header) => {
          header.fill(0, 329, 345)
        },
      ),
    )
    const preflightReleaseArchive = (await releasePackageModule())
      .preflightReleaseArchive
    if (!preflightReleaseArchive) throw new Error('PREFLIGHT_RELEASE_ARCHIVE_MISSING')
    await expect(preflightReleaseArchive(archive)).resolves.toBeUndefined()
  })

  it.each([
    ['traversal', '../escape', '0', '', 'PACKAGE_ARCHIVE_MEMBER_PATH_INVALID'],
    ['symlink', 'src/link', '2', '../../outside', 'PACKAGE_ARCHIVE_MEMBER_TYPE_INVALID'],
    ['hardlink', 'src/hard', '1', 'src/target', 'PACKAGE_ARCHIVE_MEMBER_TYPE_INVALID'],
    ['special file', 'src/fifo', '6', '', 'PACKAGE_ARCHIVE_MEMBER_TYPE_INVALID'],
    ['unsupported extension', 'PaxHeader', 'x', '', 'PACKAGE_ARCHIVE_MEMBER_TYPE_INVALID'],
  ])(
    'rejects a %s archive before extraction',
    async (_label, name, type, linkName, expectedError) => {
      const root = await mkdtemp(join(tmpdir(), 'scrum4me-mcp-tar-'))
      releases.push(root)
      const archive = join(root, 'invalid.tar.gz')
      await writeFile(archive, makeTarGzip([{ name, type, linkName }]))
      const preflightReleaseArchive = (await releasePackageModule())
        .preflightReleaseArchive
      if (!preflightReleaseArchive) {
        throw new Error('PREFLIGHT_RELEASE_ARCHIVE_MISSING')
      }
      await expect(preflightReleaseArchive(archive)).rejects.toThrow(expectedError)
    },
  )

  it('rejects unsupported base-256 numeric encoding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scrum4me-mcp-tar-'))
    releases.push(root)
    const archive = join(root, 'base-256.tar.gz')
    await writeFile(
      archive,
      makeTarGzip(
        [{ name: 'src/example.ts', type: '0', contents: 'ok\n' }],
        (header) => {
          header[100] = 0x80
        },
      ),
    )
    const preflightReleaseArchive = (await releasePackageModule())
      .preflightReleaseArchive
    if (!preflightReleaseArchive) throw new Error('PREFLIGHT_RELEASE_ARCHIVE_MISSING')
    await expect(preflightReleaseArchive(archive)).rejects.toThrow(
      'PACKAGE_ARCHIVE_ENCODING_UNSUPPORTED',
    )
  })
})

describe('Forgejo release workflow contract', () => {
  it('uploads only exact head-bound candidate evidence with Forgejo artifact v3', async () => {
    const workflow = parse(
      await readFile(join(REPO_ROOT, '.forgejo', 'workflows', 'ci.yml'), 'utf8'),
    ) as {
      jobs: Record<string, {
        steps?: {
          name?: string
          uses?: string
          with?: Record<string, unknown>
        }[]
      }>
    }
    const upload = workflow.jobs.candidate.steps?.find((step) =>
      step.name?.includes('Upload candidate evidence'),
    )

    expect(upload?.uses).toBe(
      'actions/upload-artifact@ff15f0306b3f739f7b6fd43fb5d26cd321bd4de5',
    )
    expect(upload?.with?.name).toBe(
      'scrum4me-mcp-candidate-${{ github.event.pull_request.head.sha }}',
    )
    expect(upload?.with?.['if-no-files-found']).toBe('error')
    expect(upload?.with?.['include-hidden-files']).toBe(true)
    expect(
      String(upload?.with?.path ?? '')
        .trim()
        .split(/\s*\n\s*/),
    ).toEqual([
      '.release/scrum4me-mcp-candidate.v1.json',
      '.release/gates.json',
      '.release/tool-surface.json',
    ])
  })

  it.each(['candidate', 'final-release'])(
    '%s captures canary gate evidence as one JSON document',
    async (jobName) => {
      const workflow = parse(
        await readFile(join(REPO_ROOT, '.forgejo', 'workflows', 'ci.yml'), 'utf8'),
      ) as {
        jobs: Record<string, {
          steps?: { name?: string; run?: string }[]
        }>
      }
      const gateScript = workflow.jobs[jobName].steps?.find((step) =>
        step.name?.includes('gates and bind their evidence'),
      )?.run
      const captureCommand = gateScript
        ?.split('\n')
        .map((line) => line.trim())
        .find((line) => line.includes('canary:stdio > .release/tool-surface.json'))
      if (!captureCommand) throw new Error('CANARY_CAPTURE_COMMAND_MISSING')

      const release = await makePackagedRelease({ removeGit: true })
      const commit = 'a'.repeat(40)
      await writeFile(join(release, '.git'), 'gitdir: unavailable\n')
      await mkdir(join(release, '.release'), { recursive: true })
      await execFileAsync('/bin/bash', ['-c', captureCommand], {
        cwd: release,
        env: { ...process.env, SCRUM4ME_RELEASE_COMMIT: commit },
      })

      const evidence = await readFile(
        join(release, '.release', 'tool-surface.json'),
        'utf8',
      )
      expect(JSON.parse(evidence)).toMatchObject({
        version: 'scrum4me-mcp-canary/v1',
        release_commit: commit,
        ok: true,
      })
    },
  )

  it('binds merge parent 1 to the validated pre-push target SHA', async () => {
    const workflow = parse(
      await readFile(join(REPO_ROOT, '.forgejo', 'workflows', 'ci.yml'), 'utf8'),
    ) as {
      jobs: Record<string, {
        env?: Record<string, string>
        steps?: { name?: string; run?: string }[]
      }>
    }
    const finalRelease = workflow.jobs['final-release']
    expect(finalRelease.env?.PRE_PUSH_TARGET_SHA).toBe('${{ github.event.before }}')
    const proof = finalRelease.steps?.find((step) =>
      step.name?.includes('two-parent merge'),
    )?.run
    expect(proof).toContain('PRE_PUSH_TARGET_SHA')
    expect(proof).toContain('if [ "${parents[0]}" != "$PRE_PUSH_TARGET_SHA" ]; then')
    expect(proof).toContain('pre-push target')
    expect(proof).toContain("grep -Eq '^[0-9a-f]{40}$'")
    expect(proof).toContain('0000000000000000000000000000000000000000')
  })
})
