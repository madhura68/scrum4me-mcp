export type DispatchErrorCode =
  | 'DISPATCH_DATABASE_URL_REQUIRED'
  | 'DISPATCH_DATABASE_URL_INVALID'

export class DispatchError extends Error {
  readonly name = 'DispatchError'

  constructor(
    readonly code: DispatchErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options)
  }
}
