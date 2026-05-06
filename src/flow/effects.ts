// PBI-9 + PBI-47: declarative effects produced by pure transitions.
// Executor handles each effect idempotently; failures are logged, not thrown.

export type PauseContext = {
  pause_reason: 'MERGE_CONFLICT'
  pr_url: string
  pr_head_sha: string
  conflict_files: string[]
  claude_question_id: string
  resume_instructions: string
  paused_at: string
}

export type FlowEffect =
  | { type: 'RELEASE_WORKTREE_LOCKS'; jobId: string }
  | { type: 'ENABLE_AUTO_MERGE'; prUrl: string; expectedHeadSha: string }
  | { type: 'MARK_PR_READY'; prUrl: string }
  | {
      type: 'CREATE_CLAUDE_QUESTION'
      sprintRunId: string
      prUrl: string
      files: string[]
    }
  | { type: 'CLOSE_CLAUDE_QUESTION'; questionId: string }
  | {
      type: 'SET_SPRINT_RUN_STATUS'
      sprintRunId: string
      status: 'QUEUED' | 'RUNNING' | 'PAUSED' | 'DONE' | 'FAILED' | 'CANCELLED'
      pauseContextDraft?: Omit<PauseContext, 'claude_question_id'>
      clearPauseContext?: boolean
    }

export type AutoMergeOutcome =
  | { effect: 'ENABLE_AUTO_MERGE'; ok: true }
  | {
      effect: 'ENABLE_AUTO_MERGE'
      ok: false
      reason: 'CHECKS_FAILED' | 'MERGE_CONFLICT' | 'GH_AUTH_ERROR' | 'AUTO_MERGE_NOT_ALLOWED' | 'UNKNOWN'
      stderr: string
    }

/**
 * Execute a list of effects in order. Returns outcome objects only for
 * effects whose result the caller needs to react to (auto-merge fail
 * triggers MERGE_CONFLICT-event in update-job-status). Other failures
 * are logged but swallowed.
 *
 * CREATE_CLAUDE_QUESTION → SET_SPRINT_RUN_STATUS chains: the question_id
 * created in the first effect is injected into the pause_context of the
 * second.
 */
export async function executeEffects(
  effects: FlowEffect[],
): Promise<AutoMergeOutcome[]> {
  const outcomes: AutoMergeOutcome[] = []
  let lastQuestionId: string | undefined
  for (const effect of effects) {
    try {
      if (effect.type === 'CREATE_CLAUDE_QUESTION') {
        lastQuestionId = await createOrReuseClaudeQuestion(effect)
        continue
      }
      if (effect.type === 'SET_SPRINT_RUN_STATUS') {
        await applySprintRunStatus(effect, lastQuestionId)
        continue
      }
      const outcome = await executeEffect(effect)
      if (outcome) outcomes.push(outcome)
    } catch (err) {
      console.warn(`[effects] effect ${effect.type} failed (idempotent skip):`, err)
    }
  }
  return outcomes
}

async function executeEffect(effect: FlowEffect): Promise<AutoMergeOutcome | undefined> {
  switch (effect.type) {
    case 'RELEASE_WORKTREE_LOCKS': {
      const { releaseLocksOnTerminal } = await import('../git/job-locks.js')
      await releaseLocksOnTerminal(effect.jobId)
      return undefined
    }
    case 'ENABLE_AUTO_MERGE': {
      const { enableAutoMergeOnPr } = await import('../git/pr.js')
      const result = await enableAutoMergeOnPr({
        prUrl: effect.prUrl,
        expectedHeadSha: effect.expectedHeadSha,
      })
      if (result.ok) return { effect: 'ENABLE_AUTO_MERGE', ok: true }
      return { effect: 'ENABLE_AUTO_MERGE', ok: false, reason: result.reason, stderr: result.stderr }
    }
    case 'MARK_PR_READY': {
      const { markPullRequestReady } = await import('../git/pr.js')
      const result = await markPullRequestReady({ prUrl: effect.prUrl })
      if ('error' in result) {
        console.warn(`[effects] MARK_PR_READY failed for ${effect.prUrl}: ${result.error}`)
      }
      return undefined
    }
    case 'CLOSE_CLAUDE_QUESTION': {
      const { prisma } = await import('../prisma.js')
      await prisma.claudeQuestion.updateMany({
        where: { id: effect.questionId, status: 'open' },
        data: { status: 'closed' },
      })
      return undefined
    }
    // CREATE_CLAUDE_QUESTION + SET_SPRINT_RUN_STATUS handled in executeEffects.
    case 'CREATE_CLAUDE_QUESTION':
    case 'SET_SPRINT_RUN_STATUS':
      return undefined
  }
}

async function createOrReuseClaudeQuestion(effect: {
  sprintRunId: string
  prUrl: string
  files: string[]
}): Promise<string> {
  const { prisma } = await import('../prisma.js')

  // Reuse existing open question for the same SprintRun + PR if present.
  const existing = await prisma.claudeQuestion.findFirst({
    where: {
      status: 'open',
      options: { path: ['sprint_run_id'], equals: effect.sprintRunId } as never,
    },
    orderBy: { created_at: 'desc' },
    select: { id: true },
  })
  if (existing) return existing.id

  // Need product_id + asker (user) to create. Resolve via SprintRun.
  const sprintRun = await prisma.sprintRun.findUnique({
    where: { id: effect.sprintRunId },
    select: {
      started_by_id: true,
      sprint: { select: { product_id: true } },
    },
  })
  if (!sprintRun) {
    throw new Error(`SprintRun ${effect.sprintRunId} not found`)
  }

  const fileList =
    effect.files.length === 0
      ? '(unknown files — check the PR)'
      : effect.files.slice(0, 5).join(', ')
        + (effect.files.length > 5 ? ` + ${effect.files.length - 5} more` : '')

  const created = await prisma.claudeQuestion.create({
    data: {
      product_id: sprintRun.sprint.product_id,
      asked_by: sprintRun.started_by_id,
      question:
        `Merge-conflict on ${effect.prUrl}. Conflict files: ${fileList}. `
        + `Resolve on the branch and push, then resume the sprint.`,
      options: {
        sprint_run_id: effect.sprintRunId,
        pr_url: effect.prUrl,
        conflict_files: effect.files,
      },
      status: 'open',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
    select: { id: true },
  })
  return created.id
}

async function applySprintRunStatus(
  effect: Extract<FlowEffect, { type: 'SET_SPRINT_RUN_STATUS' }>,
  lastQuestionId: string | undefined,
): Promise<void> {
  const { prisma, Prisma } = await (async () => {
    const mod = await import('../prisma.js')
    const prismaPkg = await import('@prisma/client')
    return { prisma: mod.prisma, Prisma: prismaPkg.Prisma }
  })()

  const data: Record<string, unknown> = { status: effect.status }
  if (effect.pauseContextDraft && lastQuestionId) {
    data.pause_context = {
      ...effect.pauseContextDraft,
      claude_question_id: lastQuestionId,
    }
  }
  if (effect.clearPauseContext) {
    data.pause_context = Prisma.JsonNull
  }
  await prisma.sprintRun.update({ where: { id: effect.sprintRunId }, data })
}
