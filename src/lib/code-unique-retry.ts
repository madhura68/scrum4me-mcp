import { Prisma } from '@prisma/client'

const MAX_CODE_UNIQUE_RETRIES = 3

function hasCodeUniqueTarget(error: unknown, constraintName: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target
  if (typeof target === 'string') return target === constraintName
  if (!Array.isArray(target) || target.length !== 2) return false
  return target.includes('product_id') && target.includes('code')
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
    }
  }
}
