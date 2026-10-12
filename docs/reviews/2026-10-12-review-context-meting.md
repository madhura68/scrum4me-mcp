# Review-context meting — nulmeting en nameting (IDEA-252, story 4)

Zelfde document, zelfde bytes, één Claude- en één Codex-review vóór (nulmeting) en ná (nameting) de wijzigingen van story 1 en 2. Input: `docs/reviews/2026-10-12-review-context-meting-body.md` (objective en verification tussen de markeringen), pin `plan` = `docs/superpowers/plans/2026-10-09-iss-2-cancel-unstarted.md` @ `b3caa8cb47e46b9e214e719e8db810210dad1493` (sha256 `a587bf14be7fbcca51b2cd5cdb2e86c33ef7b559485ed4fbb4c73e85a85a8c7f`), `repository.base_sha` = dezelfde commit, `reply_to` mac:claude.

Maat: unieke context = `cache_write_tokens + input_tokens` (Claude) en `input_tokens` (Codex; de supervisor trekt `cached_input_tokens` af, scrum4me-docker `lib/dispatch-usage.ts` regel 33-34). Kosten op API-lijstprijs: Claude 4 / 0,4 / 5 / 20 USD per Mtok (in / cache-read / cache-write / out); Codex 2 / 0,1 / — / 10.

## Nulmeting — 2026-10-12, huidige images (vóór enige codewijziging)

Dispatch op JP's woord ("start eerst een review loop en dan doe de nulmeting", 2026-10-12).

| runtime | request | root_message | job | verdict | outcome | checks |
|---|---|---|---|---|---|---|
| CODEX | `33c8336d-7b3e-4917-b07d-0dfe555ea5a1` | `0bca1579-2f2c-433f-a737-ba610ce9f915` | `cb9487bc-9c67-4773-9efd-a897aebfa786` | GO | succeeded | `source:__dispatch_input`, `source:__repository_base`, `source:plan` passed; `repository:pin` passed; 3× not_run (typecheck/test/test:dispatch) |
| CLAUDE | `4eb5b45c-e885-4781-80bf-4a1959b95903` | `32f8e638-3a5d-4b08-9ed0-cb60020c7592` | `84f67fa4-216e-4d93-b93a-565de3de142c` | GO | succeeded | `source:__dispatch_input`, `source:__repository_base`, `source:plan` passed; 1× not_run (verify) |

Beide reviewers bevestigden het lezen van `__dispatch_input` en `__repository_base` (de git-bundle) als bron — precies de dubbeling die story 1 taak 3 en story 2 wegnemen.

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
| Unieke context | **112.575** (cache_write 112.537 + input 38) | **77.553** (input, niet-gecachet) |
| Cache-reads | 1.491.303 | 504.064 |
| Output | 23.595 | 4.870 (+556 reasoning) |
| Duur | 3,9 min | 2,9 min |
| Kosten (lijstprijs) | ≈ $1,63 (0,56 write + 0,60 reads + 0,47 out) | ≈ $0,26 (0,16 in + 0,05 reads + 0,05 out) |

Duiding: op dit één-pin-document is de unieke Claude-context 112.6k, waarvan de vaste, niet-reviewgebonden delen die story 1 en 2 wegnemen ≈ 12k (`/work/CLAUDE.md`, 47.667 B) plus ≈ 1,5k (de tweede lezing van de body via `__dispatch_input`) plus de bundle-bevestiging zijn; de rest is het CLI-aandeel (≈ 20k) en de broncode die de reviewer voor déze review leest. Een absolute grens van 80k is op dit document dus niet door story 1 en 2 alleen te halen; de acceptatie in het plan (rev 4) is daarom een gemeten daling, geen absolute grens.

## Nameting — <datum>, na uitrol van story 1 en 2

_(nog niet uitgevoerd; zelfde aanroepen, zelfde bytes, nieuwe idempotency_keys)_

| runtime | request | root_message | job | verdict | outcome | checks |
|---|---|---|---|---|---|---|
| CODEX | | | | | | |
| CLAUDE | | | | | | |

SQL-uitkomst: _(letterlijk plakken)_

## Conclusie tegen de acceptatie

| criterium | nulmeting | nameting | pass/fail |
|---|---|---|---|
| Claude: unieke context ≥ 10.000 lager dan nulmeting | 112.575 | | |
| Codex: input_tokens lager dan nulmeting | 77.553 | | |
| beide: outcome succeeded, verdict GO/NO-GO | GO / GO | | |
| beide: `checks` zonder `__`-keys, één per documentkey | nee (bevat `__`-keys) | | |
| diagnose: verhouding nameting/nulmeting per runtime | — | | |
