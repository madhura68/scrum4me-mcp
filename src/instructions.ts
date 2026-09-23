// Single source for the MCP server `instructions` string, injected at the
// initialize handshake by clients that honour it (e.g. Claude Code). Used by
// both transports (index.ts = stdio, http.ts = HTTP). Keep this a bootstrap
// pointer — the binding content lives in get_agent_guide, not here.
export const INSTRUCTIONS =
  'Scrum4Me dev-flow tools: read product/sprint/story context, update tasks, log activity. ' +
  'Always start with get_context for the product, every OPEN sprint and the applicable agent guide. ' +
  'Choose a sprint within the current assignment, then use get_sprint_context for its compact stories/tasks; ' +
  'request one full task plan in a separate get_sprint_context call with task_id. ' +
  'Use get_ideas_context only when ideas are relevant. Context does not authorize or start other work. ' +
  'Use search_product_docs before implementing, reviewing, grilling, or chatting ' +
  'about work that touches architecture, patterns, auth, status mapping, demo policy, ' +
  'job flow, sprint flow, MD3/styling, or UI dialogs. Use Read/Grep on docs/ only as ' +
  'fallback when MCP tools return no useful result or a multi-file scan is required. ' +
  'Use related_product_docs to follow cross-references between docs. Use get_product_doc ' +
  'with `heading` parameter to focus on a section instead of loading the full doc. ' +
  'Call get_agent_guide(product_id) and follow guide_md before building or documenting. ' +
  'When known, pass the same agent.runtime (CLAUDE or CODEX) and exact agent.model_id to get_context ' +
  'and get_agent_guide for targeted instructions; never guess the identity.'
