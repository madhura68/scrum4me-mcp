import { Prisma } from '@prisma/client'
import { driverAdapterCause, UNIQUE_VIOLATION } from './prisma-driver-error.js'
import { backoffDelayMs, sleep } from './retry-backoff.js'

const MAX_CODE_UNIQUE_RETRIES = 3

function isProductCodePair(fields: unknown): boolean {
  return (
    Array.isArray(fields) &&
    fields.length === 2 &&
    fields.includes('product_id') &&
    fields.includes('code')
  )
}

function hasCodeUniqueTarget(error: unknown, constraintName: string): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = (error.meta as { target?: unknown } | undefined)?.target
    if (typeof target === 'string') return target === constraintName
    if (Array.isArray(target)) return isProductCodePair(target)
  }
  // Driver-adapter shape: no meta.target, constraint under the adapter cause.
  const cause = driverAdapterCause(error)
  if (cause?.originalCode !== UNIQUE_VIOLATION) return false
  const fields = cause.constraint?.fields
  if (fields !== undefined) return isProductCodePair(fields)
  // adapter-pg only fills `fields` when Postgres sent a DETAIL line; without it
  // the index name in the original message is the one thing left to match.
  return cause.originalMessage?.includes(constraintName) ?? false
}

export async function withCodeUniqueRetry<T>(
  constraintName: string,
  run: () => Promise<T>,
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await run()
    } catch (error) {
      if (!hasCodeUniqueTarget(error, constraintName) || retry >= MAX_CODE_UNIQUE_RETRIES) {
        throw error
      }
      await sleep(backoffDelayMs(retry))
    }
  }
}
