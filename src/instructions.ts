// Shared bootstrap for stdio and HTTP. The binding guide is returned by
// get_context / get_agent_guide; keep model-policy content out of this pointer.
export const INSTRUCTIONS =
  'Scrum4Me dev-flow tools: read product/sprint/story context, update tasks, log activity. ' +
  'Interactive main sessions: start with get_context({ product_id, agent }) and repeat it after compaction before resuming the same assignment. ' +
  'Include known agent.runtime (CLAUDE or CODEX), even when model_id is unknown. Include only an exact known agent.model_id; otherwise omit that field. Omit agent if runtime is unknown. Never guess identity: model_id selects a guide profile, not a model switch. ' +
  'Read agent_guide, check agent_context.applied_profiles and follow the guide for task distribution, subagent model selection and verification within the assignment and job limits. Keep the user-selected main model unchanged; a different guide recommendation is not an error. ' +
  'Only when the guide is missing or empty, call get_agent_guide once with the same product and agent input and read guide_md. An available guide needs no second call; a missing profile alone does not trigger one. If the guide stays unavailable, report it under the existing missing-context rules without a retry loop. ' +
  'Give subagents relevant guide and task context; they do not automatically repeat the main-session startup. ' +
  'Worker jobs: read the kind prompt and payload first and use an already supplied applicable guide. Fetch only a missing guide with the job product and known agent identity. Keep the runner-selected main model and job scope. After compaction restore the same job context and fetch only missing guide content, without a new claim. ' +
  'get_context returns the product and every OPEN sprint. Choose a sprint within the current assignment, then use get_sprint_context for compact stories/tasks; request one full task plan in a separate call with task_id. ' +
  'Use get_ideas_context only when ideas are relevant. Context does not authorize or start other work. ' +
  'Use search_product_docs before implementing, reviewing, grilling, or chatting about architecture, patterns, auth, status mapping, demo policy, job flow, sprint flow, MD3/styling or UI dialogs. Use Read/Grep on docs/ only as fallback when MCP tools return no useful result or a multi-file scan is required. ' +
  'Use related_product_docs to follow cross-references. Use get_product_doc with the heading parameter to focus on one section instead of loading the full doc.'
