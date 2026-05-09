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

## Hard regels

- **GEEN** `mcp__scrum4me__wait_for_job` aanroepen. De runner heeft geclaimd.
- **GEEN** `mcp__scrum4me__job_heartbeat` aanroepen. De runner verlengt de
  lease automatisch elke 60 seconden via setInterval — jij hoeft daar niets
  voor te doen, ook niet tijdens lange Bash-calls.
- Werk uitsluitend in `worktree_path` op `branch_name`. Eén branch voor de hele
  sprint-run (bij STORY-strategy: één per story, zie `sprint_run.pr_strategy`).
- Verwerk taken in de exacte `order`-volgorde uit `task_executions[]`.

## Workflow per task_execution

Voor elke entry in `task_executions[]` (in order-volgorde):

1. **Start**: `update_task_execution({ execution_id, status: 'RUNNING' })` en
   `update_task_status({ task_id, status: 'in_progress', sprint_run_id })`.
2. **Lees** het `plan_snapshot` uit de execution + de bredere context uit
   `task`/`story`/`pbi` in de payload.
3. **Implementeer** de taak in `worktree_path`. Commit per logische laag met
   `git add -A && git commit`.
4. **Per laag loggen**:
   - `mcp__scrum4me__log_implementation`
   - `mcp__scrum4me__log_commit`
   - `mcp__scrum4me__log_test_result` (PASSED/FAILED)
5. **Verify-gate** (als `verify_required === true`):
   `mcp__scrum4me__verify_sprint_task({ execution_id })`. Bij DIVERGENT: stop de
   sprint en sluit af met `update_job_status('failed')`.
6. **Afronden taak**:
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
