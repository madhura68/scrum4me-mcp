import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}))

import { prisma } from '../src/prisma.js'
import { PRESENCE_FRESH_SECONDS } from '@shared/queue-identity.js'
import {
  derivePresenceStatus,
  readPresenceBlockBestEffort,
  readPresenceViews,
  stampDrainPresenceBestEffort,
} from '../src/queue/presence.js'

const mockPrisma = prisma as unknown as {
  $queryRaw: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

// Dezelfde negen gevallen als de CLI-twin (s4m-queue test/presence-db.test.ts):
// dit is een tweede implementatie van spec §6.1 en moet exact hetzelfde antwoord
// geven, anders lezen CLI en MCP dezelfde tabel verschillend.
const NOW = new Date('2026-08-30T12:00:00Z')
const secAgo = (s: number) => new Date(NOW.getTime() - s * 1000)
const secAhead = (s: number) => new Date(NOW.getTime() + s * 1000)
const base = {
  watcherHeartbeatAt: secAgo(5),
  sessionExpectedBy: null,
  sessionAnnouncedAt: secAgo(60),
  sessionSignedOffAt: null,
  openClaims: 0,
  now: NOW,
}

describe('derivePresenceStatus (§6.1, volgorde bindend)', () => {
  it('geen rij/hartslag → weg', () => {
    expect(derivePresenceStatus({ ...base, watcherHeartbeatAt: null })).toBe('weg')
  })
  it(`hartslag ouder dan ${PRESENCE_FRESH_SECONDS}s → weg, ook mét open claim`, () => {
    expect(
      derivePresenceStatus({
        ...base,
        watcherHeartbeatAt: secAgo(PRESENCE_FRESH_SECONDS + 1),
        openClaims: 2,
      }),
    ).toBe('weg')
  })
  it('vers + open claim → bezig (ook zonder aanmelding)', () => {
    expect(derivePresenceStatus({ ...base, sessionAnnouncedAt: null, openClaims: 1 })).toBe('bezig')
  })
  it('poll-route: geen hartslag, expected_by in de toekomst, aangemeld → beschikbaar', () => {
    expect(
      derivePresenceStatus({ ...base, watcherHeartbeatAt: null, sessionExpectedBy: secAhead(300) }),
    ).toBe('beschikbaar')
  })
  it('poll-route: expected_by verstreken en geen hartslag → weg', () => {
    expect(
      derivePresenceStatus({ ...base, watcherHeartbeatAt: null, sessionExpectedBy: secAgo(1) }),
    ).toBe('weg')
  })
  it('vers + aangemeld + niets open → beschikbaar', () => {
    expect(derivePresenceStatus(base)).toBe('beschikbaar')
  })
  it('vers + afgemeld ná aanmelding → onbemand', () => {
    expect(derivePresenceStatus({ ...base, sessionSignedOffAt: secAgo(1) })).toBe('onbemand')
  })
  it('vers + nooit aangemeld → onbemand ("watcher leeft, niemand thuis")', () => {
    expect(derivePresenceStatus({ ...base, sessionAnnouncedAt: null })).toBe('onbemand')
  })
  it('heraanmelding ná afmelding → beschikbaar', () => {
    expect(
      derivePresenceStatus({ ...base, sessionAnnouncedAt: secAgo(5), sessionSignedOffAt: secAgo(30) }),
    ).toBe('beschikbaar')
  })
})

describe('readPresenceViews', () => {
  it('levert het view-shape met age_s en claimdetail', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        server: 'mac',
        model: 'claude',
        watcher_heartbeat_at: new Date(Date.now() - 10_000),
        watcher_started_at: new Date(Date.now() - 600_000),
        watcher_pid: 4242,
        watcher_types: ['task', 'info', 'review_request'],
        session_announced_at: new Date(Date.now() - 300_000),
        session_last_drain_at: null,
        session_signed_off_at: null,
        session_expected_by: null,
        open_claims: 0,
        oldest_claimed_at: null,
        claim_ids: null,
      },
    ])
    const [view] = await readPresenceViews()
    expect(view.address).toBe('mac:claude')
    expect(view.status).toBe('beschikbaar')
    expect(view.watcher?.pid).toBe(4242)
    expect(view.watcher?.age_s).toBeGreaterThanOrEqual(9)
    expect(view.watcher?.age_s).toBeLessThanOrEqual(11)
    expect(view.claims).toEqual({ open: 0, oldest_claimed_at: null, message_ids: [] })
  })

  it('geeft bij een vol filter zonder rij één synthetische weg-entry mét claimdetail', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([]) // presence-rijen: leeg
      .mockResolvedValueOnce([
        { open_claims: 2, oldest_claimed_at: new Date('2026-08-30T11:00:00Z'), claim_ids: ['a', 'b'] },
      ])
    const views = await readPresenceViews({ server: 'max2', model: 'codex' })
    expect(views).toHaveLength(1)
    expect(views[0].address).toBe('max2:codex')
    expect(views[0].status).toBe('weg')
    expect(views[0].watcher).toBeNull()
    expect(views[0].claims.open).toBe(2)
    expect(views[0].claims.message_ids).toEqual(['a', 'b'])
  })
})

describe('best-effort-contracten', () => {
  it('readPresenceBlockBestEffort retourneert null als de query gooit', async () => {
    mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('relation does not exist'))
    await expect(readPresenceBlockBestEffort('mac', 'claude')).resolves.toBeNull()
  })

  it('stampDrainPresenceBestEffort gooit nooit door bij een schrijffout', async () => {
    mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('relation does not exist'))
    await expect(stampDrainPresenceBestEffort('mac', 'claude')).resolves.toBeUndefined()
  })

  it('stampDrainPresenceBestEffort slaat het job-namespace over zonder te schrijven', async () => {
    await stampDrainPresenceBestEffort('scrum4us-job', 'cmxyzjobid1')
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })
})
