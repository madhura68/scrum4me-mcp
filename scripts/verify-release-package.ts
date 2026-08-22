import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { runStdioCanary } from './stdio-canary.js'

const execFileAsync = promisify(execFile)
const REPOSITORY = 'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git'
const PACKAGE_IDENTITY_VERSION = 'scrum4me-mcp-package-identity/v1'
const CONTENT_MANIFEST_VERSION = 'scrum4me-mcp-content-manifest/v1'
const IDENTITY_PATH = 'release/package-identity.v1.json'
const MANIFEST_PATH = 'release/content-manifest.v1.json'
const GIT_OID_HEX = /^[0-9a-f]{40}$/
const SHA256_HEX = /^[0-9a-f]{64}$/

export interface PackagedReleaseIdentityV1 {
  version: 'scrum4me-mcp-package-identity/v1'
  repository: 'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git'
  commit: string
  tree_oid: string
  tool_surface_sha256: string
  content_manifest_sha256: string
}

interface ManifestFile {
  path: string
  bytes: number
  sha256: string
}

interface ContentManifestV1 {
  version: 'scrum4me-mcp-content-manifest/v1'
  repository: typeof REPOSITORY
  package_identity: Omit<PackagedReleaseIdentityV1, 'content_manifest_sha256'>
  files: ManifestFile[]
}

function sha256(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function identityBase(
  identity: PackagedReleaseIdentityV1,
): Omit<PackagedReleaseIdentityV1, 'content_manifest_sha256'> {
  const { content_manifest_sha256: _manifestDigest, ...base } = identity
  return base
}

function assertIdentity(identity: unknown): asserts identity is PackagedReleaseIdentityV1 {
  if (
    identity === null ||
    typeof identity !== 'object' ||
    (identity as Record<string, unknown>).version !== PACKAGE_IDENTITY_VERSION ||
    (identity as Record<string, unknown>).repository !== REPOSITORY ||
    !GIT_OID_HEX.test(String((identity as Record<string, unknown>).commit ?? '')) ||
    !GIT_OID_HEX.test(String((identity as Record<string, unknown>).tree_oid ?? '')) ||
    !SHA256_HEX.test(
      String((identity as Record<string, unknown>).tool_surface_sha256 ?? ''),
    ) ||
    !SHA256_HEX.test(
      String((identity as Record<string, unknown>).content_manifest_sha256 ?? ''),
    )
  ) {
    throw new Error('PACKAGED_RELEASE_IDENTITY_INVALID')
  }
}

function safeReleasePath(releaseRoot: string, manifestPath: string): string {
  if (
    manifestPath === '' ||
    manifestPath.startsWith('/') ||
    manifestPath.split('/').includes('..') ||
    manifestPath.includes('\\')
  ) {
    throw new Error(`PACKAGE_MANIFEST_PATH_INVALID:${manifestPath}`)
  }
  const absolute = resolve(releaseRoot, manifestPath)
  const prefix = `${resolve(releaseRoot)}${sep}`
  if (!absolute.startsWith(prefix)) {
    throw new Error(`PACKAGE_MANIFEST_PATH_INVALID:${manifestPath}`)
  }
  return absolute
}

async function listRegularFiles(root: string, current = root): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) {
      paths.push(...(await listRegularFiles(root, absolute)))
    } else if (entry.isFile()) {
      paths.push(relative(root, absolute).split(sep).join('/'))
    } else {
      throw new Error(`PACKAGE_NON_REGULAR_FILE:${relative(root, absolute)}`)
    }
  }
  return paths.sort()
}

export async function verifyReleasePackage(
  releaseRoot: string,
  identity: PackagedReleaseIdentityV1,
): Promise<void> {
  assertIdentity(identity)
  let packagedIdentity: unknown
  let manifestBytes: Buffer
  let manifest: ContentManifestV1
  try {
    packagedIdentity = JSON.parse(
      await readFile(join(releaseRoot, IDENTITY_PATH), 'utf8'),
    ) as unknown
    manifestBytes = await readFile(join(releaseRoot, MANIFEST_PATH))
    manifest = JSON.parse(manifestBytes.toString('utf8')) as ContentManifestV1
  } catch {
    throw new Error('PACKAGE_ATTESTATION_MISSING_OR_MALFORMED')
  }
  assertIdentity(packagedIdentity)
  if (JSON.stringify(packagedIdentity) !== JSON.stringify(identity)) {
    throw new Error('PACKAGED_RELEASE_IDENTITY_MISMATCH')
  }
  if (sha256(manifestBytes) !== identity.content_manifest_sha256) {
    throw new Error('PACKAGE_CONTENT_MANIFEST_HASH_MISMATCH')
  }
  if (
    manifest.version !== CONTENT_MANIFEST_VERSION ||
    manifest.repository !== REPOSITORY ||
    JSON.stringify(manifest.package_identity) !== JSON.stringify(identityBase(identity)) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('PACKAGE_CONTENT_MANIFEST_INVALID')
  }

  const declaredPaths = manifest.files.map((file) => file.path)
  if (
    new Set(declaredPaths).size !== declaredPaths.length ||
    JSON.stringify(declaredPaths) !== JSON.stringify([...declaredPaths].sort())
  ) {
    throw new Error('PACKAGE_CONTENT_MANIFEST_INVALID')
  }
  const actualPaths = (await listRegularFiles(releaseRoot)).filter(
    (path) => path !== IDENTITY_PATH && path !== MANIFEST_PATH,
  )
  if (JSON.stringify(actualPaths) !== JSON.stringify(declaredPaths)) {
    throw new Error('PACKAGE_CONTENT_SET_MISMATCH')
  }

  for (const file of manifest.files) {
    if (
      typeof file.bytes !== 'number' ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !SHA256_HEX.test(file.sha256)
    ) {
      throw new Error('PACKAGE_CONTENT_MANIFEST_INVALID')
    }
    const contents = await readFile(safeReleasePath(releaseRoot, file.path))
    if (contents.byteLength !== file.bytes || sha256(contents) !== file.sha256) {
      throw new Error(`PACKAGE_CONTENT_MISMATCH:${file.path}`)
    }
  }
}

async function copyTrackedFiles(repoRoot: string, releaseRoot: string): Promise<void> {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--recurse-submodules', '-z'],
    { cwd: repoRoot, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  )
  const paths = Buffer.from(stdout)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  for (const path of paths) {
    const source = safeReleasePath(repoRoot, path)
    const destination = safeReleasePath(releaseRoot, path)
    const sourceStat = await lstat(source)
    if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
      throw new Error(`PACKAGE_SOURCE_NOT_FILE:${path}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }
}

async function createReleasePackage(repoRoot: string): Promise<string> {
  const head = (
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
  ).stdout.trim()
  const commit = process.env.SCRUM4ME_RELEASE_COMMIT?.trim() || head
  if (commit !== head || !GIT_OID_HEX.test(commit)) {
    throw new Error('PACKAGE_COMMIT_NOT_HEAD')
  }
  const treeOid = (
    await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot })
  ).stdout.trim()
  if (!GIT_OID_HEX.test(treeOid)) throw new Error('PACKAGE_TREE_MALFORMED')

  const releaseOutput = join(repoRoot, '.release')
  const releaseRoot = join(releaseOutput, 'package')
  const artifactDir = join(releaseOutput, 'artifacts')
  await rm(releaseRoot, { recursive: true, force: true })
  await rm(artifactDir, { recursive: true, force: true })
  await mkdir(releaseRoot, { recursive: true })
  await mkdir(artifactDir, { recursive: true })

  const canary = await runStdioCanary({ SCRUM4ME_RELEASE_COMMIT: commit })
  await writeFile(
    join(releaseOutput, 'tool-surface.json'),
    `${JSON.stringify(canary)}\n`,
  )
  await copyTrackedFiles(repoRoot, releaseRoot)

  const files: ManifestFile[] = []
  for (const path of await listRegularFiles(releaseRoot)) {
    const contents = await readFile(safeReleasePath(releaseRoot, path))
    files.push({ path, bytes: contents.byteLength, sha256: sha256(contents) })
  }
  const base = {
    version: PACKAGE_IDENTITY_VERSION,
    repository: REPOSITORY,
    commit,
    tree_oid: treeOid,
    tool_surface_sha256: canary.tool_surface_sha256,
  } as const
  const manifest: ContentManifestV1 = {
    version: CONTENT_MANIFEST_VERSION,
    repository: REPOSITORY,
    package_identity: base,
    files,
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const identity: PackagedReleaseIdentityV1 = {
    ...base,
    content_manifest_sha256: sha256(manifestBytes),
  }
  await mkdir(join(releaseRoot, 'release'), { recursive: true })
  await writeFile(join(releaseRoot, MANIFEST_PATH), manifestBytes)
  await writeFile(
    join(releaseRoot, IDENTITY_PATH),
    `${JSON.stringify(identity, null, 2)}\n`,
  )
  await verifyReleasePackage(releaseRoot, identity)

  const artifact = join(artifactDir, `scrum4me-mcp-${commit}.tar.gz`)
  const tarArgs =
    process.platform === 'linux'
      ? [
          '--sort=name',
          '--mtime=@0',
          '--owner=0',
          '--group=0',
          '--numeric-owner',
          '-czf',
          artifact,
          '-C',
          releaseRoot,
          '.',
        ]
      : ['-czf', artifact, '-C', releaseRoot, '.']
  await execFileAsync('tar', tarArgs, { cwd: repoRoot })
  return artifact
}

async function verifyReleaseArchive(
  repoRoot: string,
  releaseRoot: string,
): Promise<PackagedReleaseIdentityV1> {
  const identity = JSON.parse(
    await readFile(join(releaseRoot, IDENTITY_PATH), 'utf8'),
  ) as PackagedReleaseIdentityV1
  assertIdentity(identity)
  const artifact = join(
    repoRoot,
    '.release',
    'artifacts',
    `scrum4me-mcp-${identity.commit}.tar.gz`,
  )
  const extractedRoot = join(repoRoot, '.release', 'verified-package')
  await rm(extractedRoot, { recursive: true, force: true })
  await mkdir(extractedRoot, { recursive: true })
  await execFileAsync('tar', ['-xzf', artifact, '-C', extractedRoot], {
    cwd: repoRoot,
  })
  await verifyReleasePackage(extractedRoot, identity)
  return identity
}

function isMainModule(): boolean {
  return (
    Boolean(process.argv[1]) &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  )
}

if (isMainModule()) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const argv = process.argv.slice(2)
  const operation = argv[0]
  const action =
    operation === '--package'
      ? createReleasePackage(repoRoot).then((artifact) => {
          process.stdout.write(`${relative(repoRoot, artifact)}\n`)
        })
      : operation === '--verify'
        ? (async () => {
            const releaseRoot = resolve(repoRoot, argv[1] ?? '.release/package')
            const identity = await verifyReleaseArchive(repoRoot, releaseRoot)
            process.stdout.write(`${identity.commit}\n`)
          })()
        : Promise.reject(new Error('USAGE: --package | --verify <release-root>'))
  action.catch((err) => {
    console.error(
      'release package failed:',
      err instanceof Error ? err.message : String(err),
    )
    process.exit(1)
  })
}
