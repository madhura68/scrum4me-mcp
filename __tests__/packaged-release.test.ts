import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  cp,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  verifyReleasePackage,
  type PackagedReleaseIdentityV1,
} from '../scripts/verify-release-package.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const releases: string[] = []
const sha256 = (contents: string | Buffer): string =>
  createHash('sha256').update(contents).digest('hex')

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
    await mkdir(join(release, 'release'), { recursive: true })
    await writeFile(
      join(release, 'release', 'package-identity.v1.json'),
      `${JSON.stringify({
        version: 'scrum4me-mcp-package-identity/v1',
        repository: 'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git',
        commit,
        tree_oid: 'b'.repeat(40),
        tool_surface_sha256: 'c'.repeat(64),
        content_manifest_sha256: 'd'.repeat(64),
      })}\n`,
    )

    const result = (await runPackagedCanary(release, {
      SCRUM4ME_RELEASE_COMMIT: undefined,
    })) as { release_commit: string }

    expect(result.release_commit).toBe(commit)
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
