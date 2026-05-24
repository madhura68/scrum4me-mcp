---
title: Review - Agent-guide implementation
status: reviewed
date: 2026-05-24
reviewer: codex
source_plan: ../plans/2026-05-23-agent-guide-prompt.md
source_spec: ../specs/2026-05-23-agent-guide-prompt-design.md
---

# Review: Agent-guide implementation

## Verdict

De oorspronkelijke agent-guide implementatie is grotendeels correct uitgevoerd. De eerder gevonden P1's zijn opgelost:

- `get_agent_guide` staat in de task/sprint allowlist.
- De default guide is als TypeScript-module ingebed, dus geen runtime `.md` packaging-probleem.
- Product overrides worden alleen gelezen uit `MANUAL/agent-guide` met `status = active`, en alleen als de `MANUAL` folder enabled is.
- `get_agent_guide` is in `registerSharedTools()` geregistreerd.
- `get_claude_context` levert `agent_guide` en degradeert naar `agent_guide_error` bij resolverfouten.

Er blijven twee verbeterpunten over in de huidige eindstaat, waarvan één door de latere sprint-subagent-flow is ontstaan.

## Findings

### P1 - Sprint sub-agents krijgen de bindende guide niet mee

In de huidige `SPRINT_IMPLEMENTATION`-prompt moet de orchestrator eerst `get_agent_guide` aanroepen, maar de daadwerkelijke implementatie wordt daarna naar een `Agent` sub-agent gedelegeerd. De delegate-instructie noemt worktree, commits, logging en samenvatting, maar zegt niet dat `guide_md` moet worden meegegeven of gevolgd.

Bewijs:
- `src/prompts/sprint/implementation.md:36-37` instrueert de hoofdagent om `get_agent_guide` te lezen.
- `src/prompts/sprint/implementation.md:46-52` delegeert de zware uitvoering aan de `Agent`-tool zonder `guide_md` of agent-guide-instructies door te geven.

Impact: bij sprint-jobs leest de orchestrator de guide, maar de sub-agent die code wijzigt hoeft de build/doc/verify-standaard niet te zien. Daarmee bereikt de guide niet consequent de werkelijke executor.

Aanpassing:
- Laat de sprintprompt expliciet eisen dat de volledige `guide_md` in de sub-agent opdracht wordt opgenomen.
- Voeg een prompttest toe die bewaakt dat de sprintprompt zowel `Agent` als `guide_md`/`agent-guide` overdracht bevat.

### P2 - ProductDoc frontmatter wordt als instructietekst gemerged

`resolveAgentGuide()` voegt de volledige `ProductDoc.content_md` toe aan de product-sectie. ProductDocs die via `create_product_doc` worden geschreven bevatten verplichte YAML-frontmatter (`title`, `status`, enz.). Die frontmatter komt daardoor in `guide_md` terecht.

Bewijs:
- `src/lib/agent-guide.ts:51` appendt `${override.content_md}` direct.
- `src/lib/product-doc-schemas.ts:14-20` vereist frontmattervelden voor ProductDocs.

Impact: agents krijgen metadata te zien als onderdeel van de bindende instructies. Dat is ruis, telt mee in de 16k-limiet, en maakt de product-sectie minder leesbaar. Functioneel breekt dit niet direct, maar het is niet de ideale authoring-ervaring.

Aanpassing:
- Parse de override met `parseProductDocMd()` en append alleen de body.
- Houd metadata in `product_doc` beschikbaar, niet in de instructietekst.
- Voeg een resolvertest toe die bevestigt dat frontmatter niet in `guide_md` verschijnt.

## Positief

- De resolver is klein en goed afgebakend.
- De status/folder-gating is correct en getest.
- `AgentGuideTooLargeError` voorkomt stille truncation.
- De default guide is compile-safe doordat hij in `src/lib/agent-guide-default.ts` zit.
- Tool-registratie en allowlist zijn expliciet getest.

## Verificatie

Uitgevoerd in `/Users/janpetervisser/Development/scrum4me-mcp/.claude/worktrees/naughty-brown-2be56e`:

- `npm run typecheck` - PASS
- `npm run build` - PASS
- `npm test` - PASS, 58 test files / 516 tests
- Compiled artifact check - PASS: `dist/lib/agent-guide-default.js`, `dist/lib/agent-guide.js`, `dist/tools/get-agent-guide.js`, `dist/instructions.js` bestaan.

Niet uitgevoerd:

- Handmatige MCP smoke tegen een echte `ProductDoc(MANUAL, agent-guide)`, omdat de lokaal beschikbare MCP-toolset in deze Codex-sessie nog niet de nieuwe `get_agent_guide` tool exposeert.
