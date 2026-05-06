import type { TaskStatus, StoryStatus } from '@prisma/client'

const TASK_DB_TO_API = {
  TO_DO: 'todo',
  IN_PROGRESS: 'in_progress',
  REVIEW: 'review',
  DONE: 'done',
  FAILED: 'failed',
} as const satisfies Record<TaskStatus, string>

const TASK_API_TO_DB: Record<string, TaskStatus> = {
  todo: 'TO_DO',
  in_progress: 'IN_PROGRESS',
  review: 'REVIEW',
  done: 'DONE',
  failed: 'FAILED',
}

const STORY_DB_TO_API = {
  OPEN: 'open',
  IN_SPRINT: 'in_sprint',
  DONE: 'done',
  FAILED: 'failed',
} as const satisfies Record<StoryStatus, string>

const STORY_API_TO_DB: Record<string, StoryStatus> = {
  open: 'OPEN',
  in_sprint: 'IN_SPRINT',
  done: 'DONE',
  failed: 'FAILED',
}

export type TaskStatusApi = (typeof TASK_DB_TO_API)[TaskStatus]
export type StoryStatusApi = (typeof STORY_DB_TO_API)[StoryStatus]

export function taskStatusToApi(s: TaskStatus): TaskStatusApi {
  return TASK_DB_TO_API[s]
}

export function taskStatusFromApi(s: string): TaskStatus | null {
  return TASK_API_TO_DB[s.toLowerCase()] ?? null
}

export function storyStatusToApi(s: StoryStatus): StoryStatusApi {
  return STORY_DB_TO_API[s]
}

export function storyStatusFromApi(s: string): StoryStatus | null {
  return STORY_API_TO_DB[s.toLowerCase()] ?? null
}

export const TASK_STATUS_API_VALUES = Object.values(TASK_DB_TO_API)
export const STORY_STATUS_API_VALUES = Object.values(STORY_DB_TO_API)
