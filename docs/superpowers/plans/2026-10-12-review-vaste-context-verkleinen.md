---
pbi:
  title: "Vaste context van QUEUE_REVIEW-jobs verkleinen"
  description: |
    Elke sealed reviewer (Claude en Codex) krijgt per ronde ~130k tokens vaste context binnen
    voordat hij één bronbestand opent. Een groot deel daarvan is dubbel: de repo-CLAUDE.md/AGENTS.md
    die de CLI zelf inlaadt, de git-bundle en de ondertekende input in /sources die de prompt laat
    "lezen en bevestigen", en gepinde contextdocumenten die al in /work staan. Dit increment haalt
    die dubbelingen weg en meet het effect op dezelfde review.
  priority: 2
sprint:
  goal: "Unieke context per Claude-review van ~130k naar ≤ 80k tokens zonder verlies van reviewkwaliteit, gemeten op het ISS-2-plan."
stories:
  - title: "Sealed child laadt geen repo-instructies en geen infrastructuurbronnen"
    description: |
      De reviewer in de container leest alleen wat de review nodig heeft: de prompt, de payload,
      de gepinde documenten en de checkout in /work. De repo-eigen CLAUDE.md/AGENTS.md en de
      git-bundle komen niet meer in zijn context.
    acceptance_criteria: |
      - De Claude-child start met CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 en --setting-sources user; de Codex-child met -c project_doc_max_bytes=0.
      - /sources bevat geen __repository_base meer; /work is nog steeds de checkout op base_sha (read-only).
      - Unit-tests in scrum4me-docker (__tests__/dispatch-child.test.ts, __tests__/dispatch-broker.test.ts) zijn aangepast en groen; npm test is groen.
      - docs/dispatch-runtime-operator.md beschrijft de nieuwe child-vlaggen.
    priority: 2
    tasks:
      - title: "Claude-child: CLAUDE.md en projectsettings uit"
        description: "buildClaudeEnv en buildClaudeArgs in scrum4me-docker/lib/dispatch-child.ts."
        implementation_plan: |
          Repo: scrum4me-docker (master). Bestanden: lib/dispatch-child.ts, __tests__/dispatch-child.test.ts, docs/dispatch-runtime-operator.md.
          1. Test eerst (rood): in __tests__/dispatch-child.test.ts, test 'builds the headless claude argv …' (±regel 100): voeg aan `base` na '--add-dir','/output' toe: '--setting-sources','user'. Test 'gives claude only home, path, …' (±regel 107): voeg aan het verwachte env-object toe CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1'. Test op ±regel 407 (spawn-env): voeg `expect(calls[0].env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1')` toe. Run: npm test -- dispatch-child → 3 tests rood.
          2. Implementatie: in buildClaudeArgs de vlag '--setting-sources','user' toevoegen ná '--add-dir','/output' (vóór model/effort). In buildClaudeEnv CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1' toevoegen naast CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. Commentaar bij beide: "/work is de repo-checkout; zijn CLAUDE.md en .claude/settings.json (hooks) zijn worker-instructies, geen reviewcontext. Gemeten: scrum4me-mcp CLAUDE.md = 48 KB per review."
          3. Run: npm test -- dispatch-child → groen. npm run typecheck (als aanwezig) → groen.
          4. docs/dispatch-runtime-operator.md: bij de beschrijving van de claude-child (sectie met buildClaudeArgs/"Headless claude") de twee vlaggen noemen en waarom. Bron van de vlaggen: Claude Code CLI-referentie (`--setting-sources`), env-vars (`CLAUDE_CODE_DISABLE_CLAUDE_MDS`).
          5. Commit: "feat(dispatch-child): claude-reviewer laadt geen CLAUDE.md en geen projectsettings".
          Verificatie: npm test groen; `git grep -n "DISABLE_CLAUDE_MDS" lib __tests__` geeft 1 implementatie- en 2 testtreffers.
        priority: 2
        verify_required: ALIGNED_OR_PARTIAL
        verify_only: false
      - title: "Codex-child: AGENTS.md uit"
        description: "buildCodexArgs in scrum4me-docker/lib/dispatch-child.ts."
        implementation_plan: |
          Repo: scrum4me-docker. Bestanden: lib/dispatch-child.ts, __tests__/dispatch-child.test.ts, docs/dispatch-runtime-operator.md (±regel 55, de codex exec-regel).
          1. Test eerst (rood): test 'builds the worker-shaped codex exec argv …' (±regel 122): verwachte argv krijgt na '--cd','/work' de twee elementen '-c','project_doc_max_bytes=0'. Controleer ook de variant met model/effort/chatgpt in dezelfde describe. Run: npm test -- dispatch-child → rood.
          2. Implementatie: in buildCodexArgs direct na '--cd','/work' toevoegen: '-c','project_doc_max_bytes=0'. Commentaar: "Codex concateneert elke AGENTS.md van projectroot tot cwd (codex-rs core agents_md.rs); 0 bytes = geen repo-instructies in de reviewcontext. scrum4me-mcp: AGENTS.md → CLAUDE.md, 48 KB."
          3. Run: npm test -- dispatch-child → groen.
          4. docs/dispatch-runtime-operator.md regel 55: de letterlijke codex exec-regel bijwerken met de nieuwe -c-optie.
          5. Commit: "feat(dispatch-child): codex-reviewer laadt geen AGENTS.md".
          Verificatie: npm test groen. Onbekend platformgedrag (accepteert Codex 0 als waarde?) wordt in de praktijkproef (story 4) gemeten vóór uitrol.
        priority: 2
        verify_required: ALIGNED_OR_PARTIAL
        verify_only: false
      - title: "Broker: __repository_base niet meer in /sources"
        description: "De git-bundle wordt in /work gematerialiseerd en hoort niet bij wat het model leest."
        implementation_plan: |
          Repo: scrum4me-docker. Bestanden: lib/dispatch-runtime-broker.ts (kopieerlus ±regel 207-215), __tests__/dispatch-broker.test.ts, __tests__/dispatch-child.test.ts (alleen lezen: listSourceArtifacts blijft ongewijzigd).
          1. Test eerst (rood): in __tests__/dispatch-broker.test.ts de bestaande create-test met een staged pin `__repository_base` uitbreiden (of een nieuwe `it` ernaast): na create bestaat `<attemptdir>/sources/__repository_base` NIET, `<attemptdir>/work` is wel gematerialiseerd op de pin, en de overige documentkeys staan wél in /sources. Run: npm test -- dispatch-broker → rood.
          2. Implementatie: in de `for(const key of input.sourceKeys)`-lus de validatie (realpath/device/inode/hash) ongewijzigd laten, maar het `cp` naar `/sources` overslaan wanneer `key===REPOSITORY_SOURCE_KEY` (import bestaat al op regel 11). Commentaar: "De bundle is de bron van /work (materializePreparedRepository hieronder); in /sources zou de prompt hem laten lezen — een Codex-reviewer las hem op 2026-10-09 'volledig'."
          3. Controleer dat de sourceKeys-validatie op ±regel 185 nog klopt (de key blijft toegestaan, alleen niet gekopieerd) en dat `materializePreparedRepository` uit `staged.pins` leest, niet uit /sources (regel 216-217).
          4. Run: npm test → groen.
          5. Commit: "fix(broker): repository-bundle niet in /sources van de child".
          Verificatie: npm test groen; in de praktijkproef (story 4) bevat `checks` van beide reviewers geen `source:__repository_base` meer.
        priority: 2
        verify_required: ALIGNED_OR_PARTIAL
        verify_only: false
  - title: "Reviewprompt leest de input één keer en opent geen infrastructuurbronnen"
    description: |
      queue/review.md en queue/review.codex.md laten het model nu de payload lezen, hem vergelijken met
      /sources/__dispatch_input en "elke source key lezen en bevestigen", inclusief de git-bundle.
      Na dit werk is payload.json de enige inputbron en gelden lees- en checks-plicht alleen voor documentkeys.
    acceptance_criteria: |
      - Beide prompts: geen verwijzing meer naar het lezen of vergelijken van /sources/__dispatch_input; keys die met `__` beginnen worden benoemd als infrastructuur die niet geopend wordt en geen checks-regel krijgt.
      - __tests__/kind-prompts.test.ts pint dit voor QUEUE_REVIEW in beide runtimes.
      - De prompts blijven inhoudelijk gelijk tussen runtimes (zelfde regels, andere toon).
      - De dispatch-image is herbouwd met de nieuwe prompts (mcp-prompts-stage, MCP_CACHE_BUST) en uitgerold op scrum4me-server — operatorstap, alleen na akkoord van JP.
    priority: 2
    tasks:
      - title: "Prompts: payload is de enige input, __-keys niet lezen"
        description: "src/prompts/queue/review.md en review.codex.md plus test."
        implementation_plan: |
          Repo: scrum4me-mcp (main). Bestanden: src/prompts/queue/review.md, src/prompts/queue/review.codex.md, __tests__/kind-prompts.test.ts.
          1. Test eerst (rood): nieuwe `it('QUEUE_REVIEW-prompts: payload is de enige input, __-keys worden niet geopend', …)` die voor runtime CLAUDE en CODEX `getKindPromptText('QUEUE_REVIEW', rt)` leest en asserteert: bevat 'Keys that start with `__`' (of de gekozen vaste zin), bevat NIET 'that file wins' en NIET 'if the two ever differ', bevat nog '$PAYLOAD_PATH' en 'review.verdict'. Run: npm test -- kind-prompts → rood.
          2. review.md (CLAUDE): sectie "Input": de zin over `/sources/__dispatch_input` ("It is the same JSON as the signed task file …; if the two ever differ, that file wins") vervangen door: "Keys that start with `__` (`__dispatch_input`, `__repository_base`) are infrastructure: the signed task and the repository bundle. Do not open them; they get no `checks` entry. `payload.json` is your only copy of the task." Sectie "Work" stap 1: "List every source key you were given" → "List every document key (keys without the `__` prefix) with its sha256 and confirm you read it." Sectie "Output manifest", regel over checks: "one entry per source key" → "one entry per document key". Zelfde wijziging, in de bestaande toon, in review.codex.md.
          3. Run: npm test -- kind-prompts → groen. npm run typecheck:tests → groen.
          4. Commit: "fix(prompts): queue-reviewers lezen de payload één keer en openen geen __-bronnen".
          Verificatie: `grep -n "that file wins\|every source key" src/prompts/queue/review*.md` geeft 0 treffers.
        priority: 2
        verify_required: ALIGNED_OR_PARTIAL
        verify_only: false
      - title: "Dispatch-image herbouwen en uitrollen (JP-gate)"
        description: "Operatorstap op scrum4me-server; pas na akkoord van JP op de gemeten proef van story 4 in een lokale run."
        implementation_plan: |
          Repo: scrum4me-docker. Niets wijzigt in code; dit is de uitrol van story 1 en story 2.
          1. Wacht op akkoord van JP (hardstop). Zonder akkoord stopt deze taak hier.
          2. Volg het bestaande herbouwrecept in docs/dispatch-runtime-operator.md voor Dockerfile.dispatch: build met `--build-arg MCP_CACHE_BUST=<epoch>` zodat de mcp-prompts-stage scrum4me-mcp main opnieuw kloont (Dockerfile.dispatch regel 21-28), voor de stages model-codex én model-claude.
          3. Rol uit volgens hetzelfde document (supervisor/broker herstart per slot); controleer in de slot-log dat `DISPATCH_CHILD_RUNTIME`, model en effort ongewijzigd zijn.
          4. Draai `npm run test:dispatch-model-image` (T-1869) als de image-hashes zijn gewijzigd; verwacht groen voor beide probes.
          5. Registreer de uitrol met datum, image-digests en MCP-commit in docs/dispatch-runtime-operator.md onder de bestaande uitrolhistorie.
          Verificatie: één echte QUEUE_REVIEW per runtime op scrum4me-server eindigt DONE met `checks` zonder `__`-keys (zie story 4).
        priority: 2
        verify_required: ANY
        verify_only: false
  - title: "Review-loop-skill pint alleen het document onder review"
    description: |
      De orchestrator op de Mac pint nu tot 8 documenten (M50-1b: ≈ 330 KB) die ook al in /work staan,
      en laat het Review record in het gereviewde document meegroeien. Dit is een doc-only wijziging
      van de skill en de rondebody-template (niet onder git: ~/.claude/skills/review-loop/).
    acceptance_criteria: |
      - SKILL.md stap 2: review_documents = het document onder review, plus alleen bronnen die NIET in de /work-checkout staan (product_doc-pins of docs uit een andere repo); de delta-variant mag de vorige revisie als tweede pin meegeven.
      - round-body-template.md: "Context documents (binding)" verwijst naar pad + sectie in /work; de verwijzing naar docs/runbooks/adversarial-review-loop.md is geschrapt; kalibratie- en severity-regels staan alleen in `verification`, niet ook in de body.
      - Review record: staat in docs/reviews/<datum>-<slug>-review-record.md naast het document, wordt niet gepind; de body vat de vorige ronde samen zoals nu.
      - De wijziging is gedocumenteerd in de skill zelf met datum en de meetcijfers uit story 4.
    priority: 2
    tasks:
      - title: "SKILL.md en round-body-template.md aanpassen"
        description: "Pin-beleid, Review record-locatie, runbook-verwijzing en dubbele kalibratie."
        implementation_plan: |
          Locatie: ~/.claude/skills/review-loop/SKILL.md en references/round-body-template.md (Mac, niet onder git — maak vooraf een kopie naar ~/.claude/review-loop-<datum>-backup/).
          1. SKILL.md, sectie "Round protocol" stap 2, bullet `review_documents`: vervang "the reviewed `.md` file and the binding context docs as `source: git` pins … at most 8" door: "the reviewed `.md` file; add a second `git` pin only for a source that is not in the pinned checkout (another repository, or the previous revision in a delta round) and `product_doc` pins for database-only documents. Documents in `/work` are referenced by path and section in the body, never pinned: the checkout is already pinned by `base_sha`."
          2. SKILL.md, sectie "Review record": eerste zin vervangen door "The review record lives in `docs/reviews/<date>-<slug>-review-record.md` next to the document; it is never pinned. Per round: …" (rest ongewijzigd). Voeg aan "Common mistakes" toe: "Review record inside the reviewed document | Every round re-reads all earlier triage; keep it in the sibling file."
          3. round-body-template.md: in "Context documents (binding)" item 3 (`docs/runbooks/adversarial-review-loop.md`) schrappen; item 2 `CLAUDE.md` vervangen door "`CLAUDE.md` §<sectie> — only the hardstop rules the document touches (path reference, not a pin)". In de `dispatch_review`-template de `review_documents` beperken tot één item (het document) met een regel eronder: "second item only for a source outside `/work`".
          4. Kalibratie dubbel: de regels "MINOR findings are fully compatible with GO … a false MAJOR costs a round" en de severity-definities blijven in `verification`; in de body-skeleton sectie "Finding format — strict" alleen de formaatregels houden en één verwijzing: "Severity and calibration: see the verification field."
          5. Onder "Both slots are dispatch jobs" een regel met datum: "2026-10-xx: pins beperkt tot het document onder review; gemeten effect: <cijfers uit story 4>."
          Verificatie: `grep -n "adversarial-review-loop" SKILL.md references/round-body-template.md` geeft alleen nog de 'Deep reference'-regel in SKILL.md; `grep -c "at most 8"` = 0.
        priority: 2
        verify_required: ANY
        verify_only: false
  - title: "Praktijkproef: zelfde review vóór en na, gemeten in tokens"
    description: |
      Eén document, één rondebody, één Claude- en één Codex-review vóór en ná de wijzigingen.
      De maat is de unieke context: `cache_write_tokens` (Claude) en `input_tokens` (Codex, niet-gecachet)
      in claude_jobs, plus de verdict-geldigheid.
    acceptance_criteria: |
      - Nulmeting en nameting op hetzelfde document (ISS-2-plan rev 5, commit b3caa8c) met byte-gelijke body en verification.
      - Claude: cache_write_tokens nameting ≤ 60% van de nulmeting; Codex: input_tokens ≤ 70%.
      - Beide nametingen eindigen outcome succeeded met een verdict GO of NO-GO en `checks` uitsluitend voor documentkeys.
      - Cijfers en job-ids staan in docs/reviews/2026-10-xx-review-context-meting.md in scrum4me-mcp.
    priority: 2
    tasks:
      - title: "Nulmeting en nameting uitvoeren en vastleggen"
        description: "Kost ≈ 2 × $2,85 lijstprijs; alleen met akkoord van JP."
        implementation_plan: |
          Repo: scrum4me-mcp. Bestand: docs/reviews/2026-10-xx-review-context-meting.md (nieuw).
          1. Nulmeting: vóór uitrol van story 1/2 één `dispatch_review` per runtime (CODEX, CLAUDE) op docs/superpowers/plans/2026-10-09-iss-2-cancel-unstarted.md @ b3caa8c (sha256 via `git show b3caa8c:docs/superpowers/plans/2026-10-09-iss-2-cancel-unstarted.md | shasum -a 256`), `repository.base_sha` = b3caa8c, body = de ronde-4-body van die loop (uit het Review record te reconstrueren) met de nieuwe pin-regel van story 3 al toegepast (dus alleen het plan gepind), reply_to mac:claude, nieuwe idempotency_keys. Noteer request-, root- en job-ids.
          2. Na uitrol van story 1 en 2 (JP-gate in story 2 taak 2): exact dezelfde aanroepen opnieuw, nieuwe keys.
          3. Lees per job via de scrum4me-DB (lezen is door JP toegestaan op 2026-10-12): `select id, runtime, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, extract(epoch from (finished_at-started_at))/60 from claude_jobs where id in (...)`. Lees de vier `reviewed`-replies met queue_wait_reply op de root_message_ids en controleer `meta.result.checks`.
          4. Schrijf het meetdocument: tabel vóór/na per runtime (unieke context, cache-reads, output, minuten, kosten op lijstprijs: Claude 4/0,4/5/20 USD per Mtok in/cache-read/cache-write/out; Codex 2/0,1/—/10), de vier job-ids, de verdicts, en de conclusie tegen de acceptatiegrenzen (≤ 60% resp. ≤ 70%).
          5. Haalt een grens niet: meld het aan JP met de gemeten delta per maatregel (zet desnoods één maatregel tijdelijk terug via een extra meting) in plaats van de grens te verschuiven.
          Verificatie: het meetdocument bestaat, bevat vier job-ids en beide verdicts, en de SQL-uitkomst is er letterlijk in geplakt.
        priority: 2
        verify_required: ANY
        verify_only: false
---

# Vaste reviewcontext verkleinen — implementatieplan

> **Voor agentische workers:** gebruik superpowers:subagent-driven-development of superpowers:executing-plans om dit plan taak voor taak uit te voeren. Alleen increment 1 is uitgewerkt; increment 2 staat als richting onderaan.

**Doel:** de vaste, niet-reviewgebonden context die elke sealed `QUEUE_REVIEW`-reviewer per ronde inlaadt terugbrengen van ~130k naar ≤ 80k tokens, gemeten op dezelfde review, zonder het DispatchResult-contract of de read-only-grens te raken.

**Architectuur:** drie kleine ingrepen op de plek waar de dubbeling ontstaat: (1) de child-CLI laadt geen repo-instructies (`CLAUDE.md`/`AGENTS.md`/projecthooks); (2) de broker legt de git-bundle niet in `/sources` en de prompt laat `__`-bronnen dicht; (3) de orchestrator-skill pint alleen het document onder review. Een praktijkproef op één document bewijst het effect vóór de uitrol op scrum4me-server.

**Tech stack:** scrum4me-docker (`lib/dispatch-child.ts`, `lib/dispatch-runtime-broker.ts`, vitest), scrum4me-mcp (`src/prompts/queue/*.md`, vitest), review-loop-skill op de Mac (markdown), Postgres `claude_jobs` voor de meting.

**Spec:** dit plan steunt op de analyse van 2026-10-12 in de hoofdsessie (geen apart specdocument). De gemeten uitgangssituatie staat hieronder, zodat het plan zelfstandig leesbaar is.

## Uitgangssituatie (gemeten 2026-10-12, alle DONE QUEUE_REVIEW-jobs sinds 2026-10-03)

| | Claude (claude-opus-5-5), n=129 | Codex (gpt-6.1-sol), n=151 |
|---|---|---|
| Unieke context (cache-write / niet-gecachete input) | 132k tokens | 118k tokens |
| Cache-reads (context opnieuw gelezen per tool-beurt) | 2,63M | 1,25M |
| Output | 34k | 7,8k (+2k reasoning) |
| Duur | 6,2 min | 4,2 min |
| Kosten per review (API-lijstprijs) | ≈ $2,40 | ≈ $0,45 |

Bronnen van de vaste instroom per Claude-review (bytes, M50-1b-ronde): rondebody 12–19 KB (twee keer: `payload.json` en `/sources/__dispatch_input`), pins ≈ 330 KB die allemaal ook in `/work` staan, `__repository_base` (git-bundle, de prompt eist "confirm you read it"), `/work/CLAUDE.md` auto-geladen (17 KB Scrum4Me, 48 KB scrum4me-mcp, 33 KB Scrum4Us), kind-prompt 4 KB. Elke 50k tokens minder vaste context scheelt per Claude-review ≈ $0,25 cache-write plus ≈ $0,40 cache-reads.

## Globale randvoorwaarden

- De child blijft read-only buiten `/output`; geen nieuwe netwerkpaden; `--allowedTools`, `--disallowedTools` en de credential-mount (`/run/provider`) wijzigen niet.
- Het `DispatchResult`-contract (shared `queue-dispatch-validation.ts`) wijzigt niet; `review.documents` blijft byte-gelijk aan de pins; `checks` blijft een vrije lijst (de validator eist geen entry per source).
- Beide runtime-prompts blijven inhoudelijk gelijk; een regel die in `review.md` verandert, verandert ook in `review.codex.md`.
- Tests: `npm test` groen in scrum4me-docker en scrum4me-mcp; `npm run typecheck:tests` in scrum4me-mcp. `npm run test:dispatch` (servicekant) is niet nodig: `src/dispatch/*` van de MCP wijzigt niet.
- Uitrol op scrum4me-server en het uitgeven van ≈ $6 aan proefreviews zijn JP-gates.

## Review focus

1. `--setting-sources user` mag de tool-allowlist en permission-mode uit argv niet raken; de spawn-test (`calls[0]`) pint de argv, de praktijkproef bewijst dat de reviewer nog `Read`/`Bash` in `/work` kan.
2. `CLAUDE_CODE_DISABLE_CLAUDE_MDS` is gedocumenteerd maar niet gemeten op CLI 2.1.287: de nameting op scrum4me-mcp (48 KB `CLAUDE.md`) moet een zichtbare daling in `cache_write_tokens` geven; blijft die uit, dan is `--safe-mode` het alternatief (schakelt ook hooks en skills uit).
3. Codex kan `project_doc_max_bytes=0` weigeren als configuratiewaarde; dan eindigt de child met `DISPATCH_CHILD_RESULT_MISSING`. De nameting vangt dit; fallback is een leeg `AGENTS.md`-overschrijven in de child-home, niet in `/work`.
4. De broker valideert `sourceKeys` tegen `config.sources` en `staged.pins` (regel 185); het overslaan van het `cp` voor `__repository_base` mag die validatie niet veranderen en `materializePreparedRepository` leest uit `staged.pins`, niet uit `/sources`.
5. De live-smoke `tests/dispatch-live-review.smoke.ts` en de `dispatch-model-image`-probe mogen geen `checks`-entry voor `__dispatch_input` vereisen; controleer hun `gates` vóór de promptwijziging.

## Taakvolgorde en afhankelijkheden

1. Story 4 taak 1 stap 1 (nulmeting) kan direct, nog vóór enige codewijziging, met het pin-beleid van story 3 al toegepast in de body.
2. Story 1 (drie taken) en story 2 taak 1 zijn onafhankelijk en kunnen parallel; beide repo's, geen gedeelde bestanden.
3. Story 3 is doc-only en kan parallel.
4. Story 2 taak 2 (herbouw + uitrol) pas na JP-akkoord, daarna story 4 stap 2–5 (nameting).

## Increment 2 (richting, niet uitgewerkt)

- Rondebody: "Fragments from other repositories" en JP's doel/beslissingen als klein gepind `.md` in de repo in plaats van elke ronde in de body; `summary` in de kind-prompt begrenzen tot ≤ 1.000 tekens (nu ≤ 4.000, grotendeels een herhaling van het rapport).
- `get_job_status` geeft de usage-kolommen terug, zodat de loop per ronde de kosten in het Review record zet zonder DB-toegang.
- Nameting over een volledige loop (≥ 4 ronden) in plaats van één review, en een vaste plek voor deze cijfers in `docs/dispatch-runtime-operator.md`.
