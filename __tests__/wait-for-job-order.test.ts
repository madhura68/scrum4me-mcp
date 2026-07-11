import { describe, expect, it } from 'vitest'

import * as waitForJob from '../src/tools/wait-for-job.js'

describe('SPRINT_IMPLEMENTATION scope ordering', () => {
  it('builds the Prisma query in canonical PBI → story → task order', () => {
    const buildSprintScopeInclude = (
      waitForJob as unknown as {
        buildSprintScopeInclude?: () => unknown
      }
    ).buildSprintScopeInclude

    expect(buildSprintScopeInclude).toBeTypeOf('function')
    expect(buildSprintScopeInclude!()).toEqual({
      sprint: {
        include: {
          product: true,
          stories: {
            where: { status: { not: 'DONE' } },
            include: {
              pbi: {
                select: {
                  id: true,
                  code: true,
                  title: true,
                  priority: true,
                  sort_order: true,
                  created_at: true,
                  status: true,
                },
              },
              tasks: {
                where: { status: 'TO_DO' },
                orderBy: [
                  { sort_order: 'asc' },
                  { created_at: 'asc' },
                  { id: 'asc' },
                ],
              },
            },
            orderBy: [
              { pbi: { sort_order: 'asc' } },
              { pbi: { created_at: 'asc' } },
              { pbi: { id: 'asc' } },
              { sort_order: 'asc' },
              { created_at: 'asc' },
              { id: 'asc' },
            ],
          },
        },
      },
    })
  })
})
