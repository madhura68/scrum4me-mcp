// Canary-mode primitives for the credentialless full-surface stdio canary.
//
// The release canary boots the *exact* stdio tool surface a runtime worker
// exposes — same names, same input schemas, same annotations — but forbids any
// handler from executing. That lets CI prove the published server advertises
// the surface it claims to, without a token, a database, presence, heartbeat,
// queue maintenance, Git or the network ever being touched.
//
// This module holds only the mode primitives (env parsing + the forbidden
// marker + the versioned result shape). The registration facade lives in
// register.ts and the server/lifecycle wiring in stdio-server.ts.

/** Which surface the stdio process serves. */
export type StdioMode = 'runtime' | 'canary'

/**
 * The only environment variable that switches the stdio process into canary
 * mode, and the only value that does so.
 */
export const CANARY_ENV_VAR = 'SCRUM4ME_CANARY_MODE'
export const CANARY_ENV_VALUE = '1'

/**
 * Message thrown by every tool handler while the server runs in canary mode.
 * The canary registers full tool metadata but replaces the callbacks, so any
 * `tools/call` fails with exactly this marker instead of doing work.
 */
export const CANARY_MODE_TOOL_CALL_FORBIDDEN = 'CANARY_MODE_TOOL_CALL_FORBIDDEN'

/**
 * Resolve the stdio mode from the environment.
 *
 * Only the exact string `"1"` enables canary mode. An unset or empty variable
 * is plain runtime. Any other non-empty value is a misconfiguration and is
 * fatal — we never silently downgrade an intended canary run to runtime (which
 * would boot presence + auth) or vice versa.
 */
export function stdioMode(env: NodeJS.ProcessEnv = process.env): StdioMode {
  const raw = env[CANARY_ENV_VAR]
  if (raw === undefined || raw === '') return 'runtime'
  if (raw === CANARY_ENV_VALUE) return 'canary'
  throw new Error(
    `INVALID_CANARY_MODE: ${CANARY_ENV_VAR} must be unset or exactly "${CANARY_ENV_VALUE}", got "${raw}"`,
  )
}

/**
 * Versioned result the `canary:stdio` script prints — the machine-checkable
 * attestation that the credentialless surface initialized and listed cleanly.
 */
export interface StdioCanaryResultV1 {
  version: 'scrum4me-mcp-canary/v1'
  server_name: 'scrum4me-mcp'
  server_version: string
  release_commit: string
  protocol_version: string
  tool_count: number
  tool_surface_sha256: string
  ok: true
}
