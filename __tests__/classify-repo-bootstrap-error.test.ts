import { describe, it, expect } from 'vitest'
import { classifyRepoBootstrapError } from '../src/git/on-demand-clone.js'

// Helper to build an exec-style error (execFile rejects with an Error that
// carries stderr/stdout), so the classifier must look past err.message.
function execError(stderr: string, message = 'Command failed'): Error {
  const e = new Error(message) as Error & { stderr?: string }
  e.stderr = stderr
  return e
}

describe('classifyRepoBootstrapError', () => {
  describe('terminal — deterministic, retry will not help', () => {
    const terminalClone: Array<[string, string]> = [
      ['repo 404', "fatal: repository 'https://git.jp-visser.nl/janpeter/nope.git/' not found"],
      ['forgejo 404', 'remote: Repository not found'],
      ['auth failed', "fatal: Authentication failed for 'https://git.jp-visser.nl/janpeter/x.git/'"],
      ['access denied', 'remote: HTTP Basic: Access denied'],
      ['not a git repo', "'https://example.com/x' does not appear to be a git repository"],
      ['unsupported protocol', "fatal: protocol 'ftp' is not supported"],
    ]
    it.each(terminalClone)('clone/%s -> terminal', (_label, stderr) => {
      expect(classifyRepoBootstrapError('clone', execError(stderr))).toBe('terminal')
    })

    const terminalReset: Array<[string, string]> = [
      ['missing ref', "fatal: couldn't find remote ref refs/heads/does-not-exist"],
      ['missing branch', 'fatal: Remote branch nope not found in upstream origin'],
    ]
    it.each(terminalReset)('reset/%s -> terminal', (_label, stderr) => {
      expect(classifyRepoBootstrapError('reset', execError(stderr))).toBe('terminal')
    })

    const terminalInstall: Array<[string, string]> = [
      ['ERESOLVE', 'npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree'],
      [
        'lockfile out of sync',
        'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync',
      ],
      ['missing from lockfile', 'npm error Missing: left-pad@1.3.0 from lock file'],
    ]
    it.each(terminalInstall)('install/%s -> terminal', (_label, stderr) => {
      expect(classifyRepoBootstrapError('install', execError(stderr))).toBe('terminal')
    })
  })

  describe('transient — recoverable, requeue', () => {
    const transientGit: Array<[string, string]> = [
      ['dns', 'fatal: unable to access ...: Could not resolve host: git.jp-visser.nl'],
      ['5xx', 'fatal: unable to access ...: The requested URL returned error: 503'],
      ['rpc failed', 'error: RPC failed; curl 18 transfer closed with outstanding read data'],
      ['early eof', 'fatal: early EOF'],
      ['conn reset', 'fatal: unable to access ...: Connection reset by peer'],
      ['index lock', "fatal: Unable to create '/x/.git/index.lock': File exists"],
    ]
    it.each(transientGit)('clone/%s -> transient', (_label, stderr) => {
      expect(classifyRepoBootstrapError('clone', execError(stderr))).toBe('transient')
    })

    const transientInstall: Array<[string, string]> = [
      ['ETIMEDOUT', 'npm error network request to https://registry.npmjs.org/x failed, reason: connect ETIMEDOUT'],
      ['ECONNRESET', 'npm error code ECONNRESET'],
      ['429', 'npm warn registry Unexpected 429 Too Many Requests'],
      ['registry 503', 'npm error 503 Service Unavailable - GET https://registry.npmjs.org/x'],
    ]
    it.each(transientInstall)('install/%s -> transient', (_label, stderr) => {
      expect(classifyRepoBootstrapError('install', execError(stderr))).toBe('transient')
    })
  })

  it('unknown error defaults to transient (a needless retry beats a false terminal)', () => {
    expect(classifyRepoBootstrapError('clone', execError('some totally unexpected gibberish'))).toBe(
      'transient',
    )
    expect(classifyRepoBootstrapError('install', new Error('kaboom'))).toBe('transient')
  })

  it('a repo-not-found that also mentions host resolution is still classified from the transient signal first', () => {
    // network wins: do not terminally fail an outage that merely echoes "not found"
    expect(
      classifyRepoBootstrapError('clone', execError('Could not resolve host; repository not found later in log')),
    ).toBe('transient')
  })
})
