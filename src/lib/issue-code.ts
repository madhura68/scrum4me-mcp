// Port van Scrum4Me lib/issue-code-server.ts — atomaire per-PRODUCT issue-codes.
// Counter-increment pakt een row-lock; raw-SQL numerieke MAX vangt drift
// (string-MAX sorteert "ISS-1000" < "ISS-999" verkeerd, daarom CAST).
// Padding-loos, net als sprintcodes (spec 2026-08-16 §4).
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

export function formatIssueCode(n: number): string {
  return `ISS-${n}`
}

// P2002 niet verwacht: de product-row-lock van de counter-increment serialiseert
// concurrent calls per product — daarom geen retry-loop zoals create_pbi die heeft.
export async function nextIssueCode(
  productId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string> {
  const p = await client.product.update({
    where: { id: productId },
    data: { issue_code_counter: { increment: 1 } },
    select: { issue_code_counter: true },
  })

  const rows = await client.$queryRaw<
    [{ max_n: number | bigint | null }]
  >`
    SELECT MAX(CAST(SUBSTRING(code FROM '^ISS-([0-9]+)$') AS INTEGER)) AS max_n
    FROM issues
    WHERE product_id = ${productId}
      AND code ~ '^ISS-[0-9]+$'
  `
  const maxExisting = rows[0].max_n !== null ? Number(rows[0].max_n) : 0
  const nextN = Math.max(p.issue_code_counter, maxExisting + 1)

  if (nextN !== p.issue_code_counter) {
    await client.product.update({
      where: { id: productId },
      data: { issue_code_counter: nextN },
      select: { id: true },
    })
  }

  return formatIssueCode(nextN)
}
