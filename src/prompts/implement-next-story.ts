import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const argsSchema = {
  product_id: z.string().min(1).describe('Scrum4Me product id (use list_products to find one)'),
}

const PROMPT_BODY = (productId: string) => `
You are helping a developer execute the next story in a Scrum4Me product.

Workflow:

1. Call \`get_context\` with product_id="${productId}".
   - Read the product, all active_sprints and agent_guide. If known, pass your
     agent.runtime (CLAUDE or CODEX) and exact agent.model_id; never guess them.
     Reuse that identity for any later \`get_agent_guide\` call.

2. Select the sprint within the user's current assignment and call
   \`get_sprint_context\` with its sprint_id. If the assignment does not identify
   a sprint and several are possible, clarify the selection first.
   Select the story covered by the assignment from the compact overview;
   preserve its returned task order. No eligible story means stop and report it.
   Other stories and sprints are context, not permission to execute them.
   Request \`get_ideas_context\` only if the assignment concerns ideas.

3. For the first selected task, call \`get_sprint_context\` again with sprint_id
   and task_id. Read selected_task.implementation_plan and the accompanying
   story acceptance_criteria before planning. Consider the product's definition_of_done.

4. Call \`log_implementation\` with story_id and a concise plan
   (markdown). Include metadata like { "branch": "feat/<slug>" }.

5. For each task in the selected story's returned tasks array (already in sort_order):
   - Fetch that task's full plan with \`get_sprint_context\` (sprint_id, task_id).
   a. Call \`update_task_status\` with status="in_progress"
   b. Implement the task — write/modify files, run scripts as needed
   c. Call \`update_task_status\` with status="done"
   d. If you discovered something worth recording, call
      \`update_task_plan\` with the implementation_plan markdown

6. Run the relevant tests for the changes.
   - Call \`log_test_result\` with status="PASSED" or "FAILED" and a short
     summary in content.

7. Make the git commit referencing the story code.
   - Call \`log_commit\` with commit_hash, commit_message and
     metadata: { "branch": "<branch>" }.

Rules:
- Always finish each task by setting it to "done" before starting the
  next one. Do not parallelise within a story.
- If a task blocks on missing info, set it back to "todo" and stop.
- Use lowercase status values (todo, in_progress, review, done).
`.trim()

export function registerImplementNextStoryPrompt(server: McpServer) {
  server.registerPrompt(
    'implement_next_story',
    {
      title: 'Implement the next Scrum4Me story',
      description:
        'End-to-end workflow: fetch context, log a plan, walk the tasks, run tests, commit.',
      argsSchema,
    },
    async ({ product_id }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: PROMPT_BODY(product_id) },
        },
      ],
    }),
  )
}
