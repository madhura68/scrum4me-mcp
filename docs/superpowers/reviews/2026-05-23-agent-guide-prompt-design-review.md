---
title: Review - Agent-guide prompt-design plan
status: reviewed
date: 2026-05-23
reviewer: codex
source: ../specs/2026-05-23-agent-guide-prompt-design.md
---

# Review: Agent-guide prompt-design plan

## Verdict

Het ontwerp is inhoudelijk de juiste richting: een aparte `get_agent_guide`-tool is beter dan client-specifieke prompt-injectie, en de keuze om de autonome worker niet afhankelijk te maken van `get_claude_context` klopt.

Het plan is nog niet implementatie-klaar. Er missen een paar operationele randvoorwaarden waardoor de worker de nieuwe guide in productie waarschijnlijk niet kan ophalen of waardoor oude/te grote ProductDocs ineens bindende instructies kunnen worden.

## Findings

### P1 - Autonome workers mogen de nieuwe tool niet aanroepen

Planregels 102-108 voegen een workflow-regel toe die `mcp__scrum4me__get_agent_guide({ product_id })` laat aanroepen vanuit `TASK_IMPLEMENTATION` en `SPRINT_IMPLEMENTATION`. De tool staat echter niet in de allowlist.

Bewijs:
- `src/lib/job-config.ts:55-74` definieert `TASK_TOOLS` zonder `mcp__scrum4me__get_agent_guide`.
- `scrum4me-docker/bin/run-one-job.ts:274-283` geeft `ctx.config.allowed_tools` letterlijk door aan `claude -p --allowedTools`.

Impact: de prompt instrueert de worker om een tool te gebruiken die door de CLI-allowlist wordt geblokkeerd. De geplande smoke-test faalt dan al voordat de guide-inhoud gedrag kan sturen.

Aanpassing:
- Voeg `mcp__scrum4me__get_agent_guide` toe aan `TASK_TOOLS`.
- Voeg assertions toe in `__tests__/job-config.test.ts` voor `TASK_IMPLEMENTATION` en impliciet/expliciet `SPRINT_IMPLEMENTATION`.
- Neem `src/lib/job-config.ts` en `__tests__/job-config.test.ts` op in de bestandslijst van het plan.

### P1 - De default guide wordt niet automatisch meegebakken in `dist`

Planregels 52-54 introduceren `src/prompts/agent-guide.default.md` als runtime-bestand "meegebakken net als de kind-prompts". De huidige build doet dat niet zichtbaar.

Bewijs:
- `package.json` gebruikt `build: tsc`.
- `tsconfig.json` compileert alleen TypeScript naar `dist`; `.md`-assets worden niet gekopieerd.
- `package.json.files` bevat alleen `dist`, `prisma` en `README.md`.

Impact: in `node dist/index.js` en `node dist/http.js` zal een resolver die analoog aan `kind-prompts.ts` vanuit `dist/lib` naar `dist/prompts/agent-guide.default.md` leest, het bestand niet vinden tenzij er expliciet een copy-stap of embedding wordt toegevoegd. Dit raakt juist de HTTP-tool die als worker-agnostische bron bedoeld is.

Aanpassing:
- Kies expliciet een packaging-aanpak: copy `src/prompts/**/*.md` naar `dist/prompts` tijdens build, of embed de default als TypeScript string/module.
- Voeg een verificatie toe die na `npm run build` controleert dat `dist/prompts/agent-guide.default.md` bestaat of dat `resolveAgentGuide()` in compiled vorm werkt.

### P1 - Status- en folder-semantiek voor bindende ProductDocs ontbreken

Planregels 55-58 en 72-74 gebruiken `ProductDoc(MANUAL, agent-guide)` als bindende override. Het plan specificeert niet welke status geldig is en of een uitgeschakelde doc-folder genegeerd moet worden.

Bewijs:
- `src/lib/product-doc-schemas.ts:7-12` kent `draft`, `active`, `deprecated`, `archived`.
- `src/tools/get-product-doc.ts:101-116` zoekt op product/folder/slug zonder statusfilter en retourneert alleen metadata zoals `status`; `folder_enabled` wordt later apart gerapporteerd.

Impact: een draft, deprecated of archived `manual/agent-guide` kan onbedoeld de globale default overrulen. Omdat dit instructies zijn, is dat risicovoller dan gewone documentretrieval.

Aanpassing:
- Definieer in het plan dat alleen `status = active` als override geldt.
- Definieer of `Product.enabled_doc_folders` gerespecteerd moet worden. Voor een bindende guide is "manual disabled betekent geen product override" het minst verrassend.
- Als preview van draft-guides later nodig is, maak dat expliciet met een aparte parameter of aparte edit-flow, niet als default runtime-gedrag.

### P2 - Er is geen limiet op guide-grootte, maar `get_claude_context` gaat de guide bundelen

Planregels 94-96 voegen `agent_guide: <guide_md>` toe aan `get_claude_context`. `ProductDoc.content_md` mag tot 100.000 tekens zijn.

Impact: een lange guide maakt elke interactieve context-call zwaar en kan promptbudget of MCP-responsgrootte opeten. Stil truncaten is ook gevaarlijk, omdat halve instructies dan bindend zouden lijken.

Aanpassing:
- Leg een harde maximale lengte vast voor de gemergede guide, bijvoorbeeld 12k-20k tekens.
- Laat `resolveAgentGuide()` failen met een duidelijke fout als de guide te groot is; niet stil afkappen.
- Test zowel "binnen limiet" als "te groot" voor `get_agent_guide` en `get_claude_context`.

### P2 - Tool-registratie moet expliciet in de shared toolset

Planregel 137 noemt `src/register.ts`, maar niet waar de tool geregistreerd moet worden. In deze branch splitst `register.ts` tools in `registerSharedTools()` en `registerWorktreeTools()`.

Impact: als `get_agent_guide` per ongeluk worktree-only wordt geregistreerd, mist de HTTP endpoint de tool terwijl het ontwerp juist worker-agnostisch wil zijn.

Aanpassing:
- Registreer `get_agent_guide` in `registerSharedTools()`.
- Neem in de tests/smoke mee dat de tool beschikbaar is via zowel stdio als HTTP/shared registratie.

## Sterke punten

- De aparte `get_agent_guide`-tool is terecht, omdat autonome jobs hun payload al hebben en `get_claude_context` niet de juiste bron voor job-context is.
- Layered append is voldoende simpel voor v1; sectie-merge out of scope houden is verdedigbaar.
- Het centraliseren van `INSTRUCTIONS` voor `index.ts` en `http.ts` is een nette cleanup die duplicatie vermindert.

## Aanbevolen plan-aanvulling

Voeg deze concrete items toe voordat dit als implementatieplan wordt gebruikt:

- `src/lib/job-config.ts`: voeg `mcp__scrum4me__get_agent_guide` toe aan `TASK_TOOLS`.
- `__tests__/job-config.test.ts`: assert dat task- en sprint-jobs de tool mogen gebruiken.
- Build/package stap: zorg dat `agent-guide.default.md` in compiled runtime beschikbaar is.
- Resolverregels: alleen actieve, toegankelijke, folder-enabled overrides gebruiken; duidelijke metadata teruggeven.
- Lengtebeleid: harde max op gemergde guide, fail fast bij overschrijding.
- `src/register.ts`: registreer `get_agent_guide` in `registerSharedTools()`.
- Tests: resolver zonder override, met actieve override, met inactive override, te grote guide, tool-output, `get_claude_context`-veld, en compiled asset-verificatie na build.
