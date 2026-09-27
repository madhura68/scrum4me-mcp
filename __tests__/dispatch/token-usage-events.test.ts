import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { observeDispatchTokenUse } from '../../src/dispatch/token-usage.js'
import type { DispatchActor } from '../../src/dispatch/ports.js'

function fixture(source = 'bearer') {
  const res = Object.assign(new EventEmitter(), { statusCode: 200, destroyed: false, writableFinished: false })
  const req = { aborted: false } as Request
  const record = vi.fn(async () => {})
  const actor = { source, tokenId: source === 'bearer' ? 'token' : null, userId: 'user' } as DispatchActor
  const lifecycle = observeDispatchTokenUse(req, res as unknown as Response, actor, record)
  return { res, req, record, ...lifecycle }
}
describe('dispatch completion requires handler success and finish', () => {
  it.each(['finish-first', 'handler-first'])('%s records exactly once', async order => {
    const x = fixture()
    if (order === 'finish-first') x.res.emit('finish')
    x.succeeded()
    if (order === 'handler-first') expect(x.record).not.toHaveBeenCalled()
    x.res.emit('finish'); x.res.emit('finish'); x.succeeded()
    expect(x.record).toHaveBeenCalledTimes(1)
    expect(x.record).toHaveBeenCalledWith({ tokenId: 'token', userId: 'user', completedAt: expect.any(Date) })
  })
  it.each(['failure', 'close', 'error', 'abort', 'bad-status', 'finish-then-throw'])('excludes %s', mode => {
    const x = fixture()
    if (mode === 'failure') x.failed()
    if (mode === 'close') x.res.emit('close')
    if (mode === 'error') x.res.emit('error', new Error('transport'))
    if (mode === 'abort') x.req.aborted = true
    if (mode === 'bad-status') x.res.statusCode = 403
    if (mode === 'finish-then-throw') { x.res.emit('finish'); x.failed() }
    x.succeeded(); x.res.emit('finish')
    expect(x.record).not.toHaveBeenCalled()
  })
  it.each(['workers', 'web', 'agent-capability'])('excludes %s identities', source => {
    const x = fixture(source); x.succeeded(); x.res.emit('finish')
    expect(x.record).not.toHaveBeenCalled()
  })
  it('normal close after finish is not an abort of an already sent artifact', () => {
    const x = fixture(); x.res.emit('finish'); x.res.emit('close'); x.succeeded()
    expect(x.record).toHaveBeenCalledTimes(1)
  })
  it('handles a rejected writer without an unhandled rejection or changed action', async () => {
    const x = fixture(); x.record.mockRejectedValueOnce(new Error('db down'))
    x.succeeded(); x.res.emit('finish')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(x.record).toHaveBeenCalledTimes(1)
  })
})
