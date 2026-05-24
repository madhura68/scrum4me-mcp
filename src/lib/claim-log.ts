// Structured claim/worktree diagnostics. MUST write to stderr: in stdio MCP mode
// stdout is the JSON-RPC channel, so any stray stdout write corrupts the protocol.
export function claimLog(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.error(JSON.stringify({ scope: 'claim', event, ...fields }))
  } catch {
    console.error(`[claim] ${event}`)
  }
}
