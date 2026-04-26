import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  title: z.string().min(1),
  description: z.string().max(2000).optional(),
  product_id: z.string().min(1).optional(),
})

export function registerCreateTodoTool(server: McpServer) {
  server.registerTool(
    'create_todo',
    {
      title: 'Create todo',
      description:
        'Add a todo for the authenticated user, optionally scoped to a product. ' +
        'Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ title, description, product_id }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (product_id && !(await userCanAccessProduct(product_id, auth.userId))) {
          return toolError(`Product ${product_id} not found or not accessible`)
        }
        const todo = await prisma.todo.create({
          data: {
            user_id: auth.userId,
            product_id: product_id ?? null,
            title,
            description: description ?? null,
          },
          select: { id: true, title: true, description: true, created_at: true },
        })
        return toolJson(todo)
      }),
  )
}
