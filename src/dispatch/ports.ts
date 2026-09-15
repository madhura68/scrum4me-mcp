import type {
  AttemptProof,
  DispatchInput,
  DispatchProfileConfig,
  DispatchRuntime,
  PublishMode,
  StopEvidence,
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

export type RuntimeScope = {
  scopeId: string
  bootId: string
  imageDigest: string
  profileSha256: string
}

export type ExecutionContext = {
  input: DispatchInput
  profile: DispatchProfileConfig
  proof: AttemptProof
  sourceArtifacts: { key: string; artifactId: string; sha256: string }[]
  modelConfig: { model: string; effort: string | null; runtime: DispatchRuntime }
}

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
