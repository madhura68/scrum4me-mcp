// Regressieguard voor de leeskant van de queue: de gedeelde presentatielaag
// (messageView + toolJson) mag een body NOOIT HTML-escapen.
//
// Aanleiding (2026-07-27): max2 kreeg de body van bericht 8ceedd5d binnen met
// `&lt;`, `&gt;` en `&amp;` in plaats van `<`, `>` en `&`, terwijl de kolom in
// Postgres aantoonbaar schoon was (7×`<`, 7×`>`, 3×`&`, nul entiteiten) en de
// CLI dezelfde rij schoon uitleverde. De MCP bleek niet de boosdoener, maar dat
// kostte een meetronde over drie hosts om vast te stellen. Deze test maakt die
// vraag voortaan in één run beantwoordbaar.
//
// Waarom dit ertoe doet: queue-berichten bevatten routinematig `<server>:<model>`,
// `&&` en shell-fragmenten. Wie een ontvangen body naar schijf schrijft — precies
// wat de rules-file-sync doet — schrijft bij escaping `&lt;` naar het bestand.
// Zonder sha-verificatie is dat stil.
import { describe, it, expect } from 'vitest'

import { messageView, type QueueMessageLike } from '../src/queue/view.js'
import { toolJson } from '../src/errors.js'

// De echte vormen uit de queue, inclusief de discriminant op de laatste regel.
const CANARY_BODY = [
  'A: a <b> & c && d',
  'B: <server / model / mac / max2 / jp>',
  'C: source <env-file> && s4m-queue inbox --as claude',
  'D: **Claims & leases:** requeue <id>',
  // Discriminant: al-geëscapete tekst. Een escape-pass maakt hier `&amp;lt;`
  // van. Zonder deze regel ziet een test met alleen rauwe tekens het verschil
  // tussen "niet ge-escaped" en "één keer ge-escaped" wél, maar het verschil
  // tussen één en twee lagen niet.
  'E: pre-escaped: &lt; &amp; &gt;',
  'F: quotes: "dq" \'sq\'',
].join('\n')

const HTML_ENTITIES = ['&lt;', '&gt;', '&amp;', '&quot;', '&#39;'] as const

function row(body: string): QueueMessageLike {
  return {
    id: 'aaaaaaaa-0000-4000-8000-00000000e001',
    type: 'task',
    from_server: 'mac',
    from_model: 'claude',
    to_server: 'max2',
    to_model: 'claude',
    body,
    meta: {},
    status: 'pending',
    in_reply_to: null,
    error: null,
    claimed_by: null,
    archived_at: null,
    created_at: new Date('2026-07-27T00:00:00.000Z'),
    finished_at: null,
  }
}

describe('queue-leeskant: entiteit-transparantie (messageView + toolJson)', () => {
  it('messageView geeft de body byte-identiek door', () => {
    expect(messageView(row(CANARY_BODY)).body).toBe(CANARY_BODY)
  })

  it('toolJson-serialisatie overleeft een round-trip byte-identiek', () => {
    const serialized = toolJson({ message: messageView(row(CANARY_BODY)) })
    const text = serialized.content[0] as { type: 'text'; text: string }
    const parsed = JSON.parse(text.text) as { message: { body: string } }

    expect(parsed.message.body).toBe(CANARY_BODY)
    // structuredContent is een tweede uitgang naar de client — die mag niet
    // stilletjes van de tekst-uitgang afwijken.
    const structured = serialized.structuredContent as { message: { body: string } }
    expect(structured.message.body).toBe(CANARY_BODY)
  })

  it('introduceert geen enkele HTML-entiteit die niet al in de bron stond', () => {
    const serialized = toolJson({ message: messageView(row(CANARY_BODY)) })
    const text = (serialized.content[0] as { type: 'text'; text: string }).text
    const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

    for (const entity of HTML_ENTITIES) {
      expect(
        count(text, entity),
        `entiteit ${entity} vaker aanwezig na serialisatie dan in de bron`,
      ).toBe(count(CANARY_BODY, entity))
    }
  })

  it('escapet al-geëscapete tekst niet nog een keer (&lt; blijft &lt;, wordt geen &amp;lt;)', () => {
    const serialized = toolJson({ message: messageView(row(CANARY_BODY)) })
    const parsed = JSON.parse(
      (serialized.content[0] as { type: 'text'; text: string }).text,
    ) as { message: { body: string } }

    expect(parsed.message.body).toContain('E: pre-escaped: &lt; &amp; &gt;')
    expect(parsed.message.body).not.toContain('&amp;lt;')
  })

  it('laat de rauwe tekens staan die shell- en adresfragmenten dragen', () => {
    const parsed = JSON.parse(
      (toolJson({ message: messageView(row(CANARY_BODY)) }).content[0] as { text: string }).text,
    ) as { message: { body: string } }
    const body = parsed.message.body

    expect(body).toContain('<server / model / mac / max2 / jp>')
    expect(body).toContain('&& s4m-queue inbox')
    expect(body).toContain('**Claims & leases:**')
    expect(body).toContain('requeue <id>')
  })
})
