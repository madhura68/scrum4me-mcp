import { describe, it, expect } from 'vitest'
import {
  writeProductDoc,
  ProductDocWriteError,
  type WriteProductDocTx,
} from '../../src/lib/product-doc-write.js'

// The frontmatter parse runs before any DB access in writeProductDoc, so this
// dummy tx is never actually touched on the parse-failure paths under test.
const dummyTx = {} as unknown as WriteProductDocTx

const baseInput = {
  product_id: 'p1',
  folder: 'GRILLS' as const,
  slug: 'idea-115-grill',
  actor_user_id: 'u1',
}

async function captureWriteError(content_md: string): Promise<ProductDocWriteError> {
  const err = await writeProductDoc(dummyTx, { ...baseInput, content_md }).then(
    () => null,
    (e) => e as unknown,
  )
  expect(err).toBeInstanceOf(ProductDocWriteError)
  return err as ProductDocWriteError
}

describe('writeProductDoc parse-error message', () => {
  it('surfaces the offending field + value for an invalid status (not just the bare generic)', async () => {
    const err = await captureWriteError('---\ntitle: "worker id"\nstatus: grilled\n---\n\nbody')
    expect(err.code).toBe(422)
    // Names the offending field and the allowed set, so the agent can self-correct
    // (zod v4 reports the allowed options rather than echoing the bad value).
    expect(err.message).toContain('status')
    expect(err.message).toMatch(/draft/)
    // Enriched — must not collapse back to the opaque message.
    expect(err.message).not.toBe('content_md is niet parseerbaar')
  })

  it('reports the missing-frontmatter case clearly', async () => {
    const err = await captureWriteError('no frontmatter at all')
    expect(err.code).toBe(422)
    expect(err.message).toMatch(/frontmatter/i)
  })

  it('still keeps the structured errors array on details', async () => {
    const err = await captureWriteError('---\ntitle: "x"\nstatus: bogus\n---\n\nbody')
    expect(Array.isArray(err.details)).toBe(true)
    expect((err.details as unknown[]).length).toBeGreaterThan(0)
  })
})
