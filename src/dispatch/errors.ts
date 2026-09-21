export type DispatchErrorCode =
  | 'DISPATCH_DATABASE_URL_REQUIRED' | 'DISPATCH_DATABASE_URL_INVALID'
  | 'DISPATCH_UNAUTHENTICATED' | 'DISPATCH_FORBIDDEN' | 'DISPATCH_NOT_FOUND'
  | 'DISPATCH_IDEMPOTENCY_CONFLICT' | 'DISPATCH_STATE_CONFLICT'
  | 'DISPATCH_INVALID_INPUT' | 'DISPATCH_BAD_JSON' | 'DISPATCH_TOO_LARGE'
  | 'DISPATCH_ASSERTION_KEY_INVALID' | 'DISPATCH_CLIENT_CONFIG_INVALID'
  | 'DISPATCH_TRANSPORT_ERROR' | 'DISPATCH_UNSUPPORTED_ENCODING'

export class DispatchError extends Error {
  readonly name = 'DispatchError'
  constructor(readonly code: DispatchErrorCode, options?: ErrorOptions) { super(code, options) }
}

export function dispatchHttpStatus(error: DispatchError): number {
  switch (error.code) {
    case 'DISPATCH_UNAUTHENTICATED': return 401
    case 'DISPATCH_FORBIDDEN': return 403
    case 'DISPATCH_NOT_FOUND': return 404
    case 'DISPATCH_IDEMPOTENCY_CONFLICT': case 'DISPATCH_STATE_CONFLICT': return 409
    case 'DISPATCH_INVALID_INPUT': case 'DISPATCH_UNSUPPORTED_ENCODING': return 422
    case 'DISPATCH_BAD_JSON': return 400
    case 'DISPATCH_TOO_LARGE': return 413
    default: return 500
  }
}
