import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const argsSchema = {
  product_id: z.string().min(1).describe('Scrum4Me product id (use list_products to find one)'),
}

const PROMPT_BODY = (productId: string) => `
You are helping a developer execute the next story in a Scrum4Me product.

Workflow:

1. Call \`get_claude_context\` with product_id="${productId}".
   - Read the active sprint, the next story (acceptance_criteria included)
   and the open todos for context.

2. If next_story is null, stop and tell the user there is nothing in flight.

3. Plan the implementation against the story's acceptance_criteria.
   Consider task ordering and the product's definition_of_done.

4. Call \`log_implementation\` with story_id and a concise plan
   (markdown). Include metadata like { "branch": "feat/<slug>" }.

5. For each task in the returned tasks array (already in sort_order):
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
