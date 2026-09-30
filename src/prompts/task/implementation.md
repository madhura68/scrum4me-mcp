# TASK_IMPLEMENTATION-prompt

> Deze prompt wordt door `scrum4me-docker/bin/run-one-job.ts` als `claude -p`-input
> meegegeven voor één geclaimde `TASK_IMPLEMENTATION`-job. De runner heeft de job
> al voor je geclaimd; jouw taak is alleen de uitvoering.

---

Je bent gestart voor één geclaimde `TASK_IMPLEMENTATION`-job uit de Scrum4Me-queue.
De volledige job-payload (inclusief task, story, pbi, sprint, product, config en
worktree_path) staat in:

```
$PAYLOAD_PATH
```

Lees die payload eerst met `Read $PAYLOAD_PATH`. De payload bevat ook:

- `doc_index`: bestaande ProductDocs per folder (beschrijving + titels). Lees relevante docs met `get_product_doc({product_id, folder, slug})` vóór je begint; `search_product_docs` voor full-text, `list_product_docs` voor de volledige index (bij `truncated`). Werk **uitsluitend** in het
`worktree_path` dat erin staat — alle git-operations, bestandsbewerkingen en
verifies horen daar te landen.

## Hard regels

- **GEEN** `mcp__scrum4me__wait_for_job` aanroepen. De runner heeft al voor je
  geclaimd. Eén Claude-invocation = één job.
- **GEEN** `mcp__scrum4me__check_queue_empty`. Je sluit af na deze ene job.
- Werk in het toegewezen worktree-pad; geen edits in andere directories.
- Volg `task.implementation_plan` uit de payload als die niet leeg is — dat is
  het door de mens of een eerdere planning-sessie vastgelegde recept.
- Gebruik na het lezen van de payload de daarin meegegeven passende guide.
  Ontbreekt die, vraag één keer `mcp__scrum4me__get_agent_guide({ product_id, agent })`
  op: product_id uit de job, eigen bekende `agent.runtime` (CLAUDE/CODEX) en alleen
  een exact bekend `agent.model_id`. Laat een onbekend model-ID weg zonder een
  bekende runtime weg te laten; bij onbekende runtime vervalt het agent-object.
  Lees `guide_md` en controleer `agent_context.applied_profiles`; volg de guide
  binnen deze jobgrenzen, ook voor taakverdeling, modelkeuze voor subagents
  en verificatie.
  Het runner-gekozen hoofdmodel blijft behouden. Geef relevante guide-instructies
  aan subagents mee; zij herhalen de hoofdstartflow niet automatisch. Herstel na
  compactie dezelfde jobcontext en haal alleen ontbrekende guide-inhoud op;
  geen nieuwe claim of sprintselectie. Ontbreekt de guide ook dan, meld de fout
  volgens de bestaande jobafhandeling zonder herhaallus.

## Workflow

1. **Status op in_progress**: `mcp__scrum4me__update_task_status({ task_id, status: 'in_progress' })`.
2. **Plan lezen**: Lees `task.implementation_plan` uit de payload + relevante
   project-docs (`docs/specs/functional.md`, eventueel `docs/patterns/*.md`).
3. **Implementeer** de taak. Commit per logische laag met `git add -A && git commit`,
   **geen** `git push`. Volg de agent-guide voor commit- en test-discipline.
4. **Logging per laag**: `mcp__scrum4me__log_implementation`,
   `mcp__scrum4me__log_commit` (hash uit `git rev-parse HEAD`) en
   `mcp__scrum4me__log_test_result` — zie de agent-guide voor wat elk moet bevatten.
5. **Verify-gate**: roep `mcp__scrum4me__verify_task_against_plan({ task_id })`
   aan om de wijzigingen tegen het plan te toetsen.
6. **Sluit af**:
   - Bij succes: `update_task_status({ task_id, status: 'done' })` en
     `update_job_status({ job_id, status: 'done', summary })`.
   - Bij failure (kan de taak niet voltooien): `update_task_status({ task_id, status: 'failed' })`
     en `update_job_status({ job_id, status: 'failed', error })`.
   - Bij geen-werk-nodig (no-op): `update_job_status({ job_id, status: 'skipped', summary })`.

## Vragen aan de gebruiker

Als je een blokkerende keuze tegenkomt waarvoor je input nodig hebt, gebruik
`mcp__scrum4me__ask_user_question` en wacht op het antwoord met
`mcp__scrum4me__get_question_answer`. Vraag **niet** voor zaken die je zelf
kunt afleiden uit het plan.
