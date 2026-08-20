# Work-item-ids op queue-berichten — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optionele `sprint_id`/`story_id`/`task_id` op `queue_push` die als canoniek `meta.work_item`-blok worden opgeslagen (fase 1), plus een read-only, product-guarded cross-adres-zoektool `queue_find_by_work_item` (fase 2).

**Architecture:** Alle afleid-/consistentielogica leeft in één nieuwe module `src/queue/work-item.ts` (resolver). `queue_push` krijgt drie optionele parameters en canonicaliseert óók een caller-geleverd `meta.work_item`-blok door de vereniging van beide id-bronnen door dezelfde resolver te sturen — vóór de insert, dus een fout laat geen rij en geen NOTIFY achter. Fase 2 filtert op jsonb-paden in `agent_message.meta`, past een productguard toe via `userCanAccessProduct`, en voegt directe replies bij onder hetzelfde `include_archived`-predicaat. Géén schema-wijziging; alleen dit repo.

**Tech Stack:** TypeScript (NodeNext — relatieve imports mét `.js`), Prisma 7 + `@prisma/adapter-pg`, Zod, vitest, MCP SDK (`server.registerTool`).

**Spec:** `docs/superpowers/specs/2026-08-20-queue-work-item-ids-design.md` (GO — dubbel GO ronde 3, r3 @ `58cd595`, MINOR-harmonisatie in `d63c4d9`). Review record staat onderin de spec.

## Global Constraints

- **Geen schema-wijziging.** Opslag uitsluitend in het bestaande `meta Json`-veld van `agent_message`. `s4m-queue`-migraties, archief-pariteitscontract en CLI blijven ongemoeid.
- **Canoniek blok:** `meta.work_item = { product_id, sprint_id?, story_id?, task_id? }` — alleen aanwezige velden, nooit `null`-waarden. `product_id` wordt **altijd afgeleid, nooit overgenomen** van de caller.
- **Afleiding via de Story als bron van waarheid:** `task_id` → `story_id` uit `Task.story_id`, `sprint_id` uit **`Story.sprint_id`**, `product_id` uit **`Story.product_id`** (de Task-kolommen `sprint_id`/`product_id` zijn gedenormaliseerde kopieën — `src/tools/create-task.ts:91-92` — en mogen NIET gelezen worden). `story_id` → `Story.sprint_id` + `Story.product_id`. `sprint_id` → `Sprint.product_id`.
- **Vereniging + conflict = fout:** ids uit de parameters én uit een caller-geleverd `meta.work_item` worden verenigd en samen geresolved; elk conflict (onderling of na afleiding) → `VALIDATION_ERROR`. Onbestaand id → `VALIDATION_ERROR`. Een gegeven `sprint_id` terwijl de afgeleide sprint ontbreekt (taak/story niet in een sprint) is óók een conflict.
- **Validatie vóór de insert:** een resolver-fout laat geen rij en geen NOTIFY achter (patroon: `validateTaskMeta` in `src/tools/queue-push.ts:79` — throw binnen `withToolErrors`).
- **Levert geen enkele bron een id op** (en na canonicalisatie blijft er geen id over) → geen `work_item`-sleutel in meta; bestaand gedrag verandert met nul bytes.
- **Fase-2-tool:** cross-adres, read-only, niet-claimend (`readOnlyHint`, `idempotentHint`); minstens één id vereist; meerdere ids = AND; `include_archived` (default `false`) geldt voor match-query ÉN reply-query; productguard verplicht (rijen zonder `meta.work_item.product_id` nooit teruggeven; per distinct product `userCanAccessProduct`); replies één niveau via `in_reply_to`, alleen bij overlevende matches; sortering `created_at desc`; `take: 100` op de match-query, `truncated: true` bij het raken van de cap; respons `{ count, truncated, messages: messageView[] }`; cold-store (`agent_message_archive`) wordt niet doorzocht en de tool-description benoemt de retentiegrens (`S4M_RETENTION_DAYS`, default 60).
- **Entiteit-transparantie:** meta gaat byte-exact door `messageView` + `toolJson`; de canary-uitbreiding in `__tests__/queue-entity-transparency.test.ts` is verplicht onderdeel van dit werk.
- **Testidioom:** volg `__tests__/queue-push.test.ts` — `vi.mock` op `../src/prisma.js`/`../src/auth.js`, `makeServer()`-harnas dat de handler direct aanroept. Type-valkuilen: gebruik `AnyMock` uit `__tests__/helpers/mocks.ts` waar je `.mock.calls` leest (vitest 4), en relatieve imports mét `.js`-extensie (TS2307 betekent: module nooit getypecheckt).
- **Verificatie per taak:** `npx vitest run <testbestand>` groen, daarna `npm run typecheck && npm run typecheck:tests`. Commit per taak.

## File Structure

| Bestand | Verantwoordelijkheid |
|---|---|
| `src/queue/work-item.ts` (nieuw) | `extractWorkItemIds`, `mergeWorkItemInputs`, `resolveWorkItem` — alle afleid-/consistentielogica, los testbaar |
| `src/tools/queue-push.ts` (wijzig) | drie optionele params; canonicalisatie-aanroep vóór de insert |
| `src/tools/queue-find-by-work-item.ts` (nieuw) | fase-2-zoektool incl. productguard en reply-bijvoeging |
| `src/register.ts` (wijzig) | registratie van de nieuwe tool in `registerQueueTools` |
| `__tests__/queue-work-item.test.ts` (nieuw) | resolver-unit-tests |
| `__tests__/queue-push.test.ts` (wijzig) | push-integratie: params → canoniek blok; conflict/fouten |
| `__tests__/queue-entity-transparency.test.ts` (wijzig) | meta-roundtrip-canary |
| `__tests__/queue-find-by-work-item.test.ts` (nieuw) | find-tool-unit-tests |
| `__tests__/queue-registration.test.ts` (wijzig) | `queue_find_by_work_item` toevoegen aan `QUEUE_TOOL_NAMES` |

---

### Task 1: Resolver-module `src/queue/work-item.ts`

**Files:**
- Create: `src/queue/work-item.ts`
- Test: `__tests__/queue-work-item.test.ts`

**Interfaces:**
- Consumes: `prisma` uit `../prisma.js` (`task.findUnique`, `story.findUnique`, `sprint.findUnique`).
- Produces (Task 2 leunt hierop):
  - `interface WorkItemInput { sprint_id?: string; story_id?: string; task_id?: string }`
  - `interface WorkItemBlock { product_id: string; sprint_id?: string; story_id?: string; task_id?: string }`
  - `extractWorkItemIds(block: unknown): WorkItemInput` — leest alleen string-waarden van de drie id-sleutels uit een caller-blok; negeert al het andere (incl. `product_id`).
  - `mergeWorkItemInputs(params: WorkItemInput, block: WorkItemInput): WorkItemInput` — vereniging; zelfde sleutel met verschillende waarde → throw `VALIDATION_ERROR`.
  - `resolveWorkItem(input: WorkItemInput): Promise<WorkItemBlock | null>` — `null` bij lege input; anders afgeleid+gevalideerd blok of throw `VALIDATION_ERROR: …`.

- [ ] **Step 1: Schrijf de failing tests**

`__tests__/queue-work-item.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    task: { findUnique: vi.fn() },
    story: { findUnique: vi.fn() },
    sprint: { findUnique: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import {
  extractWorkItemIds,
  mergeWorkItemInputs,
  resolveWorkItem,
} from '../src/queue/work-item.js'
import type { AnyMock } from './helpers/mocks.js'

const mockTask = prisma.task.findUnique as AnyMock
const mockStory = prisma.story.findUnique as AnyMock
const mockSprint = prisma.sprint.findUnique as AnyMock

beforeEach(() => vi.clearAllMocks())

describe('extractWorkItemIds', () => {
  it('leest alleen de drie id-sleutels als string; product_id en rommel vervallen', () => {
    expect(
      extractWorkItemIds({
        task_id: 't1', story_id: 's1', sprint_id: 'sp1',
        product_id: 'vervalst', extra: 1, nested: { task_id: 'nee' },
      }),
    ).toEqual({ task_id: 't1', story_id: 's1', sprint_id: 'sp1' })
  })
  it('geeft {} voor non-object, lege of id-loze input', () => {
    expect(extractWorkItemIds(undefined)).toEqual({})
    expect(extractWorkItemIds('x')).toEqual({})
    expect(extractWorkItemIds({ product_id: 'p' })).toEqual({})
    expect(extractWorkItemIds({ task_id: '' })).toEqual({})
    expect(extractWorkItemIds({ task_id: 42 })).toEqual({})
  })
})

describe('mergeWorkItemInputs', () => {
  it('verenigt disjuncte en gelijke sleutels', () => {
    expect(mergeWorkItemInputs({ task_id: 't1' }, { story_id: 's1', task_id: 't1' }))
      .toEqual({ task_id: 't1', story_id: 's1' })
  })
  it('gooit VALIDATION_ERROR bij conflict parameter↔blok', () => {
    expect(() => mergeWorkItemInputs({ task_id: 't1' }, { task_id: 't2' }))
      .toThrow(/VALIDATION_ERROR.*task_id/)
  })
})

describe('resolveWorkItem', () => {
  it('geeft null bij lege input en raakt de DB niet aan', async () => {
    expect(await resolveWorkItem({})).toBeNull()
    expect(mockTask).not.toHaveBeenCalled()
    expect(mockStory).not.toHaveBeenCalled()
    expect(mockSprint).not.toHaveBeenCalled()
  })

  it('task_id: sprint én product komen uit de Story, in één findUnique met story-select', async () => {
    mockTask.mockResolvedValue({
      story_id: 's1',
      story: { sprint_id: 'sp1', product_id: 'p1' },
    })
    const block = await resolveWorkItem({ task_id: 't1' })
    expect(block).toEqual({ product_id: 'p1', sprint_id: 'sp1', story_id: 's1', task_id: 't1' })
    // De select mag de gedenormaliseerde Task-kolommen niet lezen (spec §4):
    const select = (mockTask.mock.calls[0][0] as { select: Record<string, unknown> }).select
    expect(select).not.toHaveProperty('sprint_id')
    expect(select).not.toHaveProperty('product_id')
    expect(select).toHaveProperty('story')
    expect(mockStory).not.toHaveBeenCalled()
    expect(mockSprint).not.toHaveBeenCalled()
  })

  it('task in story zonder sprint → blok zonder sprint_id-sleutel', async () => {
    mockTask.mockResolvedValue({ story_id: 's1', story: { sprint_id: null, product_id: 'p1' } })
    const block = await resolveWorkItem({ task_id: 't1' })
    expect(block).toEqual({ product_id: 'p1', story_id: 's1', task_id: 't1' })
    expect(block).not.toHaveProperty('sprint_id')
  })

  it('story_id: sprint (nullable) en product uit de Story', async () => {
    mockStory.mockResolvedValue({ sprint_id: null, product_id: 'p1' })
    expect(await resolveWorkItem({ story_id: 's1' }))
      .toEqual({ product_id: 'p1', story_id: 's1' })
  })

  it('sprint_id alleen: product uit de Sprint', async () => {
    mockSprint.mockResolvedValue({ product_id: 'p1' })
    expect(await resolveWorkItem({ sprint_id: 'sp1' }))
      .toEqual({ product_id: 'p1', sprint_id: 'sp1' })
  })

  it('onbestaand id → VALIDATION_ERROR met het veld erin', async () => {
    mockTask.mockResolvedValue(null)
    await expect(resolveWorkItem({ task_id: 'weg' })).rejects.toThrow(/VALIDATION_ERROR.*task_id.*weg/)
    mockStory.mockResolvedValue(null)
    await expect(resolveWorkItem({ story_id: 'weg' })).rejects.toThrow(/VALIDATION_ERROR.*story_id.*weg/)
    mockSprint.mockResolvedValue(null)
    await expect(resolveWorkItem({ sprint_id: 'weg' })).rejects.toThrow(/VALIDATION_ERROR.*sprint_id.*weg/)
  })

  it('task hoort niet bij gegeven story → VALIDATION_ERROR met beide kanten', async () => {
    mockTask.mockResolvedValue({ story_id: 's-echt', story: { sprint_id: null, product_id: 'p1' } })
    await expect(resolveWorkItem({ task_id: 't1', story_id: 's-anders' }))
      .rejects.toThrow(/VALIDATION_ERROR.*s-echt.*s-anders/)
  })

  it('afgeleide sprint ≠ gegeven sprint → VALIDATION_ERROR', async () => {
    mockTask.mockResolvedValue({ story_id: 's1', story: { sprint_id: 'sp-echt', product_id: 'p1' } })
    await expect(resolveWorkItem({ task_id: 't1', sprint_id: 'sp-anders' }))
      .rejects.toThrow(/VALIDATION_ERROR.*sp-echt.*sp-anders/)
  })

  it('sprint gegeven maar story zit niet in een sprint → VALIDATION_ERROR', async () => {
    mockStory.mockResolvedValue({ sprint_id: null, product_id: 'p1' })
    await expect(resolveWorkItem({ story_id: 's1', sprint_id: 'sp1' }))
      .rejects.toThrow(/VALIDATION_ERROR.*niet in een sprint/)
  })

  it('story_id + kloppende sprint_id: geen extra sprint-query', async () => {
    mockStory.mockResolvedValue({ sprint_id: 'sp1', product_id: 'p1' })
    expect(await resolveWorkItem({ story_id: 's1', sprint_id: 'sp1' }))
      .toEqual({ product_id: 'p1', sprint_id: 'sp1', story_id: 's1' })
    expect(mockSprint).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run de tests — verwacht FAIL**

Run: `npx vitest run __tests__/queue-work-item.test.ts`
Expected: FAIL — `Cannot find module '../src/queue/work-item.js'`.

- [ ] **Step 3: Implementeer `src/queue/work-item.ts`**

```ts
// Afleiding en validatie van meta.work_item voor queue_push (spec:
// docs/superpowers/specs/2026-08-20-queue-work-item-ids-design.md §3-§4).
//
// Bron van waarheid voor sprint- én productlidmaatschap van een taak is de
// STORY, niet de gedenormaliseerde Task-kolommen (create-task.ts:91-92,
// access.ts userCanAccessTask). Lees Task.sprint_id/product_id hier dus nooit.
import { prisma } from '../prisma.js'

export interface WorkItemInput {
  sprint_id?: string
  story_id?: string
  task_id?: string
}

export interface WorkItemBlock {
  product_id: string
  sprint_id?: string
  story_id?: string
  task_id?: string
}

const ID_KEYS = ['sprint_id', 'story_id', 'task_id'] as const

/** Leest alleen de drie id-sleutels (niet-lege strings) uit een caller-blok. */
export function extractWorkItemIds(block: unknown): WorkItemInput {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return {}
  const source = block as Record<string, unknown>
  const out: WorkItemInput = {}
  for (const key of ID_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') out[key] = value
  }
  return out
}

/** Vereniging van parameter-ids en caller-blok-ids; conflict → throw. */
export function mergeWorkItemInputs(params: WorkItemInput, block: WorkItemInput): WorkItemInput {
  const out: WorkItemInput = { ...block }
  for (const key of ID_KEYS) {
    const fromParams = params[key]
    if (fromParams === undefined) continue
    if (out[key] !== undefined && out[key] !== fromParams) {
      throw new Error(
        `VALIDATION_ERROR: ${key} conflicteert — parameter '${fromParams}' vs meta.work_item '${out[key]}'`,
      )
    }
    out[key] = fromParams
  }
  return out
}

/** Vult de hiërarchie omhoog aan vanuit het meest specifieke id en valideert
 *  consistentie. null bij lege input; throw bij onbestaand/inconsistent id. */
export async function resolveWorkItem(input: WorkItemInput): Promise<WorkItemBlock | null> {
  const { sprint_id, story_id, task_id } = input
  if (!sprint_id && !story_id && !task_id) return null

  let productId: string | undefined
  // undefined = nog niet afgeleid; null = afgeleid-en-afwezig (geen sprint).
  let derivedSprint: string | null | undefined
  let derivedStory: string | undefined

  if (task_id) {
    const task = await prisma.task.findUnique({
      where: { id: task_id },
      select: { story_id: true, story: { select: { sprint_id: true, product_id: true } } },
    })
    if (!task) throw new Error(`VALIDATION_ERROR: task_id '${task_id}' not found`)
    derivedStory = task.story_id
    derivedSprint = task.story.sprint_id
    productId = task.story.product_id
    if (story_id && story_id !== derivedStory) {
      throw new Error(
        `VALIDATION_ERROR: task_id '${task_id}' hoort bij story '${derivedStory}', ` +
          `niet bij gegeven story_id '${story_id}'`,
      )
    }
  } else if (story_id) {
    const story = await prisma.story.findUnique({
      where: { id: story_id },
      select: { sprint_id: true, product_id: true },
    })
    if (!story) throw new Error(`VALIDATION_ERROR: story_id '${story_id}' not found`)
    derivedStory = story_id
    derivedSprint = story.sprint_id
    productId = story.product_id
  }

  if (derivedSprint !== undefined) {
    if (sprint_id && derivedSprint === null) {
      throw new Error(
        `VALIDATION_ERROR: sprint_id '${sprint_id}' gegeven maar de story zit niet in een sprint`,
      )
    }
    if (sprint_id && sprint_id !== derivedSprint) {
      throw new Error(
        `VALIDATION_ERROR: afgeleide sprint '${derivedSprint}' komt niet overeen met ` +
          `gegeven sprint_id '${sprint_id}'`,
      )
    }
  } else if (sprint_id) {
    const sprint = await prisma.sprint.findUnique({
      where: { id: sprint_id },
      select: { product_id: true },
    })
    if (!sprint) throw new Error(`VALIDATION_ERROR: sprint_id '${sprint_id}' not found`)
    derivedSprint = sprint_id
    productId = sprint.product_id
  }

  const block: WorkItemBlock = { product_id: productId as string }
  if (typeof derivedSprint === 'string') block.sprint_id = derivedSprint
  if (derivedStory) block.story_id = derivedStory
  if (task_id) block.task_id = task_id
  return block
}
```

- [ ] **Step 4: Run de tests — verwacht PASS**

Run: `npx vitest run __tests__/queue-work-item.test.ts`
Expected: alle tests PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck && npm run typecheck:tests`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/queue/work-item.ts __tests__/queue-work-item.test.ts
git commit -m "feat(queue): work-item-resolver — afleiding via Story, conflictvalidatie"
```

---

### Task 2: `queue_push` — parameters + canonicalisatie

**Files:**
- Modify: `src/tools/queue-push.ts`
- Test: `__tests__/queue-push.test.ts` (uitbreiden — bestaande tests blijven ongewijzigd groen)

**Interfaces:**
- Consumes (uit Task 1): `extractWorkItemIds`, `mergeWorkItemInputs`, `resolveWorkItem`, type `WorkItemInput` uit `../queue/work-item.js`.
- Produces: `queue_push` accepteert `sprint_id?`, `story_id?`, `task_id?` (Zod `z.string().min(1).optional()`); opgeslagen meta bevat een canoniek `work_item`-blok of geen `work_item`-sleutel.

- [ ] **Step 1: Schrijf de failing tests** — voeg toe aan `__tests__/queue-push.test.ts`.

Breid eerst de prisma-mock bovenin uit (het `vi.mock('../src/prisma.js', …)`-blok):

```ts
vi.mock('../src/prisma.js', () => ({
  prisma: {
    agentMessage: { create: vi.fn() },
    $executeRaw: vi.fn(),
    task: { findUnique: vi.fn() },
    story: { findUnique: vi.fn() },
    sprint: { findUnique: vi.fn() },
  },
}))
```

en het `mockPrisma`-type + een helper eronder:

```ts
const mockPrisma = prisma as unknown as {
  agentMessage: { create: ReturnType<typeof vi.fn> }
  $executeRaw: ReturnType<typeof vi.fn>
  task: { findUnique: ReturnType<typeof vi.fn> }
  story: { findUnique: ReturnType<typeof vi.fn> }
  sprint: { findUnique: ReturnType<typeof vi.fn> }
}
```

Nieuwe describe-blok onderaan:

```ts
describe('queue_push — meta.work_item (spec 2026-08-20)', () => {
  it('task_id-parameter → canoniek blok, sprint/product uit de story', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      story_id: 's1', story: { sprint_id: 'sp1', product_id: 'p1' },
    })
    const server = makeServer()
    await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'x', task_id: 't1' })
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: { work_item: { product_id: 'p1', sprint_id: 'sp1', story_id: 's1', task_id: 't1' } },
      }),
    })
  })

  it('caller-blok zonder parameters wordt canoniek herschreven; meegegeven product_id vervalt', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ sprint_id: null, product_id: 'p-echt' })
    const server = makeServer()
    await server.call({
      to: 'scrum4me-server:claude', type: 'info', body: 'x',
      meta: { work_item: { story_id: 's1', product_id: 'p-vervalst', rommel: true } },
    })
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: { work_item: { product_id: 'p-echt', story_id: 's1' } },
      }),
    })
  })

  it('conflict parameter↔blok → VALIDATION_ERROR, geen insert, geen NOTIFY', async () => {
    const server = makeServer()
    const result = await server.call({
      to: 'scrum4me-server:claude', type: 'info', body: 'x',
      task_id: 't1', meta: { work_item: { task_id: 't2' } },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('VALIDATION_ERROR')
    expect(mockPrisma.agentMessage.create).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  it('onbestaand task_id → VALIDATION_ERROR, geen insert, geen NOTIFY', async () => {
    mockPrisma.task.findUnique.mockResolvedValue(null)
    const server = makeServer()
    const result = await server.call({
      to: 'scrum4me-server:claude', type: 'info', body: 'x', task_id: 'weg',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/VALIDATION_ERROR.*task_id/)
    expect(mockPrisma.agentMessage.create).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  it('zonder ids: geen work_item-sleutel en overige meta ongemoeid', async () => {
    const server = makeServer()
    await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'x', meta: { foo: 'bar' } })
    const data = mockPrisma.agentMessage.create.mock.calls[0][0].data as { meta: Record<string, unknown> }
    expect(data.meta).toEqual({ foo: 'bar' })
    expect(data.meta).not.toHaveProperty('work_item')
  })

  it('werkt samen met meta.task bij type task (work_item staat ernaast, niet erin)', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      story_id: 's1', story: { sprint_id: 'sp1', product_id: 'p1' },
    })
    const server = makeServer()
    await server.call({
      to: 'scrum4me-server:claude', type: 'task', body: 'doe iets', cwd: '/work/dir',
      task_id: 't1',
      meta: { task: { objective: 'o', verification: 'v', response_format: 'rf' } },
    })
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: {
          task: {
            cwd: '/work/dir', repo: 'https://git.jp-visser.nl/janpeter/x.git',
            objective: 'o', verification: 'v', response_format: 'rf',
          },
          work_item: { product_id: 'p1', sprint_id: 'sp1', story_id: 's1', task_id: 't1' },
        },
      }),
    })
  })
})
```

- [ ] **Step 2: Run de tests — verwacht FAIL**

Run: `npx vitest run __tests__/queue-push.test.ts`
Expected: de nieuwe tests FAIL (blok wordt niet geschreven / pass-through-blok blijft staan); de bestaande tests PASS.

- [ ] **Step 3: Implementeer in `src/tools/queue-push.ts`**

Import toevoegen (bovenin, bij de andere `../queue/`-imports):

```ts
import {
  extractWorkItemIds,
  mergeWorkItemInputs,
  resolveWorkItem,
} from '../queue/work-item.js'
```

`inputSchema` uitbreiden (na de bestaande sleutels, vóór `as`):

```ts
  // Spec 2026-08-20 (work-item-ids): optionele koppeling aan Scrum4Me-werk.
  // De tool leidt de hiërarchie af en valideert; zie src/queue/work-item.ts.
  sprint_id: z.string().min(1).optional(),
  story_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
```

Handler-signatuur wordt `async ({ to, type, body, meta, cwd, as, sprint_id, story_id, task_id }) =>`.

In de handler, ná het bestaande `meta.task`-blok (na regel `finalMeta.task = validateTaskMeta(task) …`) en vóór `prisma.agentMessage.create`:

```ts
        // Work-item-canonicalisatie (spec §3-§4): parameters ∪ caller-blok →
        // resolver. Een caller-geleverd meta.work_item gaat nooit ongevalideerd
        // door; product_id wordt altijd afgeleid, nooit overgenomen.
        const workItem = await resolveWorkItem(
          mergeWorkItemInputs(
            { sprint_id, story_id, task_id },
            extractWorkItemIds(finalMeta.work_item),
          ),
        )
        if (workItem) finalMeta.work_item = workItem as unknown as Record<string, unknown>
        else delete finalMeta.work_item
```

Beschrijving (`description`) uitbreiden met één zin, direct vóór 'Returns message_id':

```
'Optional sprint_id/story_id/task_id link the message to Scrum4Me work items: the tool derives the full hierarchy via the story (product_id included) and stores it as meta.work_item; inconsistent or unknown ids are rejected. '
```

- [ ] **Step 4: Run de tests — verwacht PASS**

Run: `npx vitest run __tests__/queue-push.test.ts`
Expected: alle tests PASS (oud én nieuw).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck && npm run typecheck:tests`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/tools/queue-push.ts __tests__/queue-push.test.ts
git commit -m "feat(queue): queue_push accepteert sprint/story/task-id en schrijft canoniek meta.work_item"
```

---

### Task 3: Meta-roundtrip-canary in de entiteit-transparantie-test

**Files:**
- Modify: `__tests__/queue-entity-transparency.test.ts`

**Interfaces:**
- Consumes: `messageView` (`src/queue/view.ts`), `toolJson` (`src/errors.ts`) — bestaand, ongewijzigd.
- Produces: regressieguard — een meta-projectie/-redactie in het leespad maakt deze test rood.

- [ ] **Step 1: Schrijf de failing-by-construction check**

Voeg onder `CANARY_BODY` toe:

```ts
// Spec 2026-08-20 (work-item-ids) §6: meta moet net zo byte-exact doorkomen
// als body. work_item + task samen, met dezelfde ontsnappings-discriminanten.
const CANARY_META = {
  work_item: {
    product_id: 'cmprod00000000000000000001',
    sprint_id: 'cmsprint000000000000000001',
    story_id: 'cmstory0000000000000000001',
    task_id: 'cmtask00000000000000000001',
  },
  task: {
    cwd: '/tmp/x',
    repo: 'https://git.jp-visser.nl/janpeter/x.git',
    objective: 'check <server>:<model> && requeue <id>',
    verification: 'pre-escaped: &lt; &amp; &gt;',
    response_format: 'markdown',
  },
} as const
```

en onderaan de describe een nieuwe test:

```ts
  it('meta (work_item + task) overleeft de round-trip byte-exact', () => {
    const serialized = toolJson({
      message: messageView({ ...row(CANARY_BODY), meta: CANARY_META }),
    })
    const text = (serialized.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text) as { message: { meta: unknown } }
    expect(parsed.message.meta).toEqual(CANARY_META)
    // Byte-gelijkheid, niet alleen structurele: een herschreven maar
    // equivalent blok zou toEqual overleven, dit niet.
    expect(JSON.stringify(parsed.message.meta)).toBe(JSON.stringify(CANARY_META))
    const structured = serialized.structuredContent as { message: { meta: unknown } }
    expect(JSON.stringify(structured.message.meta)).toBe(JSON.stringify(CANARY_META))
  })
```

- [ ] **Step 2: Run — verwacht PASS, daarna bewijs dat de test kán falen**

Run: `npx vitest run __tests__/queue-entity-transparency.test.ts`
Expected: PASS. Bewijs vervolgens de detectiekracht (patroon uit CLAUDE.md): zet tijdelijk in `src/queue/view.ts` `meta: {}` in plaats van `meta: row.meta`, run opnieuw — de nieuwe test moet FAIL — en draai de wijziging terug. `git status --porcelain` moet daarna alleen het testbestand tonen.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:tests`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add __tests__/queue-entity-transparency.test.ts
git commit -m "test(queue): meta-roundtrip-canary — work_item/task byte-exact door messageView+toolJson"
```

---

### Task 4: Fase 2 — `queue_find_by_work_item`

**Files:**
- Create: `src/tools/queue-find-by-work-item.ts`
- Modify: `src/register.ts` (import + registratie in `registerQueueTools`)
- Modify: `__tests__/queue-registration.test.ts` (`QUEUE_TOOL_NAMES` + `'queue_find_by_work_item'`)
- Test: `__tests__/queue-find-by-work-item.test.ts`

**Interfaces:**
- Consumes: `prisma.agentMessage.findMany`; `requireWriteAccess` (`../auth.js`, geeft `AuthContext` met `userId` terug — precedent `check-queue-empty.ts:30-34`); `userCanAccessProduct` (`../access.js`); `messageView` (`../queue/view.js`); `toolError`/`toolJson`/`withToolErrors` (`../errors.js`).
- Produces: MCP-tool `queue_find_by_work_item({ sprint_id?, story_id?, task_id?, include_archived? })` → `{ count, truncated, messages }`.

- [ ] **Step 1: Schrijf de failing tests**

`__tests__/queue-find-by-work-item.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { agentMessage: { findMany: vi.fn() } },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { registerQueueFindByWorkItemTool } from '../src/tools/queue-find-by-work-item.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AnyMock } from './helpers/mocks.js'

const mockFindMany = prisma.agentMessage.findMany as AnyMock
const mockAuth = requireWriteAccess as AnyMock
const mockAccess = userCanAccessProduct as AnyMock

type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args) as Promise<ToolResult>,
  }
  registerQueueFindByWorkItemTool(server as unknown as McpServer)
  return server
}

function msg(id: string, meta: unknown, createdAt: string, inReplyTo: string | null = null) {
  return {
    id, type: inReplyTo ? 'result' : 'task',
    from_server: 'mac', from_model: 'claude', to_server: 'max2', to_model: 'claude',
    body: `body-${id}`, meta, status: 'done', in_reply_to: inReplyTo,
    error: null, claimed_by: null, archived_at: null,
    created_at: new Date(createdAt), finished_at: null,
  }
}
const wi = (product_id: string, rest: Record<string, string> = {}) => ({ work_item: { product_id, ...rest } })

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'u1', tokenId: 't', username: 'agent', isDemo: false, scopedProducts: [] })
  mockAccess.mockResolvedValue(true)
  mockFindMany.mockResolvedValue([])
})

describe('queue_find_by_work_item', () => {
  it('weigert een aanroep zonder enig id', async () => {
    const server = makeServer()
    const result = await server.call({})
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/VALIDATION_ERROR.*minstens één/)
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('bouwt een AND-filter over jsonb-paden voor elk gegeven id + archived-default', async () => {
    const server = makeServer()
    await server.call({ story_id: 's1', sprint_id: 'sp1' })
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.AND).toEqual(expect.arrayContaining([
      { meta: { path: ['work_item', 'story_id'], equals: 's1' } },
      { meta: { path: ['work_item', 'sprint_id'], equals: 'sp1' } },
    ]))
    expect(where.archived_at).toBeNull()
    expect(mockFindMany.mock.calls[0][0].take).toBe(100)
    expect(mockFindMany.mock.calls[0][0].orderBy).toEqual({ created_at: 'desc' })
  })

  it('include_archived: true laat het archived-filter weg in match- én reply-query', async () => {
    mockFindMany
      .mockResolvedValueOnce([msg('m1', wi('p1', { story_id: 's1' }), '2026-08-20T10:00:00Z')])
      .mockResolvedValueOnce([])
    const server = makeServer()
    await server.call({ story_id: 's1', include_archived: true })
    expect(mockFindMany.mock.calls[0][0].where).not.toHaveProperty('archived_at')
    expect(mockFindMany.mock.calls[1][0].where).not.toHaveProperty('archived_at')
  })

  it('productguard: ontoegankelijk product en blok zonder product_id vallen af', async () => {
    mockFindMany
      .mockResolvedValueOnce([
        msg('m-ok', wi('p-toegang', { story_id: 's1' }), '2026-08-20T10:00:00Z'),
        msg('m-dicht', wi('p-dicht', { story_id: 's1' }), '2026-08-20T09:00:00Z'),
        msg('m-kaal', { work_item: { story_id: 's1' } }, '2026-08-20T08:00:00Z'),
      ])
      .mockResolvedValueOnce([])
    mockAccess.mockImplementation(async (pid: string) => pid === 'p-toegang')
    const server = makeServer()
    const result = await server.call({ story_id: 's1' })
    const body = JSON.parse(result.content[0].text)
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(['m-ok'])
    expect(mockAccess).toHaveBeenCalledWith('p-toegang', 'u1')
    // De reply-query mag alleen ids van overlevende matches bevatten:
    expect(mockFindMany.mock.calls[1][0].where.in_reply_to).toEqual({ in: ['m-ok'] })
  })

  it('voegt directe replies bij (zonder eigen work_item) met het archived-predicaat', async () => {
    mockFindMany
      .mockResolvedValueOnce([msg('req1', wi('p1', { task_id: 't1' }), '2026-08-20T10:00:00Z')])
      .mockResolvedValueOnce([msg('rep1', {}, '2026-08-20T11:00:00Z', 'req1')])
    const server = makeServer()
    const result = await server.call({ task_id: 't1' })
    const body = JSON.parse(result.content[0].text)
    expect(body.count).toBe(2)
    // Sortering created_at desc over matches + replies samen:
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(['rep1', 'req1'])
    expect(mockFindMany.mock.calls[1][0].where.archived_at).toBeNull()
  })

  it('geen replies-query wanneer geen match overleeft', async () => {
    mockFindMany.mockResolvedValueOnce([])
    const server = makeServer()
    const result = await server.call({ task_id: 't1' })
    expect(mockFindMany).toHaveBeenCalledTimes(1)
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ count: 0, truncated: false, messages: [] })
  })

  it('truncated: true wanneer de match-query de cap van 100 raakt', async () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      msg(`m${i}`, wi('p1', { sprint_id: 'sp1' }), `2026-08-19T${String(10 + (i % 12)).padStart(2, '0')}:00:00Z`))
    mockFindMany.mockResolvedValueOnce(many).mockResolvedValueOnce([])
    const server = makeServer()
    const result = await server.call({ sprint_id: 'sp1' })
    expect(JSON.parse(result.content[0].text).truncated).toBe(true)
  })

  it('registreert read-only annotaties en noemt de retentiegrens in de description', () => {
    const server = makeServer()
    const meta = server.registerTool.mock.calls[0][1] as {
      description: string
      annotations: { readOnlyHint: boolean; idempotentHint: boolean }
    }
    expect(server.registerTool.mock.calls[0][0]).toBe('queue_find_by_work_item')
    expect(meta.annotations).toEqual({ readOnlyHint: true, idempotentHint: true })
    expect(meta.description).toContain('S4M_RETENTION_DAYS')
    expect(meta.description).toContain('60')
  })
})
```

- [ ] **Step 2: Run — verwacht FAIL**

Run: `npx vitest run __tests__/queue-find-by-work-item.test.ts`
Expected: FAIL — `Cannot find module '../src/tools/queue-find-by-work-item.js'`.

- [ ] **Step 3: Implementeer `src/tools/queue-find-by-work-item.ts`**

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { messageView, type QueueMessageLike } from '../queue/view.js'

const inputSchema = z.object({
  sprint_id: z.string().min(1).optional(),
  story_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  include_archived: z.boolean().default(false),
})

const MATCH_LIMIT = 100

function workItemProductId(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const workItem = (meta as Record<string, unknown>).work_item
  if (!workItem || typeof workItem !== 'object' || Array.isArray(workItem)) return null
  const productId = (workItem as Record<string, unknown>).product_id
  return typeof productId === 'string' && productId !== '' ? productId : null
}

export function registerQueueFindByWorkItemTool(server: McpServer) {
  server.registerTool(
    'queue_find_by_work_item',
    {
      title: 'Queue find by work item',
      description:
        'Read-only, non-claiming: find queue messages linked to a Scrum4Me work item ' +
        'via meta.work_item, ACROSS all addresses (not scoped to your own). Pass at ' +
        'least one of sprint_id/story_id/task_id; multiple ids filter as AND. Because ' +
        'queue_push derives the full hierarchy, searching by story also finds its ' +
        'task-level messages. Results are product-guarded: only messages whose ' +
        'work_item.product_id you can access are returned. Direct replies of the ' +
        'surviving matches are attached under the same include_archived predicate ' +
        '(default false = active rows only). Retention boundary: rows older than ' +
        'S4M_RETENTION_DAYS (default 60) have moved to the cold-store archive and are ' +
        'NOT searched — an empty result on old work means moved, not never-existed.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ sprint_id, story_id, task_id, include_archived }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (!sprint_id && !story_id && !task_id) {
          return toolError(
            'VALIDATION_ERROR: geef minstens één van sprint_id, story_id of task_id',
          )
        }
        const includeArchived = include_archived ?? false

        const idFilters: Record<string, unknown>[] = []
        // Jsonb-padfilter; in-repo precedent: src/flow/effects.ts:129.
        if (sprint_id) idFilters.push({ meta: { path: ['work_item', 'sprint_id'], equals: sprint_id } })
        if (story_id) idFilters.push({ meta: { path: ['work_item', 'story_id'], equals: story_id } })
        if (task_id) idFilters.push({ meta: { path: ['work_item', 'task_id'], equals: task_id } })

        const matchWhere: Record<string, unknown> = { AND: idFilters }
        if (!includeArchived) matchWhere.archived_at = null
        const matches = (await prisma.agentMessage.findMany({
          where: matchWhere as never,
          orderBy: { created_at: 'desc' },
          take: MATCH_LIMIT,
        })) as QueueMessageLike[]
        const truncated = matches.length === MATCH_LIMIT

        // Productguard (spec §5): rijen zonder work_item.product_id nooit
        // teruggeven; per distinct product userCanAccessProduct.
        const productIds = new Set<string>()
        for (const match of matches) {
          const productId = workItemProductId(match.meta)
          if (productId) productIds.add(productId)
        }
        const allowed = new Set<string>()
        for (const productId of productIds) {
          if (await userCanAccessProduct(productId, auth.userId)) allowed.add(productId)
        }
        const kept = matches.filter((match) => {
          const productId = workItemProductId(match.meta)
          return productId !== null && allowed.has(productId)
        })

        // Directe replies van overlevende matches, zelfde archived-predicaat.
        let replies: QueueMessageLike[] = []
        if (kept.length > 0) {
          const replyWhere: Record<string, unknown> = {
            in_reply_to: { in: kept.map((match) => match.id) },
          }
          if (!includeArchived) replyWhere.archived_at = null
          replies = (await prisma.agentMessage.findMany({
            where: replyWhere as never,
            orderBy: { created_at: 'desc' },
          })) as QueueMessageLike[]
        }

        const combined = [...kept, ...replies].sort(
          (a, b) => b.created_at.getTime() - a.created_at.getTime(),
        )
        return toolJson({
          count: combined.length,
          truncated,
          messages: combined.map(messageView),
        })
      }),
  )
}
```

- [ ] **Step 4: Registreer de tool**

In `src/register.ts`: import bij de andere queue-imports (na regel 88):

```ts
import { registerQueueFindByWorkItemTool } from './tools/queue-find-by-work-item.js'
```

en in `registerQueueTools` (na `registerQueueListTool(server)`):

```ts
  registerQueueFindByWorkItemTool(server)
```

In `__tests__/queue-registration.test.ts`: voeg `'queue_find_by_work_item',` toe aan de `QUEUE_TOOL_NAMES`-array (regel 9-12).

- [ ] **Step 5: Run — verwacht PASS**

Run: `npx vitest run __tests__/queue-find-by-work-item.test.ts __tests__/queue-registration.test.ts`
Expected: alle tests PASS.

- [ ] **Step 6: Volledige suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: exit 0 (pretest typecheckt `__tests__` al).

- [ ] **Step 7: Commit**

```bash
git add src/tools/queue-find-by-work-item.ts src/register.ts __tests__/queue-find-by-work-item.test.ts __tests__/queue-registration.test.ts
git commit -m "feat(queue): queue_find_by_work_item — product-guarded cross-adres-zoektool op meta.work_item"
```

---

## Review record

**Loop:** plan-fase, gestart 2026-08-20. Reviewers: `mac:claude` + `mac:codex`
(JP-armed listeners). Max 10 rondes. Spec-fase: dubbel GO in ronde 3 (zie de spec).

### Ronde 1 — uitstaand
