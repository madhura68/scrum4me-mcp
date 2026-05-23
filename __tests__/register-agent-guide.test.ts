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
  it('is registered in the shared toolset (served over HTTP + stdio)', () => {
    const { server, names } = captureNames()
    registerSharedTools(server as never)
    expect(names).toContain('get_agent_guide')
  })

  it('is NOT in the worktree-only toolset', () => {
    const { server, names } = captureNames()
    registerWorktreeTools(server as never)
    expect(names).not.toContain('get_agent_guide')
  })
})
