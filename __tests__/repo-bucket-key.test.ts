import { describe, it, expect } from 'vitest'
import { repoBucketKey } from '../src/lib/dispatch/sprint-batch-deploy.js'

const PRODUCT = 'https://git.jp-visser.nl/janpeter/Scrum4Me'

describe('repoBucketKey(repoUrl, productRepoUrl)', () => {
  it('null/undefined/leeg/whitespace → null (product-bucket)', () => {
    expect(repoBucketKey(null, PRODUCT)).toBeNull()
    expect(repoBucketKey(undefined, PRODUCT)).toBeNull()
    expect(repoBucketKey('', PRODUCT)).toBeNull()
    expect(repoBucketKey('   ', PRODUCT)).toBeNull()
  })
  it('de EXPLICIETE product-repo-url → null (zelfde product-bucket)', () => {
    expect(repoBucketKey(PRODUCT, PRODUCT)).toBeNull()
    expect(repoBucketKey(PRODUCT + '.git', PRODUCT)).toBeNull() // .git-suffix genormaliseerd
  })
  it('een andere repo-url → die url (eigen bucket)', () => {
    const other = 'https://git.jp-visser.nl/janpeter/scrum4me-mcp'
    expect(repoBucketKey(other, PRODUCT)).toBe(other)
  })
  it('null en de product-url leveren dezelfde bucket (regressie STORY/auto-PR)', () => {
    expect(repoBucketKey(null, PRODUCT)).toBe(repoBucketKey(PRODUCT, PRODUCT))
  })
})
