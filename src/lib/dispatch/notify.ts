// Zelfde pg_notify als Scrum4Me actions/ideas.ts ná job-enqueue, zodat
// realtime-consumers copilot-jobs net zo zien als web-jobs. Buiten de
// transactie aanroepen (pas ná commit zichtbaar werk melden).
import { prisma } from '../../prisma.js'

export async function notifyJobEnqueued(payload: {
  job_id: string
  user_id: string
  product_id: string
  kind: string
  idea_id?: string
}): Promise<void> {
  // Best-effort: de job is op dit punt al gecommit. Een falende notify mag
  // nooit als dispatch-fout naar de caller lekken (zelfde redenatie als de
  // non-fatale notify in update-job-status); loggen en doorgaan.
  try {
    await prisma.$executeRaw`
      SELECT pg_notify('scrum4me_changes', ${JSON.stringify({
        type: 'claude_job_enqueued',
        status: 'queued',
        ...payload,
      })}::text)
    `
  } catch (err) {
    console.error('notifyJobEnqueued failed (job is al gecommit):', err)
  }
}
