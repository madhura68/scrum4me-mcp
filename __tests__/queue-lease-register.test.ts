import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearLeases, getLease, leaseEntries, registerLease, releaseLease,
} from '../src/queue/lease-register.js'

beforeEach(() => clearLeases())

describe('lease-register — fase-3-interfacecontract (spec §5.4/§6.1)', () => {
  it('registreert en leest een lease per message_id', () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    expect(getLease('msg-1')).toEqual({ claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
  })

  it('geeft undefined voor onbekende ids', () => {
    expect(getLease('nope')).toBeUndefined()
  })

  it('verwijdert een lease met releaseLease', () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    releaseLease('msg-1')
    expect(getLease('msg-1')).toBeUndefined()
  })

  it('leaseEntries levert de platte vorm {messageId, claimToken, claimedBy} (fase-3-refresh-tick)', () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    registerLease('msg-2', { claimToken: 'tok-2', claimedBy: 'mcp:inst:tok-2' })
    expect(leaseEntries()).toEqual([
      { messageId: 'msg-1', claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' },
      { messageId: 'msg-2', claimToken: 'tok-2', claimedBy: 'mcp:inst:tok-2' },
    ])
  })

  it('clearLeases simuleert een verse proces-incarnatie', () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    clearLeases()
    expect(leaseEntries()).toEqual([])
  })

  it('overschrijft een bestaande entry bij herregistratie (herclaim door dit proces)', () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    registerLease('msg-1', { claimToken: 'tok-9', claimedBy: 'mcp:inst:tok-9' })
    expect(getLease('msg-1')?.claimToken).toBe('tok-9')
  })
})
