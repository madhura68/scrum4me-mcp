import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({ prisma: {} }))

import { registerSharedTools, registerWorktreeTools } from '../src/register.js'

function captureNames() {
  const names: string[] = []
  const server = {
    registerTool: (n: string) => {
      names.push(n)
    },
    registerPrompt: () => {},
  }
  return { server, names }
}

describe('get_agent_guide registration', () => {
  it.each(['get_agent_guide', 'get_context', 'get_sprint_context', 'get_ideas_context'])('%s is registered in the shared toolset (HTTP + stdio)', (name) => {
    const { server, names } = captureNames()
    registerSharedTools(server as never)
    expect(names).toContain(name)
  })

  it.each(['get_agent_guide', 'get_context', 'get_sprint_context', 'get_ideas_context'])('%s is NOT in the worktree-only toolset', (name) => {
    const { server, names } = captureNames()
    registerWorktreeTools(server as never)
    expect(names).not.toContain(name)
  })
})
