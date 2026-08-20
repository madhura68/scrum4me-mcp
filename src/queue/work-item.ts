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
