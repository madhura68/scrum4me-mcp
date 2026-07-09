export type HookInput = {
  session_id?: string
  transcript_path?: string
  tool_name?: string
  tool_input?: { job_id?: string; status?: string }
}

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type ContentBlock = { type?: string; name?: string }

export type TranscriptLine = {
  type?: string
  uuid?: string
  isSidechain?: boolean
  message?: {
    role?: string
    model?: string
    content?: ContentBlock[]
    usage?: Usage
  }
}

export type ComputedUsage = {
  model_id: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}

export type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type PersistJobUsageResult = 'skipped' | 'written' | 'noop'
