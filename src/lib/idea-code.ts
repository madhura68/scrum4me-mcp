// Port van Scrum4Me lib/idea-code(-server).ts — atomaire per-user idea-codes.
// Counter-increment pakt een row-lock; raw-SQL numerieke MAX vangt drift
// (string-MAX sorteert "IDEA-1000" < "IDEA-999" verkeerd, daarom CAST).
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

const PAD = 3

export function formatIdeaCode(n: number): string {
  return `IDEA-${String(n).padStart(PAD, '0')}`
}

// P2002 niet verwacht: de user-row-lock van de counter-increment serialiseert
// concurrent calls per user — daarom geen retry-loop zoals create_pbi die heeft.
export async function nextIdeaCode(
  userId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string> {
  const u = await client.user.update({
    where: { id: userId },
    data: { idea_code_counter: { increment: 1 } },
    select: { idea_code_counter: true },
  })

  const rows = await client.$queryRaw<
    [{ max_n: number | bigint | null }]
  >`
    SELECT MAX(CAST(SUBSTRING(code FROM '^IDEA-([0-9]+)$') AS INTEGER)) AS max_n
    FROM ideas
    WHERE user_id = ${userId}
      AND code ~ '^IDEA-[0-9]+$'
  `
  const maxExisting = rows[0].max_n !== null ? Number(rows[0].max_n) : 0
  const nextN = Math.max(u.idea_code_counter, maxExisting + 1)

  if (nextN !== u.idea_code_counter) {
    await client.user.update({
      where: { id: userId },
      data: { idea_code_counter: nextN },
      select: { id: true },
    })
  }

  return formatIdeaCode(nextN)
}
