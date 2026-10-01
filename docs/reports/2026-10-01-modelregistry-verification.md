# T-170 — Codex-modelregistry ketenbewijs

## Tests

- Baseline na submodule-init/Prisma-generate: typecheck geslaagd, 2008 tests geslaagd / 69 bestaande skips.
- RED op oude shared-pin: vier contextassertions en één managed-snapshotassertion geven ten onrechte GPT-5.5 terug. Args-tests blijven groen zoals verwacht.
- GREEN met shared `8bf0ca3d63d1fadfc7d45be04058e3780c77e4bc`: 18 gerichte context/args-tests; twee echte PostgreSQL-integratietests.
- Volledige `npm run typecheck` + `npm test`: 2015 geslaagd, 69 bestaande skips, 248 geslaagde testbestanden / negen overgeslagen bestanden. De extra historische test voor o3 is aangepast aan het gereviewde exact-doorgeven-contract nadat de volledige suite zijn oude verwachting aantoonde.
- Volledige `npm run test:dispatch`: DB-preflight geslaagd, 268/268 tests in 27 bestanden, exit 0. Afzonderlijke PostgreSQL17-cluster op localhost met schemafixture `6dc581daa7d56bd0e00a82383b3be4bd5d877afb` en de bestaande gepinde token-usage-overlay; geen productie-DB.

## Echte runner met weigerende CLI-stub

- Op max2 is een afzonderlijk testimage gebouwd boven productie-image `ae75e96a12484f4d8f2e3cc5d08eba0d2659ad07a292265eb98e8efe00d33382`.
- De echte runner is bytegelijk aan D-bronpin `7d6072d42a41652fb40e1953c9d7c7164fb4c257`: bestand-SHA-256 `963d53579f07d34ba99f545066e2d5ebd297d9bb81319cb950d4d4299adf1735`.
- Testimage `b8471b2b9cb488e3b39dbddddba9c481443541766c8837652a7ad7a92b6c570c` bevat uitsluitend de nieuwe shared `job-config.ts` en een PATH-shadow van `codex` als verschil voor de proef. Runner-productiecode niet gewijzigd.
- Geen productieaccount, auth-mount, tokens, repositories of jobqueue gebruikt. Een eigen testtoken verbindt via een tijdelijke loopback-only SSH-forward met de disposable `s4m_runner_modelregistry_test`-database. Daar bestaat één eigen PLAN_CHAT/MANUAL/CODEX-testjob zonder repository-URL.
- Eén `run-one-job.ts`-invocation als agent, zonder poll-loop/restart. De stub schrijft de ontvangen argv en eindigt met exit 2; hij voert geen model of agent-tools uit.
- Gemeten: exact één spawn, precies één `--model gpt-6-astra`, runner-exit 2, container gestopt, restartcount 0.
- DB-readback: job QUEUED, eigenaar en lease gewist, retry_count 0, requested_model null; kindconfig blijft gpt-6-astra. Dit bewijst de bestaande rollback en het uitblijven van een tweede spawn/GPT-5.5-fallback, geen nieuwe terminale jobstatus.

Bewijsbestanden:
- [Runnerlog](./2026-10-01-modelregistry-runner.log)
- [Argv en containerstatus](./2026-10-01-modelregistry-runner-spawns.log)
- [Database-readback](./2026-10-01-modelregistry-runner-db.json)

Dit is implementatie- en testbewijs. Productie-uitrol, de echte positieve releasecanary en de open workers-startvoorwaarde horen bij T-171 en zijn niet uitgevoerd. Forgejo-CI is hiermee niet impliciet bewezen.
