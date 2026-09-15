import type {
  AttemptProof,
  DispatchInput,
  DispatchProfileConfig,
  DispatchRuntime,
  PublishMode,
  StopEvidence,
  DispatchState,
  AttemptState,
} from '@shared/queue-dispatch.js'

export type DispatchActor = {
  userId: string
  principalKey: string
  tokenId: string | null
  source: 'bearer' | 'workers' | 'web'
  isDemo: boolean
  scopedProducts: string[]
  scopedRepos: string[]
  tokenKind: string | null
}

export type { DispatchRuntimeScope as RuntimeScope, DispatchStartPermit } from '@shared/queue-dispatch-start-permit.js'
import type { DispatchRuntimeScope as RuntimeScope } from '@shared/queue-dispatch-start-permit.js'

export type ExecutionContext = {
  input: DispatchInput
  profile: DispatchProfileConfig
  proof: AttemptProof
  sourceArtifacts: { key: string; artifactId: string; sha256: string }[]
  modelConfig: { model: string; effort: string | null; runtime: DispatchRuntime }
}

type ClaimStatus = { requestId: string; attemptId: string; requestState: DispatchState; attemptState: AttemptState }
/** Replay is status-aware: only prepare can create a scope; existing_scope must
 * inspect/reconcile the already known scope and never launch a second child. */
export type DispatchClaimReceipt = ClaimStatus & (
  | { authority: 'prepare'; scopeId: null; context: ExecutionContext }
  | { authority: 'existing_scope'; scopeId: string; context: ExecutionContext }
  | { authority: 'none'; scopeId: string | null; context: null }
)

export interface RuntimePort {
  prepare(context: ExecutionContext): Promise<RuntimeScope>
  start(scope: RuntimeScope): Promise<void>
  stop(scope: RuntimeScope): Promise<StopEvidence>
  inspect(scope: RuntimeScope): Promise<'created' | 'running' | 'stopped' | 'unknown'>
}

export interface PublisherPort {
  publish(input: {
    requestId: string
    attemptId: string
    artifactId: string
    productId: string
    baseSha: string
    headSha: string
    mode: PublishMode
  }): Promise<{ branch: string; prUrl: string | null }>
}
