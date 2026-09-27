import { apiTokenUsageUpdate, type TokenUsage } from '@shared/api-token-usage.js'
import { prisma } from './prisma.js'

/** Best effort, independently committed after the business action. No retries. */
export async function recordSuccessfulTokenUse(usage: TokenUsage): Promise<void> {
  try {
    const query = apiTokenUsageUpdate(usage)
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '500ms'")
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'")
      await tx.$executeRawUnsafe(query.text, ...query.values)
    }, { maxWait: 1000, timeout: 2000 })
  } catch {
    try { console.error('api_token_usage_write_failed interface=mcp code=WRITE_FAILED') } catch { /* nonfatal */ }
  }
}
