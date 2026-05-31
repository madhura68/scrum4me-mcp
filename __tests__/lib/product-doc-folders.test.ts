import { describe, it, expect } from 'vitest'
import {
  PRODUCT_DOC_FOLDERS_API,
  PRODUCT_DOC_FOLDER_DESCRIPTIONS,
} from '../../src/lib/product-doc-folders.js'

describe('PRODUCT_DOC_FOLDER_DESCRIPTIONS', () => {
  it('has a non-empty description for every API folder', () => {
    for (const folder of PRODUCT_DOC_FOLDERS_API) {
      const desc = PRODUCT_DOC_FOLDER_DESCRIPTIONS[folder]
      expect(desc, `missing description for ${folder}`).toBeTruthy()
      expect(desc.length).toBeGreaterThan(10)
    }
  })

  it('has no descriptions for unknown folders', () => {
    expect(Object.keys(PRODUCT_DOC_FOLDER_DESCRIPTIONS).sort()).toEqual(
      [...PRODUCT_DOC_FOLDERS_API].sort(),
    )
  })
})
