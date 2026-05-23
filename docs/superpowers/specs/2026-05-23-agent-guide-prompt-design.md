---
title: Agent-guide — aanpasbare bouw- & documenteer-instructies via MCP
status: draft
author: janpetervisser
version: 0.2
date: 2026-05-23
review: ../reviews/2026-05-23-agent-guide-prompt-design-review.md
---

# Agent-guide: aanpasbare bouw- & documenteer-prompt via MCP

## Context

Vandaag krijgt een Scrum4Me-worker zijn instructies uit twee bronnen:

1. **Kind-prompts** (`src/prompts/<kind>/*.md`, geladen via `getKindPromptText()` in
   `src/lib/kind-prompts.ts`) — de onaantastbare orchestratie per job-kind, door de
   docker-runner als `claude -p`-prompt meegegeven. Niet per-product aanpasbaar.
2. **`get_claude_context(product_id)`** (`src/tools/get-claude-context.ts`) — levert
   alléén data (product, sprint, next_story, open_ideas). **Geen** instructie over
   *hoe* te bouwen of documenteren.

Er is geen plek waar een gebruiker een **aanpasbare, per-product** uitleg van het
bouw- & documenteer-proces kwijt kan — een soort "CLAUDE.md per product". Dit
ontwerp voegt die laag toe, geleverd via een draagbaar (worker-agnostisch) MCP-kanaal,
zodat het ook werkt als er in de toekomst andere workers dan Claude bijkomen.

## Doelen

- Een **aanpasbare** markdown-prompt die het bouw- & documenteer-proces uitlegt,
  fungerend als CLAUDE.md-equivalent.
- **Gelaagd**: een globale default + een per-product override (project-specifiek wint).
- **Worker-agnostisch geleverd**: de canonieke bron is een MCP-**tool** (de enige
  MCP-primitieve die elke client ondersteunt), niet client-specifieke
  system-prompt-injectie.
- Bereikt **beide** consumenten: de autonome docker-runner-worker én interactief
  Claude Code.

## Vastgelegde keuzes (uit brainstorm)

| Beslissing | Keuze |
|---|---|
| Consument | Autonome workers **én** interactief |
| Opslag | TS-module default + per-product override als ProductDoc (versioned) |
| Scope | Globale default + per-product override |
| Universaliteit nu | Alleen de **agent-guide** tool-sourced; kind-orchestratie blijft via de Claude-runner |
| Merge-semantiek | Layered-append (globaal eerst, product-sectie als laatste → wint bij conflict) |

## Review-aanpassingen (v0.2)

Naar aanleiding van de codex-review (zie `review:` frontmatter), na verificatie tegen
de code:

- **Default als TS-module i.p.v. runtime `.md`** — `tsc` kopieert geen `.md` naar
  `dist`. De runner draait uit `/opt/scrum4me-mcp/src/` (tsx) en is daarom veilig,
  maar de MCP-server kan uit `dist/` draaien (`node dist/http.js`) — en juist daar
  draait de resolver. Een TS-module compileert normaal mee en werkt in beide gevallen.
- **Allowlist** — `mcp__scrum4me__get_agent_guide` toevoegen aan `TASK_TOOLS`
  (`src/lib/job-config.ts`), anders blokkeert `--allowedTools` de aanroep in de runner.
- **Bindende status/folder** — alleen `status = active` + folder `MANUAL` enabled telt
  als override; draft/deprecated/archived wordt genegeerd.
- **Grootte-limiet** — harde max op de gemergede guide + fail-fast (niet stil afkappen).
- **Registratie** — expliciet in `registerSharedTools()` zodat HTTP de tool serveert.

## Ontwerp

### 1. Opslag (model-agnostisch)

- **Globale default**: een TypeScript-module `src/lib/agent-guide-default.ts` die een
  `AGENT_GUIDE_DEFAULT`-string exporteert. **Bewust géén runtime `.md`-read** — zie
  Review-aanpassingen. Bewerkbaar via repo-PR.
- **Per-product override**: een gewone `ProductDoc` in folder `MANUAL` met vaste slug
  `agent-guide`. Aangemaakt/bewerkt via de bestaande doc-tooling
  (`create_product_doc` / update) + de Scrum4Me-UI. Krijgt gratis revisiehistorie via
  `ProductDocRevision`.
- **Bindende voorwaarden voor de override**:
  - `status = active` (een draft/deprecated/archived doc bindt niet → val terug op
    globaal). `content_md` is verplicht en wordt door `create_product_doc` al begrensd
    op 100k tekens.
  - `Product.enabled_doc_folders` bevat `MANUAL`. Staat `MANUAL` uit, dan **geen**
    product-override (minst verrassend voor een bindende guide).

### 2. Resolver (gedeeld, één bron van waarheid)

Nieuw bestand `src/lib/agent-guide.ts`:

```ts
const AGENT_GUIDE_MAX_CHARS = 16_000  // gemergede guide

resolveAgentGuide(productId): Promise<{
  guide_md: string            // gemergede tekst (globaal + evt. product)
  has_product_override: boolean
  product_doc: { slug, status, updated_at } | null
}>
```

- Neemt de globale default uit `AGENT_GUIDE_DEFAULT`.
- Zoekt de override via een **eigen** Prisma-query (niet de `get_product_doc`-handler):
  `productDoc.findFirst({ where: { product_id, folder: MANUAL, slug: 'agent-guide',
  status: 'active' } })`, en alleen als `enabled_doc_folders` `MANUAL` bevat.
- **Merge (layered-append)**:

  ```
  <AGENT_GUIDE_DEFAULT>

  ---

  ## Product-specifieke aanvullingen — <product.code/name>
  <product override md>        (alleen als geldige override bestaat)
  ```

  De product-sectie staat als laatste; bij tegenstrijdige instructies wint die door
  positie. Echte sectie-niveau merge is bewust **out of scope** (YAGNI).
- **Grootte-gate**: als de gemergede `guide_md` > `AGENT_GUIDE_MAX_CHARS`, gooi een
  typed error `AGENT_GUIDE_TOO_LARGE` — **niet** stil afkappen (halve instructies
  mogen niet bindend lijken).

### 3. Delivery (tool = single source of truth)

- **Nieuwe tool `get_agent_guide(product_id)`** (`src/tools/get-agent-guide.ts`,
  `readOnlyHint: true`) → roept `resolveAgentGuide` aan en retourneert het object
  hierboven. Dit is de canonieke, universele bron — elke MCP-worker kan 'm aanroepen.
  Bij `AGENT_GUIDE_TOO_LARGE` **propageert** de tool de error hard (de worker moet
  geldige bindende instructies krijgen of expliciet falen).
- **`get_claude_context`** (`src/tools/get-claude-context.ts`) krijgt een extra veld
  `agent_guide: <guide_md>` via dezelfde resolver. **Graceful degrade**: faalt de
  resolver (bv. te groot), dan `agent_guide: null` + `agent_guide_error: <msg>` i.p.v.
  de hele context-call te laten falen — interactieve context blijft werken.
- **MCP `instructions`** (constant `INSTRUCTIONS`, `src/http.ts:38`; inline in
  `src/index.ts:31`) krijgt één **bootstrap-pointer**-regel (géén inhoud), bv.:
  *"Roep `get_agent_guide(product_id)` aan en volg de `guide_md` voordat je bouwt of
  documenteert."* Eerst de inline-versie in `index.ts` en de constant in `http.ts`
  naar één gedeelde constant trekken, dan de regel toevoegen.
- **Allowlist** — voeg `mcp__scrum4me__get_agent_guide` toe aan `TASK_TOOLS`
  (`src/lib/job-config.ts:55-74`); dat dekt automatisch ook `SPRINT_IMPLEMENTATION`
  via `...TASK_TOOLS`. Zonder dit blokkeert `--allowedTools` in de runner de aanroep.
- **Kind-prompts** voor implementatie-werk krijgen één regel in hun *Workflow*:
  *"Roep `mcp__scrum4me__get_agent_guide({ product_id })` (product_id uit de payload)
  aan en behandel `guide_md` als bindend voor hóé je bouwt en documenteert."*
  Scope nu: `src/prompts/task/implementation.md` en
  `src/prompts/sprint/implementation.md`. Dit bereikt de autonome worker omdat de
  runner deze .md's via `getKindPromptText()` uit `/opt/scrum4me-mcp/src/` inleest.

> Let op: de autonome worker gebruikt `get_claude_context` **niet** voor z'n taak (die
> retourneert de *volgende* story; de worker heeft z'n taak al in `$PAYLOAD_PATH`).
> Daarom de aparte `get_agent_guide`-tool.

### 4. Registratie & bewerken

- **Registratie**: registreer `get_agent_guide` in `registerSharedTools()`
  (`src/register.ts`) — náást `registerGetClaudeContextTool`. **Niet** in
  `registerWorktreeTools()`, anders mist de HTTP-endpoint de tool terwijl het ontwerp
  juist worker-agnostisch is.
- **Per-product bewerken**: bestaande `create_product_doc`/update met `folder=MANUAL`,
  `slug=agent-guide`, `status: active` + Scrum4Me-UI. (Een dunne `set_agent_guide`-
  wrapper voor vindbaarheid kan later; niet nodig voor v1.)
- **Globaal bewerken**: PR op `src/lib/agent-guide-default.ts`.

### 5. Content-stijl

De agent-guide wordt **model-agnostisch** geschreven: refereer aan MCP-tools en de
git/PR-flow, niet aan Claude-specifieke features ("Claude, doe X"). Positieve
formulering ("Prefer X over Y") boven "Do not …".

## Bestanden

**Nieuw**
- `src/lib/agent-guide-default.ts` — globale default als geëxporteerde string.
- `src/lib/agent-guide.ts` — `resolveAgentGuide()` (lookup + merge + grootte-gate).
- `src/tools/get-agent-guide.ts` — registreert `get_agent_guide`.
- `__tests__/lib/agent-guide.test.ts`, `__tests__/tools/get-agent-guide.test.ts`.

**Wijzigen**
- `src/tools/get-claude-context.ts` — voeg `agent_guide` (+ graceful `agent_guide_error`) toe.
- `src/lib/job-config.ts` — voeg de tool toe aan `TASK_TOOLS`.
- `src/register.ts` — registreer in `registerSharedTools()`.
- `src/http.ts` + `src/index.ts` — `INSTRUCTIONS` delen + bootstrap-pointer toevoegen.
- `src/prompts/task/implementation.md`, `src/prompts/sprint/implementation.md` — één
  workflow-regel.
- `__tests__/job-config.test.ts` — assert dat task- én sprint-jobs de tool mogen gebruiken.

## Te verifiëren in de plan-/implementatiefase

- **Bevestigd**: de runner importeert uit `/opt/scrum4me-mcp/src/...` (tsx), dus
  .md-edits in `src/prompts/` propageren en de TS-module-default werkt ook daar.
- Hoe de **HTTP/stdio MCP-server** in productie draait (`node dist/...` vs tsx) — de
  TS-module-default is robuust voor beide; goed om te bevestigen.
- De API-folderwaarde voor `MANUAL` en de mapping in `get-product-doc.ts` /
  `product-doc-schemas`.
- Of `INSTRUCTIONS` in `http.ts` en `index.ts` al identiek is (dan simpel delen).

## Verificatie (end-to-end)

1. **Unit (resolver)**: geen override → alleen globaal; **actieve** override → globaal
   + product-sectie; **inactieve** override (draft/deprecated/archived) → genegeerd;
   `MANUAL` folder disabled → genegeerd; gemergede guide te groot → `AGENT_GUIDE_TOO_LARGE`.
2. **Unit (tools)**: `get_agent_guide` retourneert `guide_md` + metadata en propageert
   de too-large-error; `get_claude_context` bevat `agent_guide`, en degradeert naar
   `null` + `agent_guide_error` bij resolver-fout.
3. **Unit (allowlist)**: `__tests__/job-config.test.ts` assert dat `TASK_IMPLEMENTATION`
   en `SPRINT_IMPLEMENTATION` `mcp__scrum4me__get_agent_guide` toestaan.
4. **Registratie/smoke**: tool beschikbaar via zowel stdio als HTTP (shared registratie).
5. **Handmatig (MCP)**: maak een `ProductDoc(MANUAL, agent-guide, status:active)` via
   `create_product_doc`; `get_agent_guide(product_id)` → globaal + product-sectie; zet
   status op `draft` → terug naar alleen globaal.
6. **Autonome worker (smoke)**: bij een `TASK_IMPLEMENTATION`-job roept de worker
   `get_agent_guide` aan (nu toegestaan) en volgt de guide — verifieer in het transcript.
7. `npm run typecheck` en `npm test` groen.

## Out of scope (YAGNI)

- Sectie-niveau override-merge (alleen append, product-sectie als laatste).
- Kind-orchestratie via MCP-tool serveren (uitgesteld per scoping-keuze).
- Naming neutraliseren (`get_claude_context` → `get_worker_context`, etc.).
- Niet-Claude-runners zelf bouwen.
- Preview van draft-guides als runtime-gedrag (alleen via expliciete edit-flow, later).
