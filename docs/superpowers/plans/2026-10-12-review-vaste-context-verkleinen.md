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
  goal: "Unieke context per Claude-review ≤ 80k tokens (historisch gemiddelde 132k over alle rondes), gemeten op het ISS-2-plan, zonder verlies van reviewkwaliteit."
stories:
  - title: "Sealed child laadt geen repo-instructies en geen infrastructuurbronnen"
    description: |
      De reviewer in de container leest alleen wat de review nodig heeft: de prompt, de payload,
      de gepinde documenten en de checkout in /work. De repo-eigen CLAUDE.md/AGENTS.md en de
      git-bundle komen niet meer in zijn context.
    acceptance_criteria: |
      - De Claude-child start met CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 (contextbesparing) en --setting-sources user (hygiëne: geen hooks uit .claude/settings.json van de gereviewde repo in de sealed child; geen tokenclaim); de Codex-child met -c project_doc_max_bytes=0.
      - /sources bevat geen __repository_base meer; /work is nog steeds de checkout op base_sha (read-only).
      - Unit-tests in scrum4me-docker (__tests__/dispatch-child.test.ts, __tests__/dispatch-broker.test.ts) en de env-lijst in tests/dispatch-model-image.integration.ts zijn aangepast; npm test is groen.
      - De live-smoke tests/dispatch-live-review.smoke.ts eist een checks-entry per documentkey en niet meer voor __dispatch_input.
      - docs/dispatch-runtime-operator.md beschrijft de nieuwe child-vlaggen.
    priority: 2
    tasks:
      - title: "Claude-child: CLAUDE.md en projectsettings uit"
        description: "buildClaudeEnv en buildClaudeArgs in scrum4me-docker/lib/dispatch-child.ts."
        implementation_plan: |
          Repo: scrum4me-docker (master). Bestanden: lib/dispatch-child.ts, __tests__/dispatch-child.test.ts, tests/dispatch-model-image.integration.ts (regel 27), docs/dispatch-runtime-operator.md.
          1. Test eerst (rood): in __tests__/dispatch-child.test.ts, test 'builds the headless claude argv …' (±regel 100): voeg aan `base` na '--add-dir','/output' toe: '--setting-sources','user'. Test 'gives claude only home, path, …' (±regel 107): voeg aan het verwachte env-object toe CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1'. Test op ±regel 407 (spawn-env): voeg `expect(calls[0].env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1')` toe. Run: npm test -- dispatch-child → 3 tests rood.
          2. Implementatie: in buildClaudeArgs de vlag '--setting-sources','user' toevoegen ná '--add-dir','/output' (vóór model/effort). In buildClaudeEnv CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1' toevoegen naast CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. Commentaar: "CLAUDE_CODE_DISABLE_CLAUDE_MDS: /work is de repo-checkout; zijn CLAUDE.md/AGENTS.md zijn worker-instructies, geen reviewcontext (scrum4me-mcp: 48 KB ≈ 12k tokens per review). --setting-sources user: hooks uit .claude/settings.json van de gereviewde repo draaien niet in de sealed child; dit bespaart geen tokens."
          3. tests/dispatch-model-image.integration.ts regel 27: de verwachte env-lijst van de Claude-probe (`env:['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', …]`) krijgt 'CLAUDE_CODE_DISABLE_CLAUDE_MDS' erbij (alfabetisch, vóór CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC). Zonder deze regel faalt de probe van story 2 taak 2 op "exact child env".
          4. Run: npm test -- dispatch-child → groen. npm run typecheck (als aanwezig) → groen.
          5. docs/dispatch-runtime-operator.md: bij de beschrijving van de claude-child (sectie met buildClaudeArgs/"Headless claude") de twee vlaggen noemen en waarom. Bron van de vlaggen: Claude Code CLI-referentie (`--setting-sources`), env-vars (`CLAUDE_CODE_DISABLE_CLAUDE_MDS`).
          6. Commit: "feat(dispatch-child): claude-reviewer laadt geen CLAUDE.md en geen projectsettings".
          Verificatie: npm test groen; `git grep -n "DISABLE_CLAUDE_MDS" lib __tests__ tests` geeft 1 implementatie- en 3 testtreffers.
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
          Verificatie: npm test groen. Onbekend platformgedrag (accepteert Codex 0 als waarde?) blijkt pas in de nameting ná uitrol (story 4 stap 2); een weigering eindigt als DISPATCH_CHILD_RESULT_MISSING en wordt met het terugrolrecept van story 2 taak 2 opgevangen.
        priority: 2
        verify_required: ALIGNED_OR_PARTIAL
        verify_only: false
      - title: "Broker: __repository_base niet meer in /sources"
        description: "De git-bundle wordt in /work gematerialiseerd en hoort niet bij wat het model leest."
        implementation_plan: |
          Repo: scrum4me-docker. Bestanden: lib/dispatch-runtime-broker.ts (kopieerlus ±regel 207-215), __tests__/dispatch-broker.test.ts, __tests__/dispatch-child.test.ts (alleen lezen: listSourceArtifacts blijft ongewijzigd).
          1. Test eerst (rood): in __tests__/dispatch-broker.test.ts regel 352 staat nu `expect((await readFile(join(dir,'sources','__repository_base'))).length).toBeGreaterThan(0)`; keer die om naar `await expect(readFile(join(dir,'sources','__repository_base'))).rejects.toThrow(/ENOENT/)` en assert in dezelfde test dat `<attemptdir>/work` gematerialiseerd is op de pin en dat de overige documentkeys wél in /sources staan. Controleer de geparametriseerde case op regel 380 (`['a read checkout',{readCode:true},['__repository_base']]`): als die dezelfde verwachting codeert, pas hem op dezelfde manier aan. Run: npm test -- dispatch-broker → rood.
          2. Implementatie: in de `for(const key of input.sourceKeys)`-lus de validatie (realpath/device/inode/hash) ongewijzigd laten, maar het `cp` naar `/sources` overslaan wanneer `key===REPOSITORY_SOURCE_KEY` (import bestaat al op regel 11). Commentaar: "De bundle is de bron van /work (materializePreparedRepository hieronder); in /sources zou de prompt hem laten lezen — een Codex-reviewer las hem op 2026-10-09 'volledig'."
          3. Controleer dat de sourceKeys-validatie op ±regel 185 nog klopt (de key blijft toegestaan, alleen niet gekopieerd) en dat `materializePreparedRepository` uit `staged.pins` leest, niet uit /sources (regel 216-217).
          4. Run: npm test → groen.
          5. Commit: "fix(broker): repository-bundle niet in /sources van de child".
          Verificatie: npm test groen; in de nameting (story 4) bevat `checks` van beide reviewers geen `source:__repository_base` meer.
        priority: 2
        verify_required: ALIGNED_OR_PARTIAL
        verify_only: false
      - title: "Live-smoke-gate eist alleen documentkeys"
        description: "tests/dispatch-live-review.smoke.ts eist nu een passed-check voor __dispatch_input; na de promptwijziging van story 2 zou die gate altijd falen."
        implementation_plan: |
          Repo: scrum4me-docker. Bestand: tests/dispatch-live-review.smoke.ts (regel 216).
          1. Regel 216: `documentPins:['__dispatch_input','spec'].every(k=>result?.checks.some(c=>c.name===`source:${k}`&&c.status==='passed')===true)` wordt `documentPins:['spec'].every(…)` plus een tweede gate `noInfraChecks: result?.checks.every(c=>!c.name.startsWith('source:__'))===true` die in de uitkomst (regel ±187) wordt gelogd.
          2. De smoke draait niet in npm test (live, betaald); controleer met `npx tsc --noEmit` (of het bestaande typecheck-script) dat het bestand compileert.
          3. Commit: "test(smoke): review-gate op documentkeys, niet op __dispatch_input".
          Verificatie: `grep -n "__dispatch_input" tests/dispatch-live-review.smoke.ts` toont de key alleen nog in de fixture-opbouw (regels 137-139), niet in een gate.
        priority: 2
        verify_required: ANY
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
      - De promptwijziging staat op scrum4me-mcp main vóór de image-build (de mcp-prompts-stage kloont main); de dispatch-image is herbouwd (MCP_CACHE_BUST) en uitgerold op scrum4me-server — operatorstap, alleen na akkoord van JP, met terugrolrecept.
      - De sealed child leest de prompt uit de image (lib/dispatch-child.ts regel 302), niet uit prompt_text van de MCP; de MCP-service hoeft hiervoor niet opnieuw uitgerold te worden.
    priority: 2
    tasks:
      - title: "Prompts: payload is de enige input, __-keys niet lezen"
        description: "src/prompts/queue/review.md en review.codex.md plus test."
        implementation_plan: |
          Repo: scrum4me-mcp (main). Bestanden: src/prompts/queue/review.md, src/prompts/queue/review.codex.md, __tests__/kind-prompts.test.ts.
          1. Test eerst (rood): nieuwe `it('QUEUE_REVIEW-prompts: payload is de enige input, __-keys worden niet geopend', …)` die voor runtime CLAUDE en CODEX `getKindPromptText('QUEUE_REVIEW', rt)` leest en asserteert: bevat 'Keys that start with `__`' (of de gekozen vaste zin), bevat NIET 'that file wins' en NIET 'if the two ever differ', bevat nog '$PAYLOAD_PATH' en 'review.verdict'. De bestaande `it.each` op regel 148-157 loopt over {CLAUDE, CODEX} × {QUEUE_TASK, QUEUE_REVIEW}; de taakprompts (queue/task.md, task.codex.md) wijzigen niet en noemen de key alleen als `/sources/__dispatch_input`. Splits daarom: de assert `toContain('/sources/__dispatch_input')` blijft voor QUEUE_TASK en wordt voor QUEUE_REVIEW `toContain('`__dispatch_input`')` (bijv. `kind === 'QUEUE_TASK' ? … : …` in de bestaande test, of QUEUE_REVIEW uit `variants` halen en alleen in de nieuwe `it` dekken). Run: npm test -- kind-prompts → rood (alleen de QUEUE_REVIEW-gevallen).
          2. review.md (CLAUDE): sectie "Input": de zin over `/sources/__dispatch_input` ("It is the same JSON as the signed task file …; if the two ever differ, that file wins") vervangen door: "Keys that start with `__` (`__dispatch_input`, `__repository_base`) are infrastructure: the signed task and the repository bundle. Do not open them; they get no `checks` entry. The file at $PAYLOAD_PATH is your only copy of the task; its integrity is enforced by the broker's hash check, not by you." (Reden voor het omkeren van de M41-regel "de ondertekende kopie wint", src/dispatch/sources.ts regel 81-83: de integriteit zit in de broker-hash op /sources/__dispatch_input; de modelinstructie om beide te vergelijken voegde geen controle toe en kostte een tweede lezing van de body.) De zin "Keys that start with `__`" staat letterlijk in beide runtimes. Sectie "Work" stap 1: "List every source key you were given" → "List every document key (keys without the `__` prefix) with its sha256 and confirm you read it." Sectie "Output manifest", regel over checks: "one entry per source key" → "one entry per document key". Zelfde wijziging, in de bestaande toon, in review.codex.md (regels 7, 9, 24 en 48 daar).
          3. Run: npm test -- kind-prompts → groen. npm run typecheck:tests → groen.
          4. Commit: "fix(prompts): queue-reviewers lezen de payload één keer en openen geen __-bronnen".
          Verificatie: `grep -n "that file wins\|every source key\|per source key" src/prompts/queue/review*.md` geeft 0 treffers; `grep -c "Keys that start with \`__\`" src/prompts/queue/review.md src/prompts/queue/review.codex.md` geeft 1 per bestand.
        priority: 2
        verify_required: ALIGNED_OR_PARTIAL
        verify_only: false
      - title: "Dispatch-image herbouwen en uitrollen (JP-gate)"
        description: "Operatorstap op scrum4me-server; alleen na akkoord van JP. Volgorde: bouwen → probe → JP-gate → uitrol → nameting. Er bestaat geen lokale run van een echte QUEUE_REVIEW: dispatch_review-jobs worden alleen door de server-slots geclaimd."
        implementation_plan: |
          Repo: scrum4me-docker. Niets wijzigt in code; dit is de uitrol van story 1 en story 2.
          0. Voorwaarde: story 1 (alle taken) is op scrum4me-docker master en story 2 taak 1 is op scrum4me-mcp main gemerged; de mcp-prompts-stage kloont main (Dockerfile.dispatch regel 21-28).
          1. Bouw volgens het bestaande herbouwrecept in docs/dispatch-runtime-operator.md voor Dockerfile.dispatch met `--build-arg MCP_CACHE_BUST=<epoch>`, voor de stages model-codex én model-claude. Noteer de nieuwe digests én de huidige (oude) digests per slot.
          2. Draai `npm run test:dispatch-model-image` (T-1869) tegen de nieuwe images, vóór het omzetten van de slots: de probe controleert het exacte child-env (waaronder nu CLAUDE_CODE_DISABLE_CLAUDE_MDS, story 1 taak 1 stap 3), argv, mounts en egress. Verwacht groen voor beide probes. Dit is het enige bewijs vóór productie; het gedrag van de echte CLI's (accepteert Codex `project_doc_max_bytes=0`?) blijkt pas in de nameting.
          3. JP-gate (hardstop): leg de probe-uitkomst en de digests voor. Zonder akkoord stopt deze taak hier.
          4. Rol uit volgens hetzelfde document (supervisor/broker herstart per slot); controleer in de slot-log dat `DISPATCH_CHILD_RUNTIME`, model en effort ongewijzigd zijn.
          5. Terugrolrecept (vastleggen in docs/dispatch-runtime-operator.md bij de uitrolhistorie): per slot de oude image-digest terugzetten in de slotconfig en supervisor/broker herstarten; trigger = een nameting die eindigt met DISPATCH_CHILD_RESULT_MISSING of zonder verdict.
          6. Registreer de uitrol met datum, oude en nieuwe image-digests en MCP-commit in docs/dispatch-runtime-operator.md onder de bestaande uitrolhistorie.
          Verificatie: de nameting (story 4 stap 2) eindigt per runtime DONE/succeeded met een verdict en `checks` zonder `__`-keys en één entry per documentkey.
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
      - Review record: staat in docs/reviews/<datum>-<slug>-review-record.md naast het document, wordt niet gepind; de body vat de vorige ronde samen zoals nu. (Gemeten: in het ISS-2-plan rev 5 is het Review record 87 van 209 regels, elke ronde opnieuw door beide reviewers gelezen.)
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
      De maat is de unieke context: `cache_write_tokens + input_tokens` (Claude) en `input_tokens` (Codex, niet-gecachet:
      de supervisor trekt cached_input_tokens af, scrum4me-docker lib/dispatch-usage.ts regel 33-34) in claude_jobs, plus de verdict-geldigheid.
      De body is de ronde-4-body van de ISS-2-loop; die pinde al alleen het plan, dus de meting dekt story 1 en 2, niet het pin-beleid van story 3.
    acceptance_criteria: |
      - Nulmeting en nameting op hetzelfde document (ISS-2-plan rev 5, commit b3caa8cb47e46b9e214e719e8db810210dad1493, sha256 a587bf14be7fbcca51b2cd5cdb2e86c33ef7b559485ed4fbb4c73e85a85a8c7f) met byte-gelijke body en verification uit docs/reviews/2026-10-12-review-context-meting-body.md.
      - Absoluut: Claude nameting cache_write_tokens + input_tokens ≤ 80.000. Codex nameting input_tokens < nulmeting. De verhoudingen nameting/nulmeting worden per runtime gerapporteerd als diagnose, niet als grens.
      - Beide nametingen eindigen outcome succeeded met een verdict GO of NO-GO; `checks` bevat geen `__`-keys en één entry per documentkey (een not_run-entry voor tests, zoals de prompt op regel 18 vraagt, is toegestaan).
      - Eén paar metingen is indicatief (n=1 per runtime); een tweede paar bij een randgeval (binnen 5% van 80k) alleen op het woord van JP. Ontbrekende of null usage-kolommen zijn onbeslist, nooit een pass.
      - Cijfers en job-ids staan in docs/reviews/2026-10-12-review-context-meting.md in scrum4me-mcp.
    priority: 2
    tasks:
      - title: "Nulmeting en nameting uitvoeren en vastleggen"
        description: "Kost ≈ 2 × $2,85 lijstprijs; alleen met akkoord van JP."
        implementation_plan: |
          Repo: scrum4me-mcp. Bestanden: docs/reviews/2026-10-12-review-context-meting-body.md (bevroren body + verification, vóór de nulmeting gecommit), docs/reviews/2026-10-12-review-context-meting.md (meetdocument, nieuw).
          1. Nulmeting: vóór uitrol van story 1/2 één `dispatch_review` per runtime (CODEX, CLAUDE) op docs/superpowers/plans/2026-10-09-iss-2-cancel-unstarted.md @ b3caa8cb47e46b9e214e719e8db810210dad1493 (sha256 a587bf14be7fbcca51b2cd5cdb2e86c33ef7b559485ed4fbb4c73e85a85a8c7f), `repository.base_sha` = diezelfde sha, één pin (key `plan`). Body en verification: de letterlijke objective/verification van ISS-2 ronde 4 (request d3e0aabf-bb59-4e61-94d5-cc2eba0de081, key fd2585c8-90c4-4e42-97e1-5765e1cab455, teruggehaald uit het orchestrator-transcript), alleen aangepast van rev 4/bced318 naar rev 5/b3caa8c, bevroren in docs/reviews/2026-10-12-review-context-meting-body.md. Die ronde pinde al alleen het plan. reply_to mac:claude, nieuwe idempotency_keys. Noteer request-, root- en job-ids.
          2. Na uitrol van story 1 en 2 (story 2 taak 2 stap 4): exact dezelfde aanroepen met dezelfde bytes uit het bevroren bestand, nieuwe keys.
          3. Lees per job via de scrum4me-DB (lezen is door JP toegestaan op 2026-10-12): `select id, runtime, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, extract(epoch from (finished_at-started_at))/60 from claude_jobs where id in (...)`. Lees de vier `reviewed`-replies met queue_wait_reply op de root_message_ids en controleer `meta.result.checks`.
          4. Schrijf het meetdocument: tabel vóór/na per runtime (unieke context, cache-reads, output, minuten, kosten op lijstprijs: Claude 4/0,4/5/20 USD per Mtok in/cache-read/cache-write/out; Codex 2/0,1/—/10), de vier job-ids, de verdicts, de pass/fail per acceptatiecriterium (absoluut ≤ 80k Claude; Codex lager dan nulmeting; checks-vorm) en de verhoudingen als diagnose.
          5. Haalt een grens niet: meld het aan JP met de gemeten delta en het vaste CLI-aandeel (zie Uitgangssituatie) in plaats van de grens te verschuiven; een extra meting alleen op het woord van JP.
          Verificatie: het meetdocument bestaat, bevat vier job-ids en beide verdicts, en de SQL-uitkomst is er letterlijk in geplakt.
        priority: 2
        verify_required: ANY
        verify_only: false
---

# Vaste reviewcontext verkleinen — implementatieplan

> **Voor agentische workers:** gebruik superpowers:subagent-driven-development of superpowers:executing-plans om dit plan taak voor taak uit te voeren. Alleen increment 1 is uitgewerkt; increment 2 staat als richting onderaan.

**Doel:** de vaste, niet-reviewgebonden context die elke sealed `QUEUE_REVIEW`-reviewer per ronde inlaadt terugbrengen tot ≤ 80k tokens unieke context per Claude-review (historisch gemiddelde 132k), gemeten op dezelfde review, zonder het DispatchResult-contract of de read-only-grens te raken.

**Architectuur:** drie kleine ingrepen op de plek waar de dubbeling ontstaat: (1) de child-CLI laadt geen repo-instructies (`CLAUDE.md`/`AGENTS.md`/projecthooks); (2) de broker legt de git-bundle niet in `/sources` en de prompt laat `__`-bronnen dicht; (3) de orchestrator-skill pint alleen het document onder review. Een praktijkproef op één document meet het effect van (1) en (2) ná de uitrol op scrum4me-server; vóór de uitrol is er alleen de probe van `test:dispatch-model-image`, en er is een terugrolrecept.

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

Bronnen van de vaste instroom per Claude-review (bytes, M50-1b-ronde): rondebody 12–19 KB (twee keer: `payload.json` en `/sources/__dispatch_input`), pins ≈ 330 KB die allemaal ook in `/work` staan, `__repository_base` (git-bundle, de prompt eist "confirm you read it"), `/work/CLAUDE.md` auto-geladen (17 KB Scrum4Me, 48 KB scrum4me-mcp, 33 KB Scrum4Us), kind-prompt 4 KB, plus een vast CLI-aandeel (systeemprompt en tool-schema's van Claude Code, ≈ 20k tokens, niet door dit plan te beïnvloeden). Elke 50k tokens minder vaste context scheelt per Claude-review ≈ $0,25 cache-write plus ≈ $0,40 cache-reads.

## Globale randvoorwaarden

- De child blijft read-only buiten `/output`; geen nieuwe netwerkpaden; `--allowedTools`, `--disallowedTools` en de credential-mount (`/run/provider`) wijzigen niet.
- Het `DispatchResult`-contract (`vendor/scrum4me-shared/lib/queue-dispatch-validation.ts`, regel 120: `checks: z.array(z.object({ name, status: passed|failed|not_run, evidence? }))`) wijzigt niet; `review.documents` blijft byte-gelijk aan de pins; `checks` blijft een vrije lijst (de validator eist geen entry per source).
- `dispatch.source_artifacts` in de payload blijft `__repository_base` en `__dispatch_input` noemen (`src/dispatch/job-context.ts` regel 84-105); dat is consistent omdat de prompt die keys als infrastructuur benoemt en prompt- en brokerwijziging in dezelfde image landen.
- Beide runtime-prompts blijven inhoudelijk gelijk; een regel die in `review.md` verandert, verandert ook in `review.codex.md`.
- Tests: `npm test` groen in scrum4me-docker en scrum4me-mcp; `npm run typecheck:tests` in scrum4me-mcp. `npm run test:dispatch` (servicekant) is niet nodig: `src/dispatch/*` van de MCP wijzigt niet.
- Uitrol op scrum4me-server en het uitgeven van ≈ $6 aan proefreviews zijn JP-gates.

## Review focus

1. `--setting-sources user` mag de tool-allowlist en permission-mode uit argv niet raken; de spawn-test (`calls[0]`) en de env-lijst van `tests/dispatch-model-image.integration.ts` pinnen argv en env, de nameting bewijst dat de reviewer nog `Read`/`Bash` in `/work` kan.
2. `CLAUDE_CODE_DISABLE_CLAUDE_MDS` is gedocumenteerd maar niet gemeten op CLI 2.1.287: de nameting op scrum4me-mcp (48 KB `CLAUDE.md`) moet een zichtbare daling in `cache_write_tokens` geven; blijft die uit, dan is `--safe-mode` het alternatief (schakelt ook hooks en skills uit).
3. Codex kan `project_doc_max_bytes=0` weigeren als configuratiewaarde; dan eindigt de child met `DISPATCH_CHILD_RESULT_MISSING`. De nameting vangt dit ná uitrol; dan geldt het terugrolrecept (story 2 taak 2 stap 5) en is een leeg `AGENTS.md` in de child-home (niet in `/work`) het alternatief.
4. De broker valideert `sourceKeys` tegen `config.sources` en `staged.pins` (regel 185); het overslaan van het `cp` voor `__repository_base` mag die validatie niet veranderen en `materializePreparedRepository` leest uit `staged.pins`, niet uit `/sources`.
5. De live-smoke `tests/dispatch-live-review.smoke.ts` (scrum4me-docker) eist op regel 216 een passed-check voor `__dispatch_input`; story 1 taak 4 haalt die gate weg vóór de promptwijziging landt. De probe `dispatch-model-image` kent geen checks-gate, wel de exacte env-lijst (story 1 taak 1 stap 3).

## Taakvolgorde en afhankelijkheden

1. Story 4 taak 1 stap 1 (nulmeting) kan direct, nog vóór enige codewijziging, met de bevroren body (die pinde al alleen het plan).
2. Story 1 (vier taken) en story 2 taak 1 zijn onafhankelijk en kunnen parallel; twee repo's, geen gedeelde bestanden.
3. Story 3 is doc-only en kan parallel.
4. Story 2 taak 2: bouwen en probe (stap 1-2) na merge van story 1 en story 2 taak 1; uitrol (stap 4) pas na JP-akkoord; daarna story 4 stap 2–5 (nameting). Bij DISPATCH_CHILD_RESULT_MISSING of een nameting zonder verdict: terugrollen (stap 5).

## Increment 2 (richting, niet uitgewerkt)

- Rondebody: "Fragments from other repositories" en JP's doel/beslissingen als klein gepind `.md` in de repo in plaats van elke ronde in de body; `summary` in de kind-prompt begrenzen tot ≤ 1.000 tekens (nu ≤ 4.000, grotendeels een herhaling van het rapport).
- `get_job_status` geeft de usage-kolommen terug, zodat de loop per ronde de kosten in het Review record zet zonder DB-toegang.
- Nameting over een volledige loop (≥ 4 ronden) in plaats van één review, en een vaste plek voor deze cijfers in `docs/dispatch-runtime-operator.md`.

## Review record

### Ronde 1 (rev 1, commit `d27a17a`, pin sha256 `c76d40e6…fc733`)
**Reviewers (dispatch-jobs, alleen het plan gepind, `repository.base_sha` = d27a17a):**
- **CODEX:** request `5f17db6b-88c5-45ed-94d0-657ff17ab11f`, root `0d063cbc-5dde-47aa-9fe3-6b66e939fcd0`, job `10357f67-9695-4eaa-b2e5-92e71830b4d7`, key `5069f4e7-8875-4a75-a289-232972248568`. Verdict **NO-GO**: 3 MAJOR, 2 MINOR.
- **CLAUDE:** request `5f8f9653-0ebc-4a0a-a4d1-28674dbdb745`, root `312b7b57-6652-46a5-b33b-5fd93703f72a`, job `c2cfaf50-6174-4a35-af6b-044adaddc571`, key `fdccbd05-1640-4830-8a11-15666be438f1`. Verdict **NO-GO**: 3 MAJOR, 6 MINOR.

**Convergente MAJORs (alle drie geverifieerd en overgenomen in rev 2):**
- **kind-prompts-test** (beide): de `it.each` op regel 148-157 dekt ook QUEUE_TASK; de voorgeschreven assert-wijziging maakte twee QUEUE_TASK-gevallen rood. Rev 2: assert gesplitst per kind.
- **Volgorde proef/uitrol** (beide): het plan beloofde bewijs vóór uitrol via een "lokale run" die niet bestaat (dispatch_review-jobs worden alleen door server-slots geclaimd). Rev 2: bouwen → `test:dispatch-model-image`-probe → JP-gate → uitrol → nameting, met terugrolrecept (oude digests) en zonder "vóór uitrol"-claims.
- **Acceptatie** (CODEX: geen absolute 80k-grens; CLAUDE: de relatieve 60%/70% was afgeleid van het multi-pin-gemiddelde terwijl de nulmeting al één pin heeft → waarschijnlijke valse FAIL). Rev 2: absoluut Claude `cache_write + input` ≤ 80k, Codex lager dan nulmeting, verhoudingen alleen als diagnose; vast CLI-aandeel (≈ 20k) benoemd; n=1 indicatief, tweede paar alleen op JP's woord.

**MINORs overgenomen:** benchmark-body niet reconstrueerbaar uit het record (CODEX) → de letterlijke request d3e0aabf is uit het orchestrator-transcript gehaald en bevroren in `docs/reviews/2026-10-12-review-context-meting-body.md`, volledige sha's genoemd; broker-asserts regel 352/380 benoemd (CLAUDE); "checks uitsluitend documentkeys" vervangen door "geen `__`-keys, één per documentkey, not_run toegestaan" (CLAUDE); grep mist "per source key" en letterlijke zin in beide runtimes (CLAUDE); rationale voor omkeren van de M41-regel plus `$PAYLOAD_PATH`-bewoording (CLAUDE); `--setting-sources user` bespaart geen tokens → behouden als hygiëne (hooks uit de gereviewde repo draaien niet in de child), tokenclaim geschrapt (CLAUDE); validatorpad en `source_artifacts`-consistentie toegevoegd aan de randvoorwaarden; child leest de prompt uit de image (`dispatch-child.ts:302`), geen MCP-deploy nodig (CLAUDE, onverifieerbaar-lijst).

**Eigen vondst bij verificatie van review focus 5:** `tests/dispatch-live-review.smoke.ts:216` eist een passed-check voor `__dispatch_input` en `tests/dispatch-model-image.integration.ts:27` pint de exacte env-lijst van de Claude-child. Rev 2: nieuwe taak (story 1 taak 4) voor de smoke-gate; env-lijst in story 1 taak 1 stap 3.

**Niet overgenomen:** CODEX' voorstel om de verplaatsing van het Review record (story 3) uit te stellen. Bewijs: in het ISS-2-plan rev 5 is het record 87 van 209 regels (`b3caa8c`, regel 123-209) en wordt het elke ronde door beide reviewers gelezen; de taak is doc-only en klein. CLAUDE's uitstelkandidaat story 1 taak 3 (broker-skip als verdediging in de diepte) blijft: de Codex-reviewer las de bundle op 2026-10-09 "volledig", een promptregel alleen is geen grens.

**Scope-delta:** één taak erbij (smoke-gate, scrum4me-docker, klein) en een terugrolrecept in de uitroltaak; het eerste bruikbare resultaat (nameting ≤ 80k) en de praktijkproef zijn ongewijzigd, de proef is nu eerlijk gepositioneerd ná de uitrol.
