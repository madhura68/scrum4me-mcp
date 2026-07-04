// M17 DEPLOY-job (spec §3): pure-helper test voor de orchestration-key-builder.
// De volle maybeEnqueueDeployJob (transactie + lock + dedup) leunt op Prisma en
// wordt afgedekt in de interleaving-tests (__tests__/deploy-state-interleaving.test.ts).

import { describe, it, expect } from 'vitest'
import { buildDeployOrchestrationKey } from '../src/lib/dispatch/deploy-job.js'

describe('buildDeployOrchestrationKey', () => {
  it('bouwt auto:deploy:<owner>/<repo>#<idx>@<sha> uit een Forgejo-PR-url', () => {
    expect(
      buildDeployOrchestrationKey('https://git.jp-visser.nl/janpeter/Scrum4Me/pulls/91', 'abc123'),
    ).toBe('auto:deploy:janpeter/Scrum4Me#91@abc123')
  })

  it('valt terug op de volledige url bij onbekend formaat', () => {
    expect(buildDeployOrchestrationKey('https://x/y', 'abc')).toBe('auto:deploy:https://x/y@abc')
  })
})
