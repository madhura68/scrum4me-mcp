import { prisma } from '../src/prisma.js'
import {
  formatWorkerUsageCaptureSummary,
  summarizeWorkerUsageCapture,
  type WorkerUsageCaptureCanaryRow,
} from '../src/lib/job-usage/canary.js'

type Args = {
  hours: number
  limit: number
  allowEmpty: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { hours: 24, limit: 200, allowEmpty: false }

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--allow-empty') {
      args.allowEmpty = true
    } else if (value === '--hours') {
      const raw = argv[++i]
      const hours = Number(raw)
      if (!Number.isFinite(hours) || hours <= 0) throw new Error(`Invalid --hours: ${raw}`)
      args.hours = hours
    } else if (value === '--limit') {
      const raw = argv[++i]
      const limit = Number(raw)
      if (!Number.isInteger(limit) || limit <= 0) throw new Error(`Invalid --limit: ${raw}`)
      args.limit = limit
    } else {
      throw new Error(`Unknown argument: ${value}`)
    }
  }

  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const since = new Date(Date.now() - args.hours * 60 * 60 * 1000)

  const rows = await prisma.claudeJob.findMany({
    where: {
      runtime: 'CODEX',
      created_at: { gte: since },
      status: { in: ['DONE', 'FAILED', 'SKIPPED', 'CANCELLED'] },
    },
    orderBy: { created_at: 'desc' },
    take: args.limit,
    select: {
      id: true,
      status: true,
      runtime: true,
      model_id: true,
      pricing_model_id: true,
      input_tokens: true,
      output_tokens: true,
      cache_read_tokens: true,
      cache_write_tokens: true,
      usage_capture_status: true,
      usage_capture_error: true,
    },
  })

  const summary = summarizeWorkerUsageCapture(rows as WorkerUsageCaptureCanaryRow[])
  console.log(formatWorkerUsageCaptureSummary(summary))

  const onlyEmptyIssue =
    summary.issues.length === 1 && summary.issues[0].code === 'no_recent_codex_jobs'
  if (!summary.ok && !(args.allowEmpty && onlyEmptyIssue)) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
