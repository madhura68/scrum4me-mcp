import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { extractPrRefs } from '../../src/lib/pr-refs.js'

// Echte PR-beschrijvingen van Forgejo (2026-10-04), ongewijzigd overgenomen.
const body = (name: string) =>
  readFileSync(new URL(`../fixtures/pr-bodies/${name}.md`, import.meta.url), 'utf8')

describe('extractPrRefs — echte PR-beschrijvingen', () => {
  it('Scrum4Me#297: PBI, story en planpad', () => {
    expect(extractPrRefs(body('Scrum4Me-297'))).toStrictEqual({
      task_codes: [],
      story_codes: ['ST-1629'],
      pbi_codes: ['PBI-178'],
      doc_paths: ['docs/plans/M43-landingspagina-showcase.md'],
    })
  })

  it('Scrum4Me#292: spec + plan, INDEX.md valt af', () => {
    expect(extractPrRefs(body('Scrum4Me-292'))).toStrictEqual({
      task_codes: [],
      story_codes: ['ST-1623', 'ST-1628'],
      pbi_codes: ['PBI-177'],
      doc_paths: [
        'docs/specs/2026-10-03-vis-design-migratie-design.md',
        'docs/plans/M42-vis-design-migratie.md',
      ],
    })
  })

  it('Ops-dashboard#280: codes uit een bereik, alleen het planpad', () => {
    expect(extractPrRefs(body('Ops-dashboard-280'))).toStrictEqual({
      task_codes: ['T-193', 'T-203'],
      story_codes: ['ST-073', 'ST-074'],
      pbi_codes: ['PBI-24'],
      doc_paths: ['docs/plans/M44-vis-ops-en-media.md'],
    })
  })

  it('scrum4me-mcp#180: één taakcode', () => {
    expect(extractPrRefs(body('scrum4me-mcp-180'))).toStrictEqual({
      task_codes: ['T-1972'],
      story_codes: [],
      pbi_codes: [],
      doc_paths: [],
    })
  })

  it('scrum4me-docker#106: geen verwijzingen', () => {
    expect(extractPrRefs(body('scrum4me-docker-106'))).toStrictEqual({
      task_codes: [],
      story_codes: [],
      pbi_codes: [],
      doc_paths: [],
    })
  })
})

describe('extractPrRefs — randgevallen', () => {
  it('T- matcht niet binnen ST-, en een code moet op een woordgrens eindigen', () => {
    const r = extractPrRefs('ST-1629 ST-1629abc T-5x')
    expect(r.story_codes).toStrictEqual(['ST-1629'])
    expect(r.task_codes).toStrictEqual([])
  })

  it('mijlpaalcodes worden genegeerd', () => {
    expect(extractPrRefs('M43 en M44')).toStrictEqual({
      task_codes: [], story_codes: [], pbi_codes: [], doc_paths: [],
    })
  })

  it('codes blijven exact zoals geschreven en worden ontdubbeld in volgorde van voorkomen', () => {
    expect(extractPrRefs('ST-073, T-2, ST-073, T-1, T-2').story_codes).toStrictEqual(['ST-073'])
    expect(extractPrRefs('ST-073, T-2, ST-073, T-1, T-2').task_codes).toStrictEqual(['T-2', 'T-1'])
  })

  it('weigert ongeldige paden', () => {
    const r = extractPrRefs([
      'docs/../plans/x.md',
      'docs/plans/../../x.md',
      'https://git.jp-visser.nl/janpeter/r/src/branch/main/docs/plans/a.md',
      'https://…/plan.md',
      'docs/INDEX.md',
      'docs/design/styling.md',
      'docs/plans/x.txt',
      `docs/plans/${'a'.repeat(200)}.md`,
    ].join('\n'))
    expect(r.doc_paths).toStrictEqual([])
  })

  it('strip backticks en markdown-links rond een pad', () => {
    expect(extractPrRefs('Zie `docs/plans/a.md` en [plan](docs/specs/b.md).').doc_paths)
      .toStrictEqual(['docs/plans/a.md', 'docs/specs/b.md'])
  })

  it('kapt elke lijst af op 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => `T-${i + 1}`).join(' ')
    const r = extractPrRefs(many)
    expect(r.task_codes).toHaveLength(20)
    expect(r.task_codes[19]).toBe('T-20')
  })

  it('lege of ontbrekende tekst geeft lege lijsten', () => {
    expect(extractPrRefs('')).toStrictEqual({
      task_codes: [], story_codes: [], pbi_codes: [], doc_paths: [],
    })
  })
})
