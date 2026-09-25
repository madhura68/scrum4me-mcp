// ISS-1: eenmalige reparatie voor stories die vastliepen omdat de story-rollup
// EXCLUDED-taken als openstaand werk telde.
//
// Zoekt stories met status OPEN/IN_SPRINT waarvan alle taken DONE of EXCLUDED
// zijn en minstens één taak EXCLUDED is, en draait de normale rollup (propagateStatusUpwards)
// opnieuw via één taak van die story, met diens huidige status. Zo lopen Story →
// PBI → Sprint → SprintRun via exact dezelfde regels als in productie.
//
// Standaard dry-run. Gebruik --apply om daadwerkelijk te schrijven.
//   DATABASE_URL=... npx tsx scripts/repair-excluded-story-rollup.ts [--apply]
import { prisma } from '../src/prisma.js'
import { propagateStatusUpwards } from '../src/lib/tasks-status-update.js'

const apply = process.argv.includes('--apply')

async function main() {
  const candidates = await prisma.story.findMany({
    where: {
      status: { in: ['OPEN', 'IN_SPRINT'] },
      // Minstens één EXCLUDED-taak: alleen dán is dit een ISS-1-geval. Stories
      // met uitsluitend DONE-taken die op OPEN staan hebben een andere oorzaak
      // en horen niet in deze reparatie.
      tasks: { some: { status: 'EXCLUDED' }, every: { status: { in: ['DONE', 'EXCLUDED'] } } },
    },
    select: {
      id: true,
      code: true,
      title: true,
      status: true,
      tasks: { select: { id: true, status: true }, orderBy: { sort_order: 'asc' } },
    },
    orderBy: { created_at: 'asc' },
  })

  console.log(`${candidates.length} vastgelopen stor${candidates.length === 1 ? 'y' : 'ies'} gevonden${apply ? '' : ' (dry-run)'}`)
  for (const s of candidates) {
    const counts = s.tasks.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1
      return acc
    }, {})
    console.log(`- ${s.code ?? s.id} [${s.status}] ${s.title} — ${JSON.stringify(counts)}`)
    if (!apply) continue

    const anchor = s.tasks.find((t) => t.status === 'DONE') ?? s.tasks[0]
    const r = await propagateStatusUpwards(anchor.id, anchor.status)
    console.log(
      `    story:${r.storyChanged ? 'DONE' : 'ongewijzigd'} pbi:${r.pbiChanged ? 'gewijzigd' : '-'} sprint:${r.sprintChanged ? 'gewijzigd' : '-'} sprintRun:${r.sprintRunChanged ? 'gewijzigd' : '-'}`,
    )
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
