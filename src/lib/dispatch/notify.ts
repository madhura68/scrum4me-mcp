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
  await prisma.$executeRaw`
    SELECT pg_notify('scrum4me_changes', ${JSON.stringify({
      type: 'claude_job_enqueued',
      status: 'queued',
      ...payload,
    })}::text)
  `
}
