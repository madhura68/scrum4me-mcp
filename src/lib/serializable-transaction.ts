import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { driverAdapterCause, SERIALIZATION_FAILURE } from './prisma-driver-error.js'
import { backoffDelayMs, sleep } from './retry-backoff.js'

const MAX_SERIALIZATION_RETRIES = 3

function isSerializationConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true
  // A 40001 raised at COMMIT escapes bare, without ever becoming P2034.
  return driverAdapterCause(error)?.originalCode === SERIALIZATION_FAILURE
}

export async function withSerializableRetry<T>(
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await prisma.$transaction(run, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (!isSerializationConflict(error) || retry >= MAX_SERIALIZATION_RETRIES) {
        throw error
      }
      await sleep(backoffDelayMs(retry))
    }
  }
}
