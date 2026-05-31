# SPRINT_IMPLEMENTATION-prompt

> Deze prompt wordt door `scrum4me-docker/bin/run-one-job.ts` als `claude -p`-input
> meegegeven voor één geclaimde `SPRINT_IMPLEMENTATION`-job. Eén job = de hele
> sprint-run sequentieel afhandelen.

---

Je bent gestart voor één geclaimde `SPRINT_IMPLEMENTATION`-job. De payload bevat
een **frozen scope-snapshot** met alle te verwerken taken:

```
$PAYLOAD_PATH
```

Lees die payload eerst. Belangrijke velden:
- `worktree_path`: de geïsoleerde worktree waar al je werk landt.
- `branch_name`: de feature-branch (bv. `feat/sprint-<id>`); bij PR-strategy
  SPRINT zit alle werk in één branch.
- `task_executions[]`: ordered lijst van `SprintTaskExecution`-rijen. Verwerk in
  `order`-volgorde. Elke entry heeft `task_id`, `plan_snapshot`, `verify_required`,
  `verify_only`, en `base_sha` (alleen voor entry order=0).
- `pbis[]`, `stories[]`: context voor begrip; geen wijzigingen daarop.
- `sprint_run.id`: nodig voor `update_task_status` cascade-prop. Geef altijd
  `sprint_run_id` mee aan `update_task_status`.
- `doc_index`: bestaande ProductDocs per folder (beschrijving + titels). Lees relevante docs met `get_product_doc({product_id, folder, slug})` vóór je begint; `search_product_docs` voor full-text, `list_product_docs` voor de volledige index (bij `truncated`).

## Hard regels

- **GEEN** `mcp__scrum4me__wait_for_job` aanroepen. De runner heeft geclaimd.
- **GEEN** `mcp__scrum4me__job_heartbeat` aanroepen. De runner verlengt de
  lease automatisch elke 60 seconden via setInterval — jij hoeft daar niets
  voor te doen, ook niet tijdens lange Bash-calls.
- Werk uitsluitend in `worktree_path` op `branch_name`. Eén branch voor de hele
  sprint-run (bij STORY-strategy: één per story, zie `sprint_run.pr_strategy`).
- Verwerk taken in de exacte `order`-volgorde uit `task_executions[]`.
- Roep eerst `mcp__scrum4me__get_agent_guide({ product_id })` aan (product_id uit de
  payload) en behandel `guide_md` als bindend voor hóé je bouwt en documenteert.

## Workflow per task_execution

Voor elke entry in `task_executions[]` (in order-volgorde) ben jij de **orchestrator** —
delegeer de zware uitvoering aan een sub-agent zodat je eigen context slank blijft:

1. **Start**: `update_task_execution({ execution_id, status: 'RUNNING' })` en
   `update_task_status({ task_id, status: 'in_progress', sprint_run_id })`.
2. **Delegeer naar een sub-agent** (de `Agent`-tool). Geef een zelfstandige opdracht met
   het `plan_snapshot` van deze execution, de relevante `task`/`story`/`pbi`-context uit
   de payload, het `worktree_path`, en de volledige `guide_md` uit de agent-guide. Instrueer
   de sub-agent om: de meegegeven `guide_md` als bindend te volgen, uitsluitend in
   `worktree_path` te werken, per logische laag te committen (`git add -A && git commit`,
   **geen** `git push`), te loggen via `log_implementation` / `log_commit` /
   `log_test_result`, en een **beknopte samenvatting** terug te geven (wat gewijzigd,
   commit-hashes, testuitslagen). Lees zelf geen code-bestanden in — houd dat in de
   sub-agent-context.
3. **Verify-gate** (als `verify_required === true`):
   `mcp__scrum4me__verify_sprint_task({ execution_id })`. Dit draait in jóúw sessie en is
   **bepalend** — niet de zelf-inschatting van de sub-agent. Bij DIVERGENT: stop de sprint
   en `update_job_status('failed')`.
4. **Afronden taak**:
   - Bij ALIGNED/PARTIAL: `update_task_status({ task_id, status: 'done', sprint_run_id })`
     en `update_task_execution({ execution_id, status: 'DONE' })`.
   - Bij EMPTY (no-op): `update_task_execution({ execution_id, status: 'SKIPPED' })`
     en `update_task_status({ task_id, status: 'done', sprint_run_id })`.

## Sprint afronden

Na de laatste `task_execution`:

- **Verify-gate run**: optioneel een algemene `npm run verify` op de hele worktree.
- **Sluit de job af**: `mcp__scrum4me__update_job_status({ job_id, status: 'done', summary })`
  met een samenvatting van wat is afgerond. De `update_job_status`-tool detecteert
  automatisch dat dit een SPRINT_IMPLEMENTATION-job is en doet de PR-promotion volgens
  `Product.auto_pr` en `sprint_run.pr_strategy`.

Bij een blokkerende fout halverwege: `update_job_status({ job_id, status: 'failed', error })`
en stop. De runner zorgt voor lease-cleanup.

## Vragen aan de gebruiker

Voor blokkerende keuzes: `mcp__scrum4me__ask_user_question` + wacht op antwoord
met `mcp__scrum4me__get_question_answer`. Probeer dit te vermijden in een sprint-
run — ga uit van het frozen plan-snapshot.
