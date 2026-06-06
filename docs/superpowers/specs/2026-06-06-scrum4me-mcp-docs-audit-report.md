---
title: "scrum4me-mcp — docs-audit rapport"
date: 2026-06-06
repo: scrum4me-mcp
type: audit-report
status: active
verified: 2026-06-06
---

# scrum4me-mcp — documentatie-audit 2026-06-06

Geautomatiseerde cross-repo docs-audit (W1–W6). Plannen geverifieerd tegen de codebase, pagina's gecheckt op documentatie, en cross-repo consistentie beoordeeld. Auto-applicable fixes zijn toegepast; `manual-review`-items staan onderaan.

## 1. Plan-status (geverifieerd tegen code)

| Verdict | Aantal |
|---|--:|
| done | 6 |
| partial | 3 |
| draft | 0 |
| **totaal** | **9** |

Elk plan kreeg `verified: 2026-06-06` + `audit_verdict:` in de frontmatter (bestaande `status:` behouden; alleen ongeldige status-waarden — unknown/ontbrekend — genormaliseerd).

<details><summary>Per plan</summary>

| Plan | Verdict |
|---|---|
| `/Users/janpetervisser/Development/Scrum4Me/docs/plans/sprint-pr-worktree-state-machines.md` | done |
| `docs/plans/2026-05-31-doc-index-in-payload.md` | done |
| `docs/plans/2026-06-04-manual-idea-jobs-phase1.md` | done |
| `docs/superpowers/manual/2026-05-24-worker-context-overview.md` | partial |
| `docs/superpowers/specs/2026-05-23-agent-guide-prompt-design.md` | done |
| `docs/superpowers/specs/2026-05-23-claim-observability-worktree-retry-design.md` | partial |
| `docs/superpowers/specs/2026-05-23-sprint-subagent-execution-design.md` | partial |
| `docs/superpowers/specs/2026-05-23-worker-agent-guide-consolidation-design.md` | done |
| `docs/superpowers/specs/2026-05-24-reused-worktree-freshness-design.md` | done |

</details>

## 2. Pagina-documentatie

_Geen Next.js-pagina's in deze repo._

## 3. Cross-repo consistency-findings (4)

### [P2] folder-structure — scrum4me-mcp
docs/ structure is minimal versus the Scrum4Me baseline. structure_anomalies reports "Missing docs/INDEX.md at docs root", "Missing docs/adr/ folder", "Missing docs/design/ folder", "Missing docs/architecture.md at docs root", and "Minimal docs structure: only plans/ and superpowers/ subfolders". Plans live under both docs/plans/ and docs/superpowers/{plans,specs}, but there is no top-level index, no architecture doc, and no adr/ or design/ subfolders that the platform baseline carries.

**Fix:** Add docs/INDEX.md (top-level index) and docs/architecture.md at the docs root. Add docs/adr/ and docs/design/ subfolders to match the Scrum4Me baseline. Consider consolidating the split between docs/plans/ and docs/superpowers/plans/ into the baseline docs/plans + docs/specs layout, and add docs/runbooks/ for the worker/queue operational docs this repo owns.

### [P2] index-convention — scrum4me-mcp
structure_anomalies bevat "Missing docs/INDEX.md at docs root (no top-level index)" — er is geen top-level docs/INDEX.md die de docs ontsluit, terwijl de repo wel een docs/-structuur (plans/, superpowers/) en DB-docs heeft.

**Fix:** Genereer docs/INDEX.md met links naar alle docs

### [P2] claude-md-sections — scrum4me-mcp
CLAUDE.md mist t.o.v. de canonieke set (Scrum4Me-product / Hardstop / Quickref / Verify) een Hardstop- en een Quickref-sectie (of equivalent). Aanwezig: Scrum4Me-product (ok) en 'Testing' (= Verify-equivalent, ok). Ontbreekt: een expliciete Hardstop-sectie met harde grenzen, en een Quickref/patterns-overzicht ('Key source files' is een bestandslijst, geen patterns-quickref).

**Fix:** Voeg aan CLAUDE.md een 'Hardstop'-sectie toe (harde regels: bijv. schema-wijzigingen eerst in scrum4me-shared, geen eigen migraties, etc.) en een 'Quickref'-sectie (tabel bestand→doel met de kern-entrypoints). 'Testing' dekt Verify al; eventueel hernoemen/aanvullen tot 'Verify'. Spiegel de canonieke kop-namen van scrum4me-workers.

### [P2] deployment-consistency — scrum4me-mcp
scrum4me-mcp is a deployable repo (MCP server, 15.8KB README, claude_md describes worker/Forgejo automation) but has NO container, NO Caddy vhost and NO systemd unit visible in the server snapshot. Its runtime location is unaccounted for: neither a standalone container nor a registered service. It may run embedded inside the agent-runner containers (compose-worker-idea-19/20) or as an unsnapshotted process. snapshot_status is 'partial', so this is 'not observed' rather than confirmed-missing.

**Fix:** Document where scrum4me-mcp actually runs (e.g. bundled into the scrum4me-agent-runner:idea image, started by the runner, or a separate process). If it is meant to be a long-running service, add it to the deployment manifest (container or systemd unit) so it is observable; if it is a per-job MCP launched by the runner, state that explicitly in the deployment doc so the absence of a container is expected.

## 4. Toegepaste structuur-fixes

- scrum4me-mcp: `docs/INDEX.md` ✓

## 5. Manual-review items (2)

Niet auto-toegepast — vereisen jouw beoordeling:

- **[P2/M]** structure-fix → `docs/`
- **[P2/M]** manual-review-needed → `docs/`

---
_Auto-gegenereerd door de Scrum4Me docs-audit (2026-06-06)._
