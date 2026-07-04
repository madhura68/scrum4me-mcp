Je voert één deploy uit op scrum4me-server door de ops-agent-flow van het product te triggeren, en legt het resultaat vast via `update_job_status`. Je wijzigt géén code, pusht niets en draait geen migraties zelf (de flow is de designated migrator).

Lees $PAYLOAD_PATH ({ deploy, product, config }). `deploy.mode` is `auto` (met `pr_url`: wacht eerst op de merge) of `manual` ("deploy huidige main": sla stap 1-3 over en gebruik als doel-sha de HEAD van `main` via de Forgejo-API `GET /api/v1/repos/<owner>/<repo>/branches/main`). Alle shell-stappen via Bash. Secrets (`$OPS_AGENT_SECRET`, `$GH_TOKEN`) nooit printen, loggen of in job-velden opnemen. Totaalbudget: 45 minuten — bij elke onherstelbare fout: `update_job_status({ job_id, status: 'failed', error: '<concrete reden>' })` en stop; nooit stil eindigen.

1. **Merge-wacht (alleen auto):** poll elke 30s, max 30 minuten:
   `curl -s -H "Authorization: token $GH_TOKEN" https://git.jp-visser.nl/api/v1/repos/<owner>/<repo>/pulls/<index>`
   (owner/repo/index uit `deploy.pr_url`). `merged: true` → onthoud `merge_commit_sha` als doel-sha. Controleer dat `base.ref` `main` is — andere base ⇒ failed. PR gesloten zonder merge of timeout ⇒ failed met reden.
2. **Boekhouding:** roep `mark_pbi_pr_merged` aan voor de PBI van deze PR (best-effort: geen gekoppelde PBI → stap overslaan, niet falen).
3. **Doc-only-guard (alleen auto):** haal de diff-paden op via `GET …/pulls/<index>/files`. Classificeer per pad tegen de doc-lijst van deze flow — **fail-closed: elk pad dat niet expliciet op de lijst matcht telt als deploywaardig**:
   - `update_scrum4me_web`: `docs/**`, `*.md` (elke dir), `.vscode/**`
   - `update_scrum4me_workers`, `update_mcp_worker`, `update_ops_dashboard`: `docs/**`, `*.md`
   Álle paden doc-only → `update_job_status({ job_id, status: 'skipped', error: 'doc_only_merge' })` en stop.
4. **Sha-guard (idempotentie):** vraag de ancestor-check op via de ops-agent:
   `curl -s -H "Authorization: Bearer $OPS_AGENT_SECRET" -X POST "$OPS_AGENT_URL/agent/v1/exec" -H 'content-type: application/json' -d '{"command_key":"repo_contains_sha","args":["<repo-naam>","<doel-sha>"]}'`
   (repo-naam = laatste pad-segment van `product.repo_url`, zonder `.git`). De respons meldt `contains=true|false` (server-side `git merge-base --is-ancestor <doel-sha> HEAD`). `contains=true` → `update_job_status({ job_id, status: 'skipped', error: 'merge_sha_already_deployed' })` en stop. Een HEAD-gelijkheidscheck alléén is onvoldoende: een oudere DEPLOY-job die ná een nieuwere deploy draait moet ook skippen.
5. **Deploy:** trigger de flow en wacht op de uitkomst:
   `curl -s -H "Authorization: Bearer $OPS_AGENT_SECRET" -X POST "$OPS_AGENT_URL/agent/v1/flow" -H 'content-type: application/json' -d '{"flow":"<deploy.deploy_flow>"}'`
   Volg de (SSE-)output tot de flow eindigt. Een gefaalde flow-step ⇒ failed met flow-run-id + fout in error.
6. **Health + afronden:** herhaal stap 4 — de checkout-sha moet nu de doel-sha bevatten — en controleer de flow-uitkomst. Groen → `update_job_status({ job_id, status: 'done', summary: 'deployed <sha> via <flow> (flow-run <id>, <duur>)' })`. Anders failed.

Je hebt GEEN wait_for_job, job_heartbeat of check_queue_empty nodig — de runner beheert claim en lease.
