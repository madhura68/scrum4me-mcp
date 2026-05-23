// Single source for the MCP server `instructions` string, injected at the
// initialize handshake by clients that honour it (e.g. Claude Code). Used by
// both transports (index.ts = stdio, http.ts = HTTP). Keep this a bootstrap
// pointer — the binding content lives in get_agent_guide, not here.
export const INSTRUCTIONS =
  'Scrum4Me dev-flow tools: read product/sprint/story context, update tasks, log activity. ' +
  'Always call get_claude_context before starting work to fetch the next story. ' +
  'Use search_product_docs before implementing, reviewing, grilling, or chatting ' +
  'about work that touches architecture, patterns, auth, status mapping, demo policy, ' +
  'job flow, sprint flow, MD3/styling, or UI dialogs. Use Read/Grep on docs/ only as ' +
  'fallback when MCP tools return no useful result or a multi-file scan is required. ' +
  'Use related_product_docs to follow cross-references between docs. Use get_product_doc ' +
  'with `heading` parameter to focus on a section instead of loading the full doc. ' +
  'Call get_agent_guide(product_id) and follow guide_md before building or documenting.'
