# Agent-guide Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a customizable, per-product "build & document" guide (a CLAUDE.md-equivalent) delivered worker-agnostically through a new `get_agent_guide` MCP tool, with a global TS-module default plus an optional per-product ProductDoc override.

**Architecture:** A global default lives as a compiled TypeScript string (`AGENT_GUIDE_DEFAULT`). A shared resolver merges it (layered-append) with an optional per-product `ProductDoc(folder=MANUAL, slug=agent-guide, status=active)` override, enforcing a size cap. The merged guide is exposed via a new shared MCP tool `get_agent_guide`, surfaced as an `agent_guide` field on `get_claude_context`, pointed to by the server `instructions` string, and made callable by autonomous workers via the `TASK_TOOLS` allowlist + a one-line rule in the task/sprint kind-prompts.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/sdk`, Prisma (`@prisma/client`), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-23-agent-guide-prompt-design.md` (v0.2)

---

## File Structure

**New files**
- `src/lib/agent-guide-default.ts` — exports `AGENT_GUIDE_DEFAULT` (the global default string).
- `src/lib/agent-guide.ts` — exports `resolveAgentGuide`, `AGENT_GUIDE_MAX_CHARS`, `AgentGuideTooLargeError`, and types. Owns lookup + merge + size-gate.
- `src/tools/get-agent-guide.ts` — registers the `get_agent_guide` MCP tool (access check + resolver call).
- `src/instructions.ts` — single shared `INSTRUCTIONS` string for both transports.
- `__tests__/lib/agent-guide.test.ts`, `__tests__/tools/get-agent-guide.test.ts`,
  `__tests__/tools/get-claude-context-agent-guide.test.ts`, `__tests__/instructions.test.ts`,
  `__tests__/register-agent-guide.test.ts`.

**Modified files**
- `src/tools/get-claude-context.ts` — add `enabled_doc_folders` to product select; add `agent_guide` (+ graceful `agent_guide_error`) fields.
- `src/lib/job-config.ts` — add the tool to `TASK_TOOLS`.
- `src/register.ts` — register `get_agent_guide` in `registerSharedTools()`.
- `src/http.ts`, `src/index.ts` — import shared `INSTRUCTIONS`.
- `src/prompts/task/implementation.md`, `src/prompts/sprint/implementation.md` — one workflow rule.
- `__tests__/job-config.test.ts`, `__tests__/kind-prompts.test.ts`, `__tests__/get-claude-context-filter.test.ts` — extend.

---

## Task 1: Global default guide (TS module)

**Files:**
- Create: `src/lib/agent-guide-default.ts`
- Test: `__tests__/lib/agent-guide-default.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/agent-guide-default.test.ts
import { describe, it, expect } from 'vitest'
import { AGENT_GUIDE_DEFAULT } from '../../src/lib/agent-guide-default.js'

describe('AGENT_GUIDE_DEFAULT', () => {
  it('is non-empty', () => {
    expect(AGENT_GUIDE_DEFAULT.length).toBeGreaterThan(0)
  })

  it('is model-agnostic (no brand coupling)', () => {
    expect(AGENT_GUIDE_DEFAULT.toLowerCase()).not.toContain('claude')
  })

  it('references the MCP logging tools and worktree discipline', () => {
    expect(AGENT_GUIDE_DEFAULT).toContain('log_implementation')
    expect(AGENT_GUIDE_DEFAULT).toContain('worktree')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/lib/agent-guide-default.test.ts`
Expected: FAIL — cannot find module `../../src/lib/agent-guide-default.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/agent-guide-default.ts
// Global default "build & document" guide. Embedded as a TS string (not a
// runtime .md read): tsc does not copy .md into dist, and the MCP server may
// run from dist/ — a TS module compiles normally and works from src/ and dist/.
// Keep model-agnostic: reference MCP tools and the git/PR flow, not any vendor.
export const AGENT_GUIDE_DEFAULT = `# Build & document guide

This guide is binding. Follow it together with the task's own implementation plan.

## Building
- Work only in the assigned worktree path from the job payload; never edit other directories.
- Make small, logical commits: read -> change -> test -> commit per layer.
- Prefer reusing existing utilities and patterns over adding new ones (DRY, YAGNI).
- Run the test suite and the type checker before marking work done.

## Documenting
- Log each implementation step with log_implementation (what changed and why).
- Log every commit with log_commit (commit hash + message).
- Log test runs with log_test_result (PASSED/FAILED + a short explanation).
- When you introduce architecture, patterns, or decisions worth keeping, capture them
  with create_product_doc in the appropriate folder.

## Verifying
- Run the verify gate before done (verify_task_against_plan or verify_sprint_task).
- Open a PR through the configured automation; do not push to the main branch directly.
`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/lib/agent-guide-default.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-guide-default.ts __tests__/lib/agent-guide-default.test.ts
git commit -m "feat(agent-guide): add global default build/document guide"
```

---

## Task 2: Resolver (`resolveAgentGuide`)

**Files:**
- Create: `src/lib/agent-guide.ts`
- Test: `__tests__/lib/agent-guide.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/agent-guide.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProductDocFolder } from '@prisma/client'

const { mockProductDocFindFirst } = vi.hoisted(() => ({
  mockProductDocFindFirst: vi.fn(),
}))

vi.mock('../../src/prisma.js', () => ({
  prisma: { productDoc: { findFirst: mockProductDocFindFirst } },
}))

import {
  resolveAgentGuide,
  AGENT_GUIDE_MAX_CHARS,
  AgentGuideTooLargeError,
} from '../../src/lib/agent-guide.js'
import { AGENT_GUIDE_DEFAULT } from '../../src/lib/agent-guide-default.js'

const productWithManual = {
  id: 'p1',
  code: 'P1',
  name: 'Test product',
  enabled_doc_folders: [ProductDocFolder.MANUAL],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProductDocFindFirst.mockResolvedValue(null)
})

describe('resolveAgentGuide', () => {
  it('returns only the global default when there is no override', async () => {
    const result = await resolveAgentGuide(productWithManual)
    expect(result.guide_md).toBe(AGENT_GUIDE_DEFAULT)
    expect(result.has_product_override).toBe(false)
    expect(result.product_doc).toBeNull()
  })

  it('queries only active MANUAL/agent-guide docs', async () => {
    await resolveAgentGuide(productWithManual)
    expect(mockProductDocFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          product_id: 'p1',
          folder: ProductDocFolder.MANUAL,
          slug: 'agent-guide',
          status: 'active',
        },
      }),
    )
  })

  it('skips the override query when MANUAL folder is disabled', async () => {
    await resolveAgentGuide({ ...productWithManual, enabled_doc_folders: [] })
    expect(mockProductDocFindFirst).not.toHaveBeenCalled()
  })

  it('appends an active override as a labeled section', async () => {
    mockProductDocFindFirst.mockResolvedValue({
      slug: 'agent-guide',
      status: 'active',
      content_md: 'Always run the linter.',
      updated_at: new Date('2026-05-23T00:00:00Z'),
    })
    const result = await resolveAgentGuide(productWithManual)
    expect(result.guide_md.startsWith(AGENT_GUIDE_DEFAULT)).toBe(true)
    expect(result.guide_md).toContain('## Product-specifieke aanvullingen — P1')
    expect(result.guide_md).toContain('Always run the linter.')
    expect(result.has_product_override).toBe(true)
    expect(result.product_doc).toEqual({
      slug: 'agent-guide',
      status: 'active',
      updated_at: new Date('2026-05-23T00:00:00Z'),
    })
  })

  it('throws AgentGuideTooLargeError when the merged guide exceeds the cap', async () => {
    mockProductDocFindFirst.mockResolvedValue({
      slug: 'agent-guide',
      status: 'active',
      content_md: 'x'.repeat(AGENT_GUIDE_MAX_CHARS + 1),
      updated_at: new Date(),
    })
    await expect(resolveAgentGuide(productWithManual)).rejects.toBeInstanceOf(
      AgentGuideTooLargeError,
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/lib/agent-guide.test.ts`
Expected: FAIL — cannot find module `../../src/lib/agent-guide.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/agent-guide.ts
import { ProductDocFolder } from '@prisma/client'
import { prisma } from '../prisma.js'
import { AGENT_GUIDE_DEFAULT } from './agent-guide-default.js'

export const AGENT_GUIDE_MAX_CHARS = 16_000

export class AgentGuideTooLargeError extends Error {
  constructor(public readonly chars: number) {
    super(
      `AGENT_GUIDE_TOO_LARGE: merged guide is ${chars} chars (max ${AGENT_GUIDE_MAX_CHARS})`,
    )
    this.name = 'AgentGuideTooLargeError'
  }
}

export type AgentGuideProduct = {
  id: string
  code: string | null
  name: string
  enabled_doc_folders: ProductDocFolder[]
}

export type AgentGuideResult = {
  guide_md: string
  has_product_override: boolean
  product_doc: { slug: string; status: string; updated_at: Date } | null
}

export async function resolveAgentGuide(
  product: AgentGuideProduct,
): Promise<AgentGuideResult> {
  let override:
    | { slug: string; status: string; content_md: string; updated_at: Date }
    | null = null

  if (product.enabled_doc_folders.includes(ProductDocFolder.MANUAL)) {
    override = await prisma.productDoc.findFirst({
      where: {
        product_id: product.id,
        folder: ProductDocFolder.MANUAL,
        slug: 'agent-guide',
        status: 'active',
      },
      select: { slug: true, status: true, content_md: true, updated_at: true },
    })
  }

  let guide_md = AGENT_GUIDE_DEFAULT
  if (override) {
    const label = product.code ?? product.name
    guide_md = `${AGENT_GUIDE_DEFAULT}\n\n---\n\n## Product-specifieke aanvullingen — ${label}\n\n${override.content_md}`
  }

  if (guide_md.length > AGENT_GUIDE_MAX_CHARS) {
    throw new AgentGuideTooLargeError(guide_md.length)
  }

  return {
    guide_md,
    has_product_override: override !== null,
    product_doc: override
      ? { slug: override.slug, status: override.status, updated_at: override.updated_at }
      : null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/lib/agent-guide.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-guide.ts __tests__/lib/agent-guide.test.ts
git commit -m "feat(agent-guide): add resolver with status/folder gating and size cap"
```

---

## Task 3: `get_agent_guide` MCP tool

**Files:**
- Create: `src/tools/get-agent-guide.ts`
- Test: `__tests__/tools/get-agent-guide.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/tools/get-agent-guide.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuth, mockProductFindFirst, mockResolveAgentGuide } = vi.hoisted(() => ({
  mockGetAuth: vi.fn(),
  mockProductFindFirst: vi.fn(),
  mockResolveAgentGuide: vi.fn(),
}))

vi.mock('../../src/auth.js', () => ({
  getAuth: mockGetAuth,
  // errors.js (real) references PermissionDeniedError via instanceof.
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))

vi.mock('../../src/prisma.js', () => ({
  prisma: { product: { findFirst: mockProductFindFirst } },
}))

vi.mock('../../src/lib/agent-guide.js', () => ({
  resolveAgentGuide: mockResolveAgentGuide,
}))

import { registerGetAgentGuideTool } from '../../src/tools/get-agent-guide.js'

function makeServer() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | null = null
  const server = {
    registerTool: vi.fn((_name: string, _def: unknown, h: typeof handler) => {
      handler = h
    }),
    call: async (args: Record<string, unknown>) => {
      if (!handler) throw new Error('tool not registered')
      return handler(args)
    },
  }
  return server
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAuth.mockResolvedValue({ userId: 'u1' })
  mockProductFindFirst.mockResolvedValue({
    id: 'p1',
    code: 'P1',
    name: 'Test',
    enabled_doc_folders: ['MANUAL'],
  })
  mockResolveAgentGuide.mockResolvedValue({
    guide_md: 'MERGED GUIDE',
    has_product_override: true,
    product_doc: { slug: 'agent-guide', status: 'active', updated_at: new Date() },
  })
})

describe('get_agent_guide tool', () => {
  it('returns the resolved guide for an accessible product', async () => {
    const server = makeServer()
    registerGetAgentGuideTool(server as never)
    const res = await server.call({ product_id: 'p1' })
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(res.content[0].text).guide_md).toBe('MERGED GUIDE')
  })

  it('errors and skips the resolver when the product is not accessible', async () => {
    mockProductFindFirst.mockResolvedValue(null)
    const server = makeServer()
    registerGetAgentGuideTool(server as never)
    const res = await server.call({ product_id: 'nope' })
    expect(res.isError).toBe(true)
    expect(mockResolveAgentGuide).not.toHaveBeenCalled()
  })

  it('hard-fails (isError) when the merged guide is too large', async () => {
    mockResolveAgentGuide.mockRejectedValue(
      new Error('AGENT_GUIDE_TOO_LARGE: merged guide is 20000 chars (max 16000)'),
    )
    const server = makeServer()
    registerGetAgentGuideTool(server as never)
    const res = await server.call({ product_id: 'p1' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('AGENT_GUIDE_TOO_LARGE')
  })
})
```

> Note: this test uses the **real** `src/errors.js` (it is not mocked) so that `withToolErrors` actually converts a thrown error into an `isError` result.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/tools/get-agent-guide.test.ts`
Expected: FAIL — cannot find module `../../src/tools/get-agent-guide.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/get-agent-guide.ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { resolveAgentGuide } from '../lib/agent-guide.js'

const inputSchema = z.object({
  product_id: z.string().min(1),
})

export function registerGetAgentGuideTool(server: McpServer) {
  server.registerTool(
    'get_agent_guide',
    {
      title: 'Build & document guide for a product',
      description:
        'Resolve the binding build & document guide for a product (global default ' +
        'plus an optional per-product override). Call this and follow guide_md before ' +
        'building or documenting.',
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ product_id }) =>
      withToolErrors(async () => {
        const auth = await getAuth()
        const product = await prisma.product.findFirst({
          where: {
            id: product_id,
            OR: [
              { user_id: auth.userId },
              { members: { some: { user_id: auth.userId } } },
            ],
          },
          select: { id: true, code: true, name: true, enabled_doc_folders: true },
        })
        if (!product) {
          return toolError(`Product ${product_id} not found or not accessible`)
        }
        const result = await resolveAgentGuide(product)
        return toolJson(result)
      }),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/tools/get-agent-guide.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/get-agent-guide.ts __tests__/tools/get-agent-guide.test.ts
git commit -m "feat(agent-guide): add get_agent_guide MCP tool"
```

---

## Task 4: Surface `agent_guide` on `get_claude_context`

**Files:**
- Modify: `src/tools/get-claude-context.ts` (product select ~line 35-42; return ~line 121-126; new import)
- Modify: `__tests__/get-claude-context-filter.test.ts` (keep green after new import)
- Test: `__tests__/tools/get-claude-context-agent-guide.test.ts`

- [ ] **Step 1: Keep the existing filter test green**

Add this mock to the top of `__tests__/get-claude-context-filter.test.ts` (after the existing `vi.mock('../src/errors.js', ...)` block, before the `import { registerGetClaudeContextTool }` line). The module exists from Task 2, and mocking it keeps the existing test isolated from real Prisma `productDoc` calls:

```ts
vi.mock('../src/lib/agent-guide.js', () => ({
  resolveAgentGuide: vi
    .fn()
    .mockResolvedValue({ guide_md: 'GUIDE', has_product_override: false, product_doc: null }),
}))
```

- [ ] **Step 2: Write the failing test for the new field**

```ts
// __tests__/tools/get-claude-context-agent-guide.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockProductFindFirst,
  mockSprintFindFirst,
  mockStoryFindFirst,
  mockIdeaFindMany,
  mockResolveAgentGuide,
} = vi.hoisted(() => ({
  mockProductFindFirst: vi.fn(),
  mockSprintFindFirst: vi.fn(),
  mockStoryFindFirst: vi.fn(),
  mockIdeaFindMany: vi.fn(),
  mockResolveAgentGuide: vi.fn(),
}))

vi.mock('../../src/auth.js', () => ({
  getAuth: vi.fn().mockResolvedValue({ userId: 'u1', isDemo: false }),
}))

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    product: { findFirst: mockProductFindFirst },
    sprint: { findFirst: mockSprintFindFirst },
    story: { findFirst: mockStoryFindFirst },
    idea: { findMany: mockIdeaFindMany },
  },
}))

vi.mock('../../src/errors.js', () => ({
  toolError: vi.fn((msg: string) => ({ isError: true, content: [{ type: 'text', text: msg }] })),
  toolJson: vi.fn((data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })),
  withToolErrors: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

vi.mock('../../src/lib/agent-guide.js', () => ({
  resolveAgentGuide: mockResolveAgentGuide,
}))

import { registerGetClaudeContextTool } from '../../src/tools/get-claude-context.js'

function makeServer() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | null = null
  const server = {
    registerTool: vi.fn((_n: string, _d: unknown, h: typeof handler) => {
      handler = h
    }),
    call: async (args: Record<string, unknown>) => handler!(args),
  }
  return server
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProductFindFirst.mockResolvedValue({
    id: 'p1', code: 'P1', name: 'Test', description: null, repo_url: null,
    definition_of_done: null, enabled_doc_folders: ['MANUAL'],
  })
  mockSprintFindFirst.mockResolvedValue(null)
  mockStoryFindFirst.mockResolvedValue(null)
  mockIdeaFindMany.mockResolvedValue([])
})

describe('get_claude_context agent_guide field', () => {
  it('includes the resolved guide on success', async () => {
    mockResolveAgentGuide.mockResolvedValue({
      guide_md: 'GUIDE', has_product_override: false, product_doc: null,
    })
    const server = makeServer()
    registerGetClaudeContextTool(server as never)
    const res = await server.call({ product_id: 'p1' })
    const data = JSON.parse(res.content[0].text)
    expect(data.agent_guide).toBe('GUIDE')
    expect(data.agent_guide_error).toBeNull()
  })

  it('degrades to null + error string instead of failing the whole call', async () => {
    mockResolveAgentGuide.mockRejectedValue(new Error('AGENT_GUIDE_TOO_LARGE: too big'))
    const server = makeServer()
    registerGetClaudeContextTool(server as never)
    const res = await server.call({ product_id: 'p1' })
    expect(res.isError).toBeFalsy()
    const data = JSON.parse(res.content[0].text)
    expect(data.agent_guide).toBeNull()
    expect(data.agent_guide_error).toContain('AGENT_GUIDE_TOO_LARGE')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run __tests__/tools/get-claude-context-agent-guide.test.ts`
Expected: FAIL — `data.agent_guide` is `undefined` (field not implemented yet).

- [ ] **Step 4: Implement the changes**

In `src/tools/get-claude-context.ts`, add the import near the other tool imports:

```ts
import { resolveAgentGuide } from '../lib/agent-guide.js'
```

Add `enabled_doc_folders` to the product `select` (the block currently ending at `definition_of_done: true,`):

```ts
          select: {
            id: true,
            code: true,
            name: true,
            description: true,
            repo_url: true,
            definition_of_done: true,
            enabled_doc_folders: true,
          },
```

Replace the final `return toolJson({ ... })` block with:

```ts
        let agent_guide: string | null = null
        let agent_guide_error: string | null = null
        try {
          const guide = await resolveAgentGuide(product)
          agent_guide = guide.guide_md
        } catch (err) {
          agent_guide_error = err instanceof Error ? err.message : String(err)
        }

        return toolJson({
          product,
          active_sprint: activeSprint,
          next_story: nextStory,
          open_ideas: openIdeas,
          agent_guide,
          agent_guide_error,
        })
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run __tests__/tools/get-claude-context-agent-guide.test.ts __tests__/get-claude-context-filter.test.ts`
Expected: PASS (both files green).

- [ ] **Step 6: Commit**

```bash
git add src/tools/get-claude-context.ts __tests__/tools/get-claude-context-agent-guide.test.ts __tests__/get-claude-context-filter.test.ts
git commit -m "feat(agent-guide): surface agent_guide on get_claude_context with graceful degrade"
```

---

## Task 5: Allow autonomous workers to call the tool

**Files:**
- Modify: `src/lib/job-config.ts:55-74` (`TASK_TOOLS`)
- Modify: `__tests__/job-config.test.ts`

- [ ] **Step 1: Write the failing test**

Add this block to `__tests__/job-config.test.ts` (inside the existing file, e.g. after the `KIND_DEFAULTS.allowed_tools` describe):

```ts
describe('agent-guide tool allowlist', () => {
  it('TASK_IMPLEMENTATION may call get_agent_guide', () => {
    expect(getKindDefault('TASK_IMPLEMENTATION').allowed_tools).toContain(
      'mcp__scrum4me__get_agent_guide',
    )
  })

  it('SPRINT_IMPLEMENTATION may call get_agent_guide (inherits TASK_TOOLS)', () => {
    expect(getKindDefault('SPRINT_IMPLEMENTATION').allowed_tools).toContain(
      'mcp__scrum4me__get_agent_guide',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/job-config.test.ts`
Expected: FAIL — both new assertions fail (tool not in `TASK_TOOLS`).

- [ ] **Step 3: Implement the change**

In `src/lib/job-config.ts`, add the tool to `TASK_TOOLS` (e.g. directly after `'mcp__scrum4me__get_claude_context',`):

```ts
  'mcp__scrum4me__get_claude_context',
  'mcp__scrum4me__get_agent_guide',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/job-config.test.ts`
Expected: PASS (all, including the 2 new assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/job-config.ts __tests__/job-config.test.ts
git commit -m "feat(agent-guide): allow get_agent_guide in task/sprint job allowlist"
```

---

## Task 6: Register `get_agent_guide` in the shared toolset

**Files:**
- Modify: `src/register.ts`
- Test: `__tests__/register-agent-guide.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/register-agent-guide.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/register-agent-guide.test.ts`
Expected: FAIL — `names` does not contain `get_agent_guide`.

- [ ] **Step 3: Implement the change**

In `src/register.ts`, add the import next to `registerGetClaudeContextTool`:

```ts
import { registerGetAgentGuideTool } from './tools/get-agent-guide.js'
```

Inside `registerSharedTools()`, add the call right after `registerGetClaudeContextTool(server)`:

```ts
  registerGetClaudeContextTool(server)
  registerGetAgentGuideTool(server)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/register-agent-guide.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/register.ts __tests__/register-agent-guide.test.ts
git commit -m "feat(agent-guide): register get_agent_guide in shared toolset"
```

---

## Task 7: Share `INSTRUCTIONS` + add the bootstrap pointer

**Files:**
- Create: `src/instructions.ts`
- Modify: `src/http.ts` (remove local const at :38-46, import instead)
- Modify: `src/index.ts` (replace inline string at :31-39, import instead)
- Test: `__tests__/instructions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/instructions.test.ts
import { describe, it, expect } from 'vitest'
import { INSTRUCTIONS } from '../src/instructions.js'

describe('shared MCP INSTRUCTIONS', () => {
  it('keeps the existing get_claude_context guidance', () => {
    expect(INSTRUCTIONS).toContain('get_claude_context')
  })

  it('points workers at get_agent_guide before building/documenting', () => {
    expect(INSTRUCTIONS).toContain('get_agent_guide')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/instructions.test.ts`
Expected: FAIL — cannot find module `../src/instructions.js`.

- [ ] **Step 3: Create the shared module**

```ts
// src/instructions.ts
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
```

- [ ] **Step 4: Wire `src/http.ts` to the shared constant**

Delete the local `const INSTRUCTIONS = ...` block (lines 38-46) and add an import near the other imports at the top of `src/http.ts`:

```ts
import { INSTRUCTIONS } from './instructions.js'
```

(The existing `new McpServer({ ... }, { instructions: INSTRUCTIONS })` at the former line 78 keeps working unchanged.)

- [ ] **Step 5: Wire `src/index.ts` to the shared constant**

Add the import near the top of `src/index.ts`:

```ts
import { INSTRUCTIONS } from './instructions.js'
```

Replace the inline instructions object (lines 28-41) with:

```ts
  const server = new McpServer(
    { name: 'scrum4me-mcp', version: VERSION },
    { instructions: INSTRUCTIONS },
  )
```

- [ ] **Step 6: Run test + typecheck to verify**

Run: `npx vitest run __tests__/instructions.test.ts && npm run typecheck`
Expected: test PASS (2 tests); typecheck reports no errors.

- [ ] **Step 7: Commit**

```bash
git add src/instructions.ts src/http.ts src/index.ts __tests__/instructions.test.ts
git commit -m "feat(agent-guide): share INSTRUCTIONS and add get_agent_guide bootstrap pointer"
```

---

## Task 8: Point the task/sprint kind-prompts at the guide

**Files:**
- Modify: `src/prompts/task/implementation.md`
- Modify: `src/prompts/sprint/implementation.md`
- Modify: `__tests__/kind-prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Add this block to `__tests__/kind-prompts.test.ts`:

```ts
describe('agent-guide rule in implementation prompts', () => {
  it.each(['TASK_IMPLEMENTATION', 'SPRINT_IMPLEMENTATION'] as const)(
    '%s-prompt instructs calling get_agent_guide',
    (kind) => {
      expect(getKindPromptText(kind)).toContain('get_agent_guide')
    },
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/kind-prompts.test.ts`
Expected: FAIL — both prompts lack `get_agent_guide`.

- [ ] **Step 3: Edit `src/prompts/task/implementation.md`**

Under `## Hard regels`, add this bullet (after the `Volg task.implementation_plan ...` bullet):

```markdown
- Roep eerst `mcp__scrum4me__get_agent_guide({ product_id })` aan (product_id uit de
  payload) en behandel `guide_md` als bindend voor hóé je bouwt en documenteert.
```

- [ ] **Step 4: Edit `src/prompts/sprint/implementation.md`**

Add the same bullet to the sprint prompt's hard-rules / workflow section (mirror the wording exactly):

```markdown
- Roep eerst `mcp__scrum4me__get_agent_guide({ product_id })` aan (product_id uit de
  payload) en behandel `guide_md` als bindend voor hóé je bouwt en documenteert.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run __tests__/kind-prompts.test.ts`
Expected: PASS (including the 2 new assertions).

- [ ] **Step 6: Commit**

```bash
git add src/prompts/task/implementation.md src/prompts/sprint/implementation.md __tests__/kind-prompts.test.ts
git commit -m "feat(agent-guide): instruct task/sprint workers to follow the agent guide"
```

---

## Final verification

- [ ] **Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files pass; `tsc --noEmit` reports no errors.

- [ ] **Manual MCP smoke (optional, needs a live DB + token)**

1. Create an override doc for a test product:
   `create_product_doc({ product_id, folder: 'manual', slug: 'agent-guide', content_md: '---\ntitle: Agent guide\nstatus: active\n---\n\nAlways run the linter.' })`
2. `get_agent_guide({ product_id })` → expect `guide_md` containing the default plus the
   `## Product-specifieke aanvullingen` section.
3. Re-create/update the doc with `status: draft` → `get_agent_guide` returns the default only.
4. `get_claude_context({ product_id })` → response includes `agent_guide` (string) and
   `agent_guide_error: null`.

---

## Spec coverage check

| Spec item | Task |
|---|---|
| Global default as TS module | Task 1 |
| Resolver: status=active + enabled_doc_folders gate, layered-append merge, size cap | Task 2 |
| `get_agent_guide` tool (access check + hard-fail on too-large) | Task 3 |
| `agent_guide` field on `get_claude_context` + graceful degrade | Task 4 |
| `TASK_TOOLS` allowlist (covers sprint via spread) | Task 5 |
| Register in `registerSharedTools()`, not worktree | Task 6 |
| Shared `INSTRUCTIONS` + bootstrap pointer | Task 7 |
| Kind-prompt rule for task + sprint | Task 8 |
