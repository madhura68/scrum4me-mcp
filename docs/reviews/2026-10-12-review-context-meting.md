# Review-context meting — nulmeting en nameting (IDEA-252, story 4)

Zelfde document, zelfde bytes, één Claude- en één Codex-review vóór (nulmeting) en ná (nameting) de wijzigingen van story 1 en 2. Input: `docs/reviews/2026-10-12-review-context-meting-body.md` (objective en verification tussen de markeringen), pin `plan` = `docs/superpowers/plans/2026-10-09-iss-2-cancel-unstarted.md` @ `b3caa8cb47e46b9e214e719e8db810210dad1493` (sha256 `a587bf14be7fbcca51b2cd5cdb2e86c33ef7b559485ed4fbb4c73e85a85a8c7f`), `repository.base_sha` = dezelfde commit, `reply_to` mac:claude.

Beslissende maat (Claude): de context van de eerste modelbeurt — `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` van het eerste `assistant`-event in de child-transcript, bewaard in de run-log op scrum4me-server (`/srv/scrum4me/worker-logs/dispatch/<slot>/runs/<ts>.log`). Die som telt vóór enige tool-aanroep en is onafhankelijk van de prompt-cache-warmte (de ≈ 13k CLI-prefix staat warm in cache_read, koud in cache_creation) en van de bronlezingen van de reviewer. Diagnose: `claude_jobs`-totalen (`cache_write_tokens + input_tokens` Claude; `input_tokens` Codex, niet-gecachet: de supervisor trekt `cached_input_tokens` af, scrum4me-docker `lib/dispatch-usage.ts` regel 33-34). Codex heeft één `turn.completed` per run en dus geen per-aanroep-maat. Kosten op API-lijstprijs: Claude 4 / 0,4 / 5 / 20 USD per Mtok (in / cache-read / cache-write / out); Codex 2 / 0,1 / — / 10.

## Nulmeting — 2026-10-12, huidige images (vóór enige codewijziging)

Dispatch op JP's woord ("start eerst een review loop en dan doe de nulmeting", 2026-10-12).

| runtime | request | root_message | job | verdict | outcome | checks |
|---|---|---|---|---|---|---|
| CODEX | `33c8336d-7b3e-4917-b07d-0dfe555ea5a1` | `0bca1579-2f2c-433f-a737-ba610ce9f915` | `cb9487bc-9c67-4773-9efd-a897aebfa786` | GO | succeeded | `source:__dispatch_input`, `source:__repository_base`, `source:plan` passed; `repository:pin` passed; 3× not_run (typecheck/test/test:dispatch) |
| CLAUDE | `4eb5b45c-e885-4781-80bf-4a1959b95903` | `32f8e638-3a5d-4b08-9ed0-cb60020c7592` | `84f67fa4-216e-4d93-b93a-565de3de142c` | GO | succeeded | `source:__dispatch_input`, `source:__repository_base`, `source:plan` passed; 1× not_run (verify) |

Beide reviewers bevestigden het lezen van `__dispatch_input` en `__repository_base` (de git-bundle) als bron — precies de dubbeling die story 1 taak 3 en story 2 wegnemen.

Eerste modelbeurt uit de run-logs (scrum4me-server, read-only, 2026-10-12 ≈ 20:40 UTC; `grep -m1 '"type":"assistant"' <log> | grep -o '"usage":{[^}]*}'`):

```
/srv/scrum4me/worker-logs/dispatch/b41d91ae-8c49-41dc-a30a-5a22ccbd2f0b/runs/20261012T201245Z.log  (CLAUDE, job 84f67fa4-…, attempt 8dd6d239-3cb9-42fd-aa0d-3d27f74986d4)
  first assistant: "usage":{"input_tokens":2,"cache_creation_input_tokens":24639,"cache_read_input_tokens":13241,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":24639}
  result:          "usage":{"input_tokens":38,"cache_creation_input_tokens":112537,"cache_read_input_tokens":1491303,"output_tokens":23595,"output_tokens_details":{"thinking_tokens":11420}
/srv/scrum4me/worker-logs/dispatch/df088ae3-a27e-48f0-9f22-22be92834003/runs/20261012T200245Z.log  (CODEX, job cb9487bc-…, attempt fe6b0087-657b-4156-8367-f19efea09bb5)
  turn.completed:  "usage":{"input_tokens":581617,"cached_input_tokens":504064,"cache_write_input_tokens":0,"output_tokens":4870,"reasoning_output_tokens":556}
```

**Claude eerste-beurt-context nulmeting: 2 + 24.639 + 13.241 = 37.882 tokens.** `system/init` van dezelfde run-log: `claude_code_version` 2.1.287, model claude-opus-5-5, 24 tools, 17 skills, 2 plugins, 5 agents, 45 slash_commands — de nameting moet dezelfde versie en aantallen tonen, anders is de delta vervuild. Ter vergelijking telden twee andere Claude-reviewjobs van dezelfde avond in hun eerste beurt 38.272 (job 11df00ec, 20:02Z) en 38.266 (job 1f33f101, 20:32Z): de maat is stabiel op ±0,5k, terwijl de totalen 107k–113k uiteenlopen.

SQL (scrum4me-DB, read-only, 2026-10-12 ≈ 20:30 UTC):

```
select id, runtime, model_id, status, usage_capture_status st, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_output_tokens,
  round(extract(epoch from (finished_at-started_at))/60,1) minutes, started_at
from claude_jobs where id in ('cb9487bc-9c67-4773-9efd-a897aebfa786','84f67fa4-216e-4d93-b93a-565de3de142c') order by started_at;

                  id                  | runtime |    model_id     | status |    st    | input_tokens | cache_read_tokens | cache_write_tokens | output_tokens | reasoning_output_tokens | minutes |       started_at
--------------------------------------+---------+-----------------+--------+----------+--------------+-------------------+--------------------+---------------+-------------------------+---------+-------------------------
 cb9487bc-9c67-4773-9efd-a897aebfa786 | CODEX   | gpt-6.1-sol     | DONE   | captured |        77553 |            504064 |                  0 |          4870 |                     556 |     2.9 | 2026-10-12 20:02:45.708
 84f67fa4-216e-4d93-b93a-565de3de142c | CLAUDE  | claude-opus-5-5 | DONE   | captured |           38 |           1491303 |             112537 |         23595 |                         |     3.9 | 2026-10-12 20:12:46.464
```

| | Claude (nulmeting) | Codex (nulmeting) |
|---|---|---|
| Eerste-beurt-context (beslissend, Claude) | **37.882** | — (één turn.completed) |
| Unieke context over de hele job (diagnose) | 112.575 (cache_write 112.537 + input 38) | 77.553 (input, niet-gecachet); input+cached 581.617 |
| Cache-reads | 1.491.303 | 504.064 |
| Output | 23.595 | 4.870 (+556 reasoning) |
| Duur | 3,9 min | 2,9 min |
| Kosten (lijstprijs) | ≈ $1,63 (0,56 write + 0,60 reads + 0,47 out) | ≈ $0,26 (0,16 in + 0,05 reads + 0,05 out) |

Duiding (verwachting, geen meting van de componenten): de eerste beurt van 37.882 bevat `/work/CLAUDE.md` op b3caa8c (46.768 B ≈ 11,5k tokens; de CLI laadt hem automatisch, bevestigd door de reviewers zelf), de kind-prompt (≈ 1k) en het CLI-aandeel (systeemprompt, tool-schema's, lijsten; ≈ 25k, waarvan ≈ 13k als gedeelde prefix in de cache). De body zit niet in de eerste beurt: het model leest `$PAYLOAD_PATH` met een tool. Story 1 taak 1 moet daarvan ≈ 11,5k wegnemen; de tweede lezing van de body (≈ 1k) valt in latere beurten weg. De totalen over de hele job (112.6k) bestaan verder uit de broncode die de reviewer voor déze review leest en uit cache-warmte; een absolute grens van 80k op die totalen wordt door story 1 en 2 niet als verwacht resultaat gedragen. De acceptatie in het plan (rev 5) is daarom een daling van ≥ 10k in de eerste-beurt-context.

## Nameting — 2026-10-12 ≈ 22:17 UTC, na uitrol van story 1 en 2

Zelfde aanroepen en bytes als de nulmeting (objective en verification byte-gelijk aan de nulmeting-aanroep en aan het bevroren bestand), nieuwe idempotency_keys (CODEX `d77b56ce-a040-4f7c-843d-795744b74763`, CLAUDE `5e17b0ed-1ff8-49ce-b13d-200ecfb61dcd`). Enige verschil in de aanroep: `work_item.task_id` = T-180, een traceerlabel dat niet in de dispatch-input van de child komt. Beide liepen op de nieuwe profielrevisies (CODEX `971357ec`, image `5cffba8ffaf6`; CLAUDE `1c7ffe52`, image `e5d8cc4ba342`; uitrol T-185, scrum4me-docker `docs/dispatch-runtime-operator.md` › rollout record).

| runtime | request | root_message | job | verdict | outcome | checks |
|---|---|---|---|---|---|---|
| CODEX | `c9ef6136-f360-4f0f-8ef8-d92fcebf950c` | `e0ed0486-291e-44cb-acd5-cc668e30fa40` | `ca5c7a17-eff4-4c5d-a522-2e08da703737` | GO | succeeded | `source:plan` passed; 3× not_run (typecheck/test/test:dispatch) |
| CLAUDE | `7dfc3be9-5245-4ad2-bae0-35fa3d70f2ed` | `f96b5009-fd28-4cf9-8f6f-f607afcfcecd` | `b6ca82a2-38b6-4a8e-9aea-4d3eda4e3314` | GO | succeeded | `source:plan` passed; 1× not_run (verify), 1× not_run (external supervisor-vorm) |

Geen van beide noemde `__dispatch_input` of `__repository_base` als gelezen bron. Inhoudelijk vonden beide dezelfde kern als in de nulmeting (GO, geen BLOCKER/MAJOR), elk met MINORs; de Claude-reviewer merkte daarnaast op dat b3caa8c de rev-5-implementatie al bevat.

Eerste modelbeurt uit de run-logs (scrum4me-server, read-only, 2026-10-12 ≈ 22:25 UTC):

```
/srv/scrum4me/worker-logs/dispatch/b41d91ae-8c49-41dc-a30a-5a22ccbd2f0b/runs/20261012T221728Z.log  (CLAUDE, job b6ca82a2-…, attempt f3b0f4ec-09f2-47ea-8d6a-a260617edd1e)
  first assistant: "usage":{"input_tokens":2,"cache_creation_input_tokens":5053,"cache_read_input_tokens":13241,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":5053}
  result:          "usage":{"input_tokens":32,"cache_creation_input_tokens":81756,"cache_read_input_tokens":931880,"output_tokens":17352,"output_tokens_details":{"thinking_tokens":8321},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}
  system/init:     claude_code_version 2.1.287, model claude-opus-5-5, 24 tools, 17 skills, 2 plugins, 5 agents, 45 slash_commands
/srv/scrum4me/worker-logs/dispatch/df088ae3-a27e-48f0-9f22-22be92834003/runs/20261012T221718Z.log  (CODEX, job ca5c7a17-…, attempt 159cb488-7713-4f1a-808d-df7e8c5febb7)
  turn.completed:  "usage":{"input_tokens":394005,"cached_input_tokens":327296,"cache_write_input_tokens":0,"output_tokens":4005,"reasoning_output_tokens":282}
```

**Claude eerste-beurt-context nameting: 2 + 5.053 + 13.241 = 18.296 tokens**, bij dezelfde CLI-versie en dezelfde tool/skill/plugin/agent/command-aantallen als de nulmeting. De gedeelde CLI-prefix in de cache (13.241) is gelijk gebleven; het verschil zit volledig in het niet-gecachete deel (24.639 → 5.053).

SQL (scrum4me-DB, read-only, 2026-10-12 ≈ 22:25 UTC):

```
select id, runtime, status, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, round((extract(epoch from (finished_at-started_at))/60)::numeric,1) as minutes from claude_jobs where id in ('cb9487bc-9c67-4773-9efd-a897aebfa786','84f67fa4-216e-4d93-b93a-565de3de142c','ca5c7a17-eff4-4c5d-a522-2e08da703737','b6ca82a2-38b6-4a8e-9aea-4d3eda4e3314') order by started_at;

                  id                  | runtime | status | input_tokens | cache_read_tokens | cache_write_tokens | output_tokens | minutes 
--------------------------------------+---------+--------+--------------+-------------------+--------------------+---------------+---------
 cb9487bc-9c67-4773-9efd-a897aebfa786 | CODEX   | DONE   |        77553 |            504064 |                  0 |          4870 |     2.9
 84f67fa4-216e-4d93-b93a-565de3de142c | CLAUDE  | DONE   |           38 |           1491303 |             112537 |         23595 |     3.9
 ca5c7a17-eff4-4c5d-a522-2e08da703737 | CODEX   | DONE   |        66709 |            327296 |                  0 |          4005 |     1.7
 b6ca82a2-38b6-4a8e-9aea-4d3eda4e3314 | CLAUDE  | DONE   |           32 |            931880 |              81756 |         17352 |     2.9
(4 rows)
```

| | Claude (nameting) | Codex (nameting) |
|---|---|---|
| Eerste-beurt-context (beslissend, Claude) | **18.296** | — (één turn.completed) |
| Unieke context over de hele job (diagnose) | 81.788 (cache_write 81.756 + input 32) | 66.709 (input, niet-gecachet); input+cached 394.005 |
| Cache-reads | 931.880 | 327.296 |
| Output | 17.352 | 4.005 (+282 reasoning) |
| Duur | 2,9 min | 1,7 min |
| Kosten (lijstprijs) | ≈ $1,13 (0,41 write + 0,37 reads + 0,35 out) | ≈ $0,21 (0,13 in + 0,03 reads + 0,04 out) |

Duiding: de daling van 19.586 is groter dan de verwachte ≈ 11,5k voor `/work/CLAUDE.md`. Die verwachting rekende met ≈ 4 bytes per token; Nederlandstalige markdown met code-fragmenten tokeniseert dichter, dus CLAUDE.md alleen kan het grootste deel verklaren. De componenten zijn niet afzonderlijk gemeten. De diagnose-totalen dalen ook, maar zijn n=1 en hangen af van wat de reviewer per run leest.

## Conclusie tegen de acceptatie

| criterium | nulmeting | nameting | pass/fail |
|---|---|---|---|
| Claude: eerste-beurt-context ≥ 10.000 lager dan nulmeting (beslissend; zelfde CLI-versie en tool/skill/plugin-aantallen) | 37.882 (2.1.287, 24/17/2) | 18.296 (2.1.287, 24/17/2); −19.586 | **pass** |
| Claude: totalen cache_write + input (diagnose) | 112.575 | 81.788 | diagnose: −30.787 |
| Codex: input_tokens / input+cached (diagnose) | 77.553 / 581.617 | 66.709 / 394.005 | diagnose: −10.844 / −187.612 |
| beide: outcome succeeded, verdict GO/NO-GO | GO / GO | GO / GO | **pass** |
| beide: precies één `source:<key>` per documentkey, geen `source:__*`; andere namen toegestaan | nee (bevat `source:__*`) | ja: elk precies `source:plan` | **pass** |
| diagnose: verhouding nameting/nulmeting per runtime | — | Claude eerste beurt 0,48, totalen 0,73, kosten 0,69; Codex input 0,86, input+cached 0,68, kosten 0,81 | — |

n=1 per runtime is indicatief. De beslissende daling ligt ruim boven 11k, dus een bevestigingspaar is volgens de acceptatie niet nodig.
