import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

const MAX_SERIALIZATION_RETRIES = 3

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
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
    }
  }
}
