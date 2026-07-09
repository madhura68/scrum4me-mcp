export type WorkerUsageCaptureCanaryRow = {
  id: string
  status: string
  runtime: string
  model_id: string | null
  pricing_model_id: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  usage_capture_status: string | null
  usage_capture_error?: string | null
}

export type WorkerUsageCaptureIssueCode =
  | 'no_recent_codex_jobs'
  | 'successful_missing_capture_status'
  | 'successful_non_captured_status'
  | 'successful_missing_pricing_model'
  | 'successful_missing_token_fields'

export type WorkerUsageCaptureIssue = {
  code: WorkerUsageCaptureIssueCode
  jobId: string | null
  detail: string
}

export type WorkerUsageCaptureCanarySummary = {
  ok: boolean
  total: number
  statusCounts: Record<string, number>
  captureStatusCounts: Record<string, number>
  failedWithoutUsageCount: number
  issues: WorkerUsageCaptureIssue[]
}

const SUCCESSFUL_STATUSES = new Set(['DONE'])

function captureStatusLabel(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : 'missing_capture_status'
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

function hasAnyTokenField(row: WorkerUsageCaptureCanaryRow): boolean {
  return (
    row.input_tokens != null ||
    row.output_tokens != null ||
    row.cache_read_tokens != null ||
    row.cache_write_tokens != null
  )
}

function isCodex(row: WorkerUsageCaptureCanaryRow): boolean {
  return row.runtime === 'CODEX'
}

export function summarizeWorkerUsageCapture(
  rows: WorkerUsageCaptureCanaryRow[],
): WorkerUsageCaptureCanarySummary {
  const statusCounts: Record<string, number> = {}
  const captureStatusCounts: Record<string, number> = {}
  const issues: WorkerUsageCaptureIssue[] = []
  let failedWithoutUsageCount = 0

  for (const row of rows) {
    if (!isCodex(row)) continue
    increment(statusCounts, row.status)
    increment(captureStatusCounts, captureStatusLabel(row.usage_capture_status))

    const hasTokens = hasAnyTokenField(row)
    if (row.status === 'FAILED' && !hasTokens) {
      failedWithoutUsageCount += 1
      continue
    }

    if (!SUCCESSFUL_STATUSES.has(row.status)) continue

    if (!row.usage_capture_status) {
      issues.push({
        code: 'successful_missing_capture_status',
        jobId: row.id,
        detail: 'Successful Codex job has no usage_capture_status.',
      })
    } else if (row.usage_capture_status !== 'captured') {
      issues.push({
        code: 'successful_non_captured_status',
        jobId: row.id,
        detail: `Successful Codex job has usage_capture_status=${row.usage_capture_status}.`,
      })
    }

    if (!row.pricing_model_id) {
      issues.push({
        code: 'successful_missing_pricing_model',
        jobId: row.id,
        detail: 'Successful Codex job has no pricing_model_id.',
      })
    }

    if (!hasTokens) {
      issues.push({
        code: 'successful_missing_token_fields',
        jobId: row.id,
        detail: 'Successful Codex job has no captured token fields.',
      })
    }
  }

  const total = Object.values(statusCounts).reduce((sum, count) => sum + count, 0)
  if (total === 0) {
    issues.push({
      code: 'no_recent_codex_jobs',
      jobId: null,
      detail: 'No recent Codex jobs were found for the canary window.',
    })
  }

  return {
    ok: issues.length === 0,
    total,
    statusCounts,
    captureStatusCounts,
    failedWithoutUsageCount,
    issues,
  }
}

export function formatWorkerUsageCaptureSummary(
  summary: WorkerUsageCaptureCanarySummary,
): string {
  const lines = [
    `Worker usage capture canary: ${summary.ok ? 'OK' : 'FAILED'}`,
    `Total Codex jobs: ${summary.total}`,
    'Job statuses:',
  ]

  for (const [status, count] of Object.entries(summary.statusCounts).sort()) {
    lines.push(`- ${status}: ${count}`)
  }

  lines.push('Capture statuses:')
  for (const [status, count] of Object.entries(summary.captureStatusCounts).sort()) {
    lines.push(`- ${status}: ${count}`)
  }

  lines.push(`Failed jobs without usage (informational): ${summary.failedWithoutUsageCount}`)

  if (summary.issues.length > 0) {
    lines.push('Issues:')
    for (const issue of summary.issues) {
      lines.push(`- ${issue.code}${issue.jobId ? ` (${issue.jobId})` : ''}: ${issue.detail}`)
    }
  }

  return lines.join('\n')
}
