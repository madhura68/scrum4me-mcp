---
pbi:
  title: "Vaste context van QUEUE_REVIEW-jobs verkleinen"
  description: |
    Elke sealed reviewer (Claude en Codex) verbruikt per ronde gemiddeld ~130k tokens unieke input
    (usage-kolommen over de hele job: cache-write bij Claude, niet-gecachete input bij Codex). Een groot deel daarvan is dubbel: de repo-CLAUDE.md/AGENTS.md
    die de CLI zelf inlaadt, de git-bundle en de ondertekende input in /sources die de prompt laat
    "lezen en bevestigen", en gepinde contextdocumenten die al in /work staan. Dit increment haalt
    die dubbelingen weg en meet het effect op dezelfde review.
  priority: 2
sprint:
  goal: "De vaste, niet-reviewgebonden context van sealed reviewers weg: gemeten als ≥ 10k tokens minder context in de eerste modelbeurt van de Claude-reviewer op het ISS-2-plan (nulmeting 37.882 vóór de eerste tool-aanroep), zonder verlies van reviewkwaliteit; de pin-beperking (story 3) richt zich op de multi-pin-rondes achter het historisch gemiddelde van 132k."
stories:
  - title: "Sealed child laadt geen repo-instructies en geen infrastructuurbronnen"
    description: |
      De reviewer in de container leest alleen wat de review nodig heeft: de prompt, de payload,
      de gepinde documenten en de checkout in /work. De repo-eigen CLAUDE.md/AGENTS.md en de
      git-bundle komen niet meer in zijn context.
    acceptance_criteria: |
      - Alleen voor action `review`: de Claude-child start met CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 (contextbesparing) en --setting-sources user (hygiëne: geen hooks uit .claude/settings.json van de gereviewde repo in de sealed child; geen tokenclaim); de Codex-child met -c project_doc_max_bytes=0. QUEUE_TASK-children (free_task, task_implementation) behouden argv en env ongewijzigd; een test per action pint dat.
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
          De child bedient QUEUE_TASK én QUEUE_REVIEW (choosePromptFile(built.input.action, runtime), regel 302); de builders buildClaudeArgs/buildClaudeEnv hebben nu geen action-parameter. Voor een task-child (free_task, task_implementation; schrijft code in /work) zijn CLAUDE.md/AGENTS.md wél de werkinstructies. Daarom gelden de vlaggen alleen voor action `review`.
          1. Test eerst (rood): in __tests__/dispatch-child.test.ts, test 'builds the headless claude argv …' (±regel 100): `buildClaudeArgs({prompt:'P',review:true})` geeft `base` plus '--setting-sources','user' direct ná '--add-dir','/output' (vóór model/effort); `buildClaudeArgs({prompt:'P'})` geeft `base` ongewijzigd. Test 'gives claude only home, path, …' (±regel 107): `buildClaudeEnv(env,TOKEN,{review:true})` bevat CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1'; `buildClaudeEnv(env,TOKEN)` bevat die sleutel niet. Spawn-test op ±regel 407 (layoutClaude met reviewInput): `expect(calls[0].env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1')` en `expect(calls[0].args).toContain('--setting-sources')`; in de bestaande test 'uses the claude task prompt for a non-review action' (±regel 423, taskInput): `expect(calls[0].env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBeUndefined()` en `expect(calls[0].args).not.toContain('--setting-sources')`. Run: npm test -- dispatch-child → rood.
          2. Implementatie: buildClaudeArgs(x:{prompt;model?;effort?;review?:boolean}) voegt alleen bij x.review '--setting-sources','user' toe ná '--add-dir','/output'. buildClaudeEnv(env,token,opts?:{review?:boolean}) voegt alleen bij opts.review CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1' toe naast CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. In ADAPTERS (regel 255-264) krijgen `args` en `env` een extra parameter `review:boolean`; `CLAUDE.env` is nu de kale referentie `buildClaudeEnv` en wordt een wrapper `(env,token,review)=>buildClaudeEnv(env,token,{review})` (CODEX.env blijft buildCodexEnv met een genegeerde derde parameter, of krijgt dezelfde wrapper-vorm); runDispatchChild geeft `built.input.action==='review'` door op de twee aanroepen (`adapter.args(prompt,deps.env,chatgpt)` ±regel 304 en `adapter.env(deps.env,key)` ±regel 309). Commentaar: "CLAUDE_CODE_DISABLE_CLAUDE_MDS (alleen review): /work is de repo-checkout; zijn CLAUDE.md/AGENTS.md zijn worker-instructies, geen reviewcontext (scrum4me-mcp: 48 KB ≈ 12k tokens per review). --setting-sources user (alleen review): hooks uit .claude/settings.json van de gereviewde repo draaien niet in de sealed child; dit bespaart geen tokens. Task-children houden beide, dat zijn hun werkinstructies."
          3. tests/dispatch-model-image.integration.ts regel 27: de probe-input heeft action 'review' (regel 86), dus de verwachte env-lijst van de Claude-probe (`env:['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', …]`) krijgt 'CLAUDE_CODE_DISABLE_CLAUDE_MDS' erbij (alfabetisch, vóór CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC). De argv-controle van de probe (hasPair op model/effort, regel 40 en 123) is geen letterlijke argv en hoeft niet te wijzigen.
          4. Run: npm test -- dispatch-child → groen. npm run typecheck (als aanwezig) → groen.
          5. docs/dispatch-runtime-operator.md: bij de beschrijving van de claude-child (sectie met buildClaudeArgs/"Headless claude") de twee vlaggen noemen en waarom. Bron van de vlaggen: Claude Code CLI-referentie (`--setting-sources`), env-vars (`CLAUDE_CODE_DISABLE_CLAUDE_MDS`).
          6. Commit: "feat(dispatch-child): claude-reviewer laadt geen CLAUDE.md en geen projectsettings".
          Verificatie: npm test groen; `git grep -n "DISABLE_CLAUDE_MDS" lib __tests__ tests` geeft ≥ 1 treffer in lib/dispatch-child.ts, ≥ 3 in __tests__/dispatch-child.test.ts (schrijf de negatieve gevallen als `expect(env).not.toHaveProperty('CLAUDE_CODE_DISABLE_CLAUDE_MDS')`, dan 4) en 1 in tests/dispatch-model-image.integration.ts.
        priority: 2
        verify_required: ALIGNED_OR_PARTIAL
        verify_only: false
      - title: "Codex-child: AGENTS.md uit"
        description: "buildCodexArgs in scrum4me-docker/lib/dispatch-child.ts."
        implementation_plan: |
          Repo: scrum4me-docker. Bestanden: lib/dispatch-child.ts, __tests__/dispatch-child.test.ts, docs/dispatch-runtime-operator.md (±regel 55, de codex exec-regel).
          1. Test eerst (rood): test 'builds the worker-shaped codex exec argv …' (±regel 122): `buildCodexArgs({prompt:'P',review:true})` krijgt na '--cd','/work' de twee elementen '-c','project_doc_max_bytes=0'; `buildCodexArgs({prompt:'P'})` blijft ongewijzigd. Controleer ook de variant met model/effort/chatgpt in dezelfde describe. Spawn-tests: met reviewInput bevat `calls[0].args` 'project_doc_max_bytes=0', in 'uses the task prompt for a non-review action' (±regel 233, taskInput) niet. Run: npm test -- dispatch-child → rood.
          2. Implementatie: buildCodexArgs(x:{…;review?:boolean}) voegt alleen bij x.review direct na '--cd','/work' toe: '-c','project_doc_max_bytes=0'; de ADAPTERS-koppeling van `review` komt uit story 1 taak 1 stap 2 (zelfde parameter). Commentaar: "Codex concateneert elke AGENTS.md van projectroot tot cwd (codex-rs core agents_md.rs); 0 bytes = geen repo-instructies in de reviewcontext (alleen review; task-children houden hun AGENTS.md). scrum4me-mcp: AGENTS.md → CLAUDE.md, 48 KB, waarvan Codex met de standaardcap maximaal 32 KiB (≈ 8k tokens) laadde."
          3. Run: npm test -- dispatch-child → groen.
          4. docs/dispatch-runtime-operator.md regel 55: de letterlijke codex exec-regel bijwerken met de nieuwe -c-optie.
          5. Commit: "feat(dispatch-child): codex-reviewer laadt geen AGENTS.md".
          Verificatie: npm test groen. Onbekend platformgedrag (accepteert Codex 0 als waarde?) wordt vóór uitrol gevangen door de lokale Codex-live-smoke tegen de nieuwe image (story 2 taak 2 stap 2b); een weigering daar eindigt als DISPATCH_CHILD_RESULT_MISSING.
        priority: 2
        verify_required: ALIGNED_OR_PARTIAL
        verify_only: false
      - title: "Broker: __repository_base niet meer in /sources"
        description: "De git-bundle wordt in /work gematerialiseerd en hoort niet bij wat het model leest."
        implementation_plan: |
          Repo: scrum4me-docker. Bestanden: lib/dispatch-runtime-broker.ts (kopieerlus ±regel 207-215), __tests__/dispatch-broker.test.ts, __tests__/dispatch-child.test.ts (alleen lezen: listSourceArtifacts blijft ongewijzigd).
          1. Test eerst (rood): in __tests__/dispatch-broker.test.ts regel 352 staat nu `expect((await readFile(join(dir,'sources','__repository_base'))).length).toBeGreaterThan(0)`; keer die om naar `await expect(readFile(join(dir,'sources','__repository_base'))).rejects.toThrow(/ENOENT/)` en assert in dezelfde test dat `<attemptdir>/work` gematerialiseerd is op de pin en dat de overige documentkeys wél in /sources staan. Controleer de geparametriseerde case op regel 380 (`['a read checkout',{readCode:true},['__repository_base']]`): als die dezelfde verwachting codeert, pas hem op dezelfde manier aan. Run: npm test -- dispatch-broker → rood.
          2. Implementatie: in de `for(const key of input.sourceKeys)`-lus de validatie (realpath/device/inode/hash) ongewijzigd laten, maar het `cp` naar `/sources` én de daaropvolgende `hashSource(target)`-controle overslaan wanneer `key===REPOSITORY_SOURCE_KEY` (import bestaat al op regel 11; `continue` vóór het `cp`, de pre-copy realpath/dev/ino/hash-check blijft). Commentaar: "De bundle is de bron van /work (materializePreparedRepository hieronder); in /sources zou de prompt hem laten lezen — een Codex-reviewer las hem op 2026-10-09 'volledig'."
          3. Controleer dat de sourceKeys-validatie op ±regel 185 nog klopt (de key blijft toegestaan, alleen niet gekopieerd), dat `materializePreparedRepository` uit `staged.pins` leest, niet uit /sources (regel 216-217), en dat niets in lib/dispatch-child.ts het manifest tegen /sources afloopt (`listSourceArtifacts` doet alleen `readdir(sources)`, regel 52-62; `buildChildPayload` leest alleen `__dispatch_input`, regel 64-71) — een ontbrekende `/sources/__repository_base` is dus geen weigering. De skip geldt voor read- én repo_write-pogingen (dezelfde kopieerlus); dat is bewust: de taakprompts (queue/task.md, task.codex.md regel 9) gebruiken de bundle niet, en na de child leest niets `<attempt>/sources/__repository_base` — `dispatch-source-staging.ts` regel 127 fetcht uit het staging-pad `staged.pins[REPOSITORY_SOURCE_KEY].path`, en `git grep -n "__repository_base\|REPOSITORY_SOURCE_KEY" lib` toont geen andere lezer. Noteer in het commentaar dat task-children de bundle ook niet meer in /sources zien.
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
          1. Regel 216: `documentPins:['__dispatch_input','spec'].every(k=>result?.checks.some(c=>c.name===`source:${k}`&&c.status==='passed')===true)` wordt `documentPins:['spec'].every(k=>result?.checks.filter(c=>c.name===`source:${k}`&&c.status==='passed').length===1)` (precies één passed-entry per documentkey) plus een tweede gate `noInfraChecks: result?.checks.every(c=>!c.name.startsWith('source:__'))===true`; beide worden in de uitkomst (regel ±187) gelogd. Dit is dezelfde regel als de acceptatie van story 4.
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
          Repo: scrum4me-mcp (main). Bestanden: src/prompts/queue/review.md, src/prompts/queue/review.codex.md, __tests__/kind-prompts.test.ts, src/dispatch/sources.ts (alleen de commentaarregel 80).
          1. Test eerst (rood): nieuwe `it('QUEUE_REVIEW-prompts: payload is de enige input, __-keys worden niet geopend', …)` die voor runtime CLAUDE en CODEX `getKindPromptText('QUEUE_REVIEW', rt)` leest en asserteert: bevat 'Keys that start with `__`' (of de gekozen vaste zin), bevat NIET 'that file wins' en NIET 'if the two ever differ', bevat nog '$PAYLOAD_PATH', '"verdict"' (de JSON-sleutel op regel 39) en '`review.documents`' (regel 46); 'review.verdict' staat niet in de prompts. De bestaande `it.each` op regel 148-157 loopt over {CLAUDE, CODEX} × {QUEUE_TASK, QUEUE_REVIEW}; de taakprompts (queue/task.md, task.codex.md) wijzigen niet en noemen de key alleen als `/sources/__dispatch_input`. Splits daarom: de assert `toContain('/sources/__dispatch_input')` blijft voor QUEUE_TASK en wordt voor QUEUE_REVIEW `toContain('`__dispatch_input`')` (bijv. `kind === 'QUEUE_TASK' ? … : …` in de bestaande test, of QUEUE_REVIEW uit `variants` halen en alleen in de nieuwe `it` dekken). Run: npm test -- kind-prompts → rood (alleen de QUEUE_REVIEW-gevallen).
          2. review.md (CLAUDE): sectie "Input": de zin over `/sources/__dispatch_input` ("It is the same JSON as the signed task file …; if the two ever differ, that file wins") vervangen door: "Keys that start with `__` (`__dispatch_input`, `__repository_base`) are infrastructure: the signed task and the repository bundle. Do not open them; they get no `checks` entry. The file at $PAYLOAD_PATH is your only copy of the task; it is written by the runner from the hash-verified signed task, so you do not need to compare them." (Reden voor het omkeren van de M41-regel "de ondertekende kopie wint": payload.json wordt door de child zelf geschreven uit /sources/__dispatch_input — buildChildPayload leest die key, scrum4me-docker lib/dispatch-child.ts regel 64-67, en writeFile(payloadPath, built.payload) regel ±299 — en de broker hasht dat bronbestand (src/dispatch/sources.ts regel 81-83 bindt de bytes aan input_hash). De modelinstructie om beide te vergelijken voegde geen controle toe en kostte een tweede lezing van de body. Pas het commentaar op sources.ts regel 80 ("the child's only copy of the task") aan: "the hash-bound source the child builds its payload from".) Regel 9 in beide bestanden ("Each one is a read-only file at `/sources/<key>`" / "as read-only files at `/sources/<key>`"): voeg toe "— except `__`-keys, which are infrastructure (see Input above) and may be absent from `/sources`." en schrap de slotzin van regel 9 ("`/sources/__dispatch_input` is the task itself, not a document under review" / "… is the task, not a document under review") in beide bestanden: de nieuwe `__`-zin dekt haar, en zonder die schrapping zou `/sources/__dispatch_input` in de reviewprompts blijven staan (de M41-test eist alleen dat `/sources/<key>` blijft staan). De zin "Keys that start with `__`" staat letterlijk in beide runtimes. Sectie "Work" stap 1: "List every source key you were given" → "List every document key (keys without the `__` prefix) with its sha256 and confirm you read it." Sectie "Output manifest", regel over checks: "one entry per source key" → "one entry per document key". Zelfde wijzigingen (regels 7, 9, 24 en 48), in de bestaande toon, in review.codex.md.
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
          0. Voorwaarden: (a) docs/reviews/2026-10-12-review-context-meting.md toont beide nulmeting-jobs DONE/succeeded met verdict en niet-null usage van de oude images — ontbreekt dat, dan stoppen: een nulmeting is na de uitrol alleen nog met teruggerolde slots te maken; (b) story 1 (alle taken) is op scrum4me-docker master en story 2 taak 1 is op scrum4me-mcp main gemerged; de mcp-prompts-stage kloont main (Dockerfile.dispatch regel 21-28).
          1. Bouw volgens het bestaande herbouwrecept in docs/dispatch-runtime-operator.md voor Dockerfile.dispatch met `--build-arg MCP_CACHE_BUST=<epoch>`, voor de stages model-codex én model-claude. Noteer de nieuwe digests én de huidige (oude) digests per slot, en per image de Claude-CLI-versie (`claude --version` in de image; nulmeting draaide op 2.1.287): een andere versie verandert het CLI-aandeel van de eerste beurt (story 4 stap 3).
          2. Draai `npm run test:dispatch-model-image` (T-1869) tegen de nieuwe images, vóór het omzetten van de slots: de probe (action review) controleert het exacte child-env (waaronder nu CLAUDE_CODE_DISABLE_CLAUDE_MDS, story 1 taak 1 stap 3), model/effort in argv, mounts en egress. Verwacht groen voor beide probes.
          2b. Draai `npm run smoke:dispatch-live-review` (tests/dispatch-live-review.smoke.ts; lokaal op de Mac, echte codex-CLI in de nieuwe model-codex-image, M41_CODEX_AUTH_FILE, ≈ $0,45) tegen de nieuwe image: dit is het enige bewijs vóór productie dat Codex `project_doc_max_bytes=0` accepteert; verwacht outcome succeeded met de gates van story 1 taak 4. Er bestaat geen Claude-variant van de smoke (runtime staat vast op CODEX, regel 136): CLAUDE_CODE_DISABLE_CLAUDE_MDS blijkt pas in de nameting, met het terugrolrecept als vangnet.
          3. JP-gate (hardstop): leg de probe- en smoke-uitkomst, de digests en de nulmeting-cijfers uit het meetdocument voor. Zonder akkoord stopt deze taak hier.
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
      - De wijziging is gedocumenteerd in de skill zelf met datum en de pin-omvang uit de analyse (niet met cijfers uit story 4, die het pin-beleid niet meet).
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
          5. Onder "Both slots are dispatch jobs" een regel met datum: "2026-10-xx: pins beperkt tot het document onder review (M50-1b: ≈ 330 KB aan pins die al in /work stonden); niet gemeten in de proef van story 4, die dekt alleen de child-vlaggen en de prompt; effect verwacht op multi-pin-rondes."
          Verificatie: `grep -n "adversarial-review-loop" SKILL.md references/round-body-template.md` geeft alleen nog de 'Deep reference'-regel in SKILL.md; `grep -c "at most 8"` = 0.
        priority: 2
        verify_required: ANY
        verify_only: false
  - title: "Praktijkproef: zelfde review vóór en na, gemeten in tokens"
    description: |
      Eén document, één rondebody, één Claude- en één Codex-review vóór en ná de wijzigingen.
      De nulmeting is op 2026-10-12 uitgevoerd op het woord van JP, vóór enige codewijziging, en staat met job-ids, verdicts en usage in docs/reviews/2026-10-12-review-context-meting.md (CODEX job cb9487bc-9c67-4773-9efd-a897aebfa786, GO, input 77.553; CLAUDE job 84f67fa4-216e-4d93-b93a-565de3de142c, GO, cache_write 112.537 + input 38). Zij is een afgeronde voorwaarde, geen sprinttaak: de enige taak hier is de nameting plus het aanvullen van het meetdocument, ná de uitrol. Voorwaarde voor uitrol én nameting: het meetdocument toont beide nulmeting-jobs DONE/succeeded met verdict en niet-null usage van de oude images; anders stoppen.
      De beslissende maat (Claude) is de context van de eerste modelbeurt: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` van het eerste `assistant`-event in de child-transcript, bewaard in de run-log op scrum4me-server (`<DISPATCH_WORKER_LOG_DIR>/dispatch/<slot>/runs/<ts>.log`, scrum4me-docker docs/dispatch-runtime-operator.md regel 140-141). Die som telt vóór enige tool-aanroep en is onafhankelijk van de 1-uurs prompt-cache-warmte van de CLI-prefix (warm: ≈ 13k in cache_read; koud: dezelfde ≈ 13k in cache_creation) en van de bronlezingen die de reviewer daarna doet. De `claude_jobs`-totalen (`cache_write_tokens + input_tokens` Claude; `input_tokens` Codex, niet-gecachet: de supervisor trekt cached_input_tokens af, lib/dispatch-usage.ts regel 33-34) zijn diagnose. Codex kent geen per-aanroep-usage (één `turn.completed` per run), dus Codex heeft geen beslissende tokenmaat; daar is de gedragscheck (checks zonder `__`-keys, verdict) beslissend.
      De body is de ronde-4-body van de ISS-2-loop; die pinde al alleen het plan, dus de meting dekt story 1 en 2, niet het pin-beleid van story 3.
    acceptance_criteria: |
      - Nulmeting en nameting op hetzelfde document (ISS-2-plan rev 5, commit b3caa8cb47e46b9e214e719e8db810210dad1493, sha256 a587bf14be7fbcca51b2cd5cdb2e86c33ef7b559485ed4fbb4c73e85a85a8c7f) met byte-gelijke body en verification uit docs/reviews/2026-10-12-review-context-meting-body.md.
      - Claude, beslissend: de eerste-beurt-context van de nameting is ten minste 10.000 lager dan die van de nulmeting (37.882 = 2 + 24.639 + 13.241, job 84f67fa4, run-log 20261012T201245Z.log op slot b41d91ae-…), dus ≤ 27.882. Verwachting (geen meting): ≈ 11,5k door CLAUDE.md (46.768 B op b3caa8c); de body zit niet in de eerste beurt (de kind-prompt laat het model `$PAYLOAD_PATH` met een tool lezen), dus het wegvallen van de tweede lezing (≈ 1k) is alleen in de totalen zichtbaar. Diagnose, niet beslissend: `claude_jobs`-totalen (nulmeting cache_write 112.537 + input 38) en de verhoudingen; een absolute grens van 80k op de totalen wordt door story 1 en 2 niet als verwacht resultaat gedragen.
      - Codex, beslissend: outcome succeeded, verdict GO/NO-GO, checks-vorm (hieronder). Diagnose: `input_tokens` (nulmeting 77.553) en `input_tokens + cache_read_tokens` lager dan de nulmeting; verwachting ≈ 8k minder in `input_tokens` (eenmalige prefix-write; Codex laadt maximaal 32 KiB van AGENTS.md), terwijl `input + cache_read` met ≈ 8k × het aantal modelaanroepen daalt en door variantie in aanroepen en bronlezingen wordt overschaduwd.
      - Beide nametingen eindigen outcome succeeded met een verdict GO of NO-GO; `checks` bevat precies één `source:<key>`-entry per documentkey, geen `source:__*`-entry; andere check-namen (not_run voor tests, `repository:pin`) zijn toegestaan — dezelfde regel als de smoke-gate van story 1 taak 4.
      - Eén paar metingen is indicatief (n=1 per runtime); een daling ≥ 10k is een pass; bij een uitkomst tussen 9k en 11k (de grens ± 2× de waargenomen spreiding van ±0,5k) mag JP één bevestigingspaar vragen, alleen op zijn woord. Een ontbrekende run-log of transcript, of null usage-kolommen, is onbeslist, nooit een pass.
      - Cijfers en job-ids staan in docs/reviews/2026-10-12-review-context-meting.md in scrum4me-mcp.
    priority: 2
    tasks:
      - title: "Nameting uitvoeren en meetdocument schrijven"
        description: "Kost ≈ $1,90 lijstprijs (één paar, gemeten aan de nulmeting); alleen ná de uitrol van story 2 taak 2. De nulmeting is gedaan en staat in docs/reviews/2026-10-12-review-context-meting.md."
        implementation_plan: |
          Repo: scrum4me-mcp. Bestanden: docs/reviews/2026-10-12-review-context-meting-body.md (bevroren body + verification, gecommit vóór de nulmeting), docs/reviews/2026-10-12-review-context-meting.md (meetdocument; bevat de nulmeting-helft met job-ids, verdicts en de SQL-uitkomst).
          0. Voorwaarde: het meetdocument toont beide nulmeting-jobs (cb9487bc-…, 84f67fa4-…) DONE/succeeded met verdict en niet-null usage — anders stoppen en JP melden. Story 2 taak 2 stap 4 (uitrol) is gedaan. Controleer dat b3caa8cb47e46b9e214e719e8db810210dad1493 nog bereikbaar is: raw-fetch van het plan op die commit (`git show b3caa8c…:docs/superpowers/plans/2026-10-09-iss-2-cancel-unstarted.md | shasum -a 256` na `git fetch origin b3caa8cb47e46b9e214e719e8db810210dad1493`) geeft a587bf14…; `ls-remote` ziet alleen ref-tips en is hier onbruikbaar.
          1. Nulmeting (afgerond 2026-10-12, vóór enige codewijziging; ids, verdicts en SQL-uitkomst in het meetdocument): één `dispatch_review` per runtime op docs/superpowers/plans/2026-10-09-iss-2-cancel-unstarted.md @ b3caa8cb47e46b9e214e719e8db810210dad1493 (sha256 a587bf14be7fbcca51b2cd5cdb2e86c33ef7b559485ed4fbb4c73e85a85a8c7f), `repository.base_sha` = diezelfde sha, één pin (key `plan`), body en verification = de bytes tussen de markeringen in het bevroren bestand (herkomst: ISS-2 ronde 4, request d3e0aabf-bb59-4e61-94d5-cc2eba0de081; die ronde pinde al alleen het plan; de body spreekt CODEX aan maar gaat identiek naar beide runtimes, want de maat is de vaste context, niet een natuurlijke ronde).
          2. Nameting: exact dezelfde twee aanroepen met dezelfde bytes uit het bevroren bestand, nieuwe idempotency_keys, reply_to mac:claude. Noteer request-, root- en job-ids.
          3. Beslissende Claude-maat: op scrum4me-server (ssh `scrum4me-srv`, read-only) de run-log van de nameting-job: `grep -l '<job_id>' /srv/scrum4me/worker-logs/dispatch/*/runs/*.log`, dan `grep -m1 '"type":"assistant"' <log> | grep -o '"usage":{[^}]*}'` → som van input_tokens + cache_creation_input_tokens + cache_read_input_tokens. Lees in dezelfde run-log ook de `system/init`-regel (`grep -m1 '"subtype":"init"'`): `claude_code_version` en de aantallen `tools`, `skills`, `plugins` (nulmeting: 2.1.287, 24/17/2); wijkt de nameting daarvan af, dan is de eerste-beurt-delta door de CLI-wijziging vervuild en wordt hij aan JP gemeld als "confounded", niet als pass/fail. Diagnose via de scrum4me-DB (lezen is door JP toegestaan op 2026-10-12): `select id, runtime, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, extract(epoch from (finished_at-started_at))/60 from claude_jobs where id in (...)`. Lees de twee nieuwe `reviewed`-replies met queue_wait_reply op de root_message_ids en controleer `meta.result.checks`.
          4. Vul het meetdocument aan: nameting-tabel per runtime (unieke context, cache-reads, output, minuten, kosten op lijstprijs: Claude 4/0,4/5/20 USD per Mtok in/cache-read/cache-write/out; Codex 2/0,1/—/10), de twee nieuwe job-ids, de verdicts, de pass/fail per acceptatiecriterium (Claude eerste-beurt ≥ 10k lager; beide: succeeded, verdict, checks-vorm) en de totalen en verhoudingen als diagnose (Codex: input en input+cache_read).
          5. Haalt een grens niet: meld het aan JP met de gemeten eerste-beurt-delta en het vaste CLI-aandeel (≈ 24k, zie Uitgangssituatie) in plaats van de grens te verschuiven; een extra meting alleen op het woord van JP. Blijft de eerste-beurt-context gelijk bij gelijke CLI-versie, dan heeft CLAUDE_CODE_DISABLE_CLAUDE_MDS op CLI 2.1.287 niet gewerkt (zie review focus 2).
          Verificatie: het meetdocument bestaat, bevat vier job-ids en beide verdicts, en de SQL-uitkomst is er letterlijk in geplakt.
        priority: 2
        verify_required: ANY
        verify_only: false
---

# Vaste reviewcontext verkleinen — implementatieplan

> **Voor agentische workers:** gebruik superpowers:subagent-driven-development of superpowers:executing-plans om dit plan taak voor taak uit te voeren. Alleen increment 1 is uitgewerkt; increment 2 staat als richting onderaan.

**Doel:** de vaste, niet-reviewgebonden context die elke sealed `QUEUE_REVIEW`-reviewer per ronde inlaadt wegnemen — gemeten als ≥ 10k tokens minder context in de eerste modelbeurt van de Claude-reviewer op dezelfde review (nulmeting 37.882 op het ISS-2-plan; de totalen over de hele job, 112.575, en het historisch gemiddelde van 132k met multi-pin-rondes zijn diagnose) — zonder het DispatchResult-contract of de read-only-grens te raken.

**Architectuur:** drie kleine ingrepen op de plek waar de dubbeling ontstaat: (1) de child-CLI laadt geen repo-instructies (`CLAUDE.md`/`AGENTS.md`/projecthooks); (2) de broker legt de git-bundle niet in `/sources` en de prompt laat `__`-bronnen dicht; (3) de orchestrator-skill pint alleen het document onder review. Een praktijkproef op één document meet het effect van (1) en (2) ná de uitrol op scrum4me-server; vóór de uitrol zijn er de probe van `test:dispatch-model-image` en de lokale Codex-live-smoke, en er is een terugrolrecept. De vlaggen van (1) gelden alleen voor action `review`; task-children houden hun repo-instructies.

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

Bronnen van de vaste instroom per Claude-review (bytes, M50-1b-ronde): rondebody 12–19 KB (twee keer: `payload.json` en `/sources/__dispatch_input`), pins ≈ 330 KB die allemaal ook in `/work` staan, `__repository_base` (git-bundle, de prompt eist "confirm you read it"), `/work/CLAUDE.md` auto-geladen (17 KB Scrum4Me, 48 KB scrum4me-mcp, 33 KB Scrum4Us), kind-prompt 4 KB, plus een vast CLI-aandeel (systeemprompt, tool-schema's en lijsten van skills/agents/uitgestelde tools van Claude Code; gemeten: de eerste modelbeurt van de nulmeting-child telde 37.882 tokens, waarvan ≈ 11,5k CLAUDE.md en ≈ 1k kind-prompt, dus ≈ 25k CLI-aandeel (CLI 2.1.287: 24 tools, 17 skills, 2 plugins); deels configureerbaar, buiten dit increment — zie increment 2). Elke 50k tokens minder vaste context scheelt per Claude-review ≈ $0,25 cache-write plus ≈ $0,40 cache-reads.

## Globale randvoorwaarden

- De child blijft read-only buiten `/output`; geen nieuwe netwerkpaden; `--allowedTools`, `--disallowedTools` en de credential-mount (`/run/provider`) wijzigen niet.
- Het `DispatchResult`-contract (`vendor/scrum4me-shared/lib/queue-dispatch-validation.ts`, regel 120: `checks: z.array(z.object({ name, status: passed|failed|not_run, evidence? }))`) wijzigt niet; `review.documents` blijft byte-gelijk aan de pins; `checks` blijft een vrije lijst (de validator eist geen entry per source).
- `dispatch.source_artifacts` in de child-payload komt uit een listing van `/sources` (scrum4me-docker `lib/dispatch-child.ts` `listSourceArtifacts`, regel 52-62: `readdir(sources)`, per bestand sha256; geen vergelijking met het manifest). Na de broker-skip verdwijnt `__repository_base` dus uit de child-payload, `__dispatch_input` blijft; beide uitkomsten zijn consistent met de nieuwe prompt ("`__`-keys … may be absent"). De MCP-kant (`src/dispatch/job-context.ts` regel 84-105, met artifact_id) is een ander object en wijzigt niet.
- Beide runtime-prompts blijven inhoudelijk gelijk; een regel die in `review.md` verandert, verandert ook in `review.codex.md`.
- Tests: `npm test` groen in scrum4me-docker en scrum4me-mcp; `npm run typecheck:tests` in scrum4me-mcp. `npm run test:dispatch` (servicekant) is niet nodig: in `src/dispatch/*` van de MCP wijzigt alleen een commentaarregel (`sources.ts:80`), geen gedrag.
- Uitrol op scrum4me-server en het uitgeven van ≈ $2,35 aan proefruns (nameting-paar ≈ $1,90 + Codex-smoke ≈ $0,45; de nulmeting is al gedaan) zijn JP-gates; een tweede paar alleen op het woord van JP.

## Review focus

1. `--setting-sources user` mag de tool-allowlist en permission-mode uit argv niet raken; de spawn-test (`calls[0]`) en de env-lijst van `tests/dispatch-model-image.integration.ts` pinnen argv en env, de nameting bewijst dat de reviewer nog `Read`/`Bash` in `/work` kan.
2. `CLAUDE_CODE_DISABLE_CLAUDE_MDS` is gedocumenteerd maar niet gemeten op CLI 2.1.287: de nameting moet een daling van ≈ 11,5k in de eerste-beurt-context geven (nulmeting 37.882). Blijft die uit, dan laadt de CLI het bestand via een andere weg (de `system/init`-event noemt een ingebouwde plugin `cc-plugin-agents-md`; `AGENTS.md` is hier een symlink naar `CLAUDE.md`) en is `--safe-mode` het alternatief (schakelt ook hooks en skills uit). De `claude_jobs`-totalen zijn hiervoor ongeschikt: de prompt-cache-warmte verschuift ze met ≈ 13k.
3. Codex kan `project_doc_max_bytes=0` weigeren als configuratiewaarde; dan eindigt de child met `DISPATCH_CHILD_RESULT_MISSING`. De lokale Codex-live-smoke (story 2 taak 2 stap 2b) vangt dit vóór uitrol; voor Claude bestaat geen smoke, daar geldt het terugrolrecept (story 2 taak 2 stap 5). Een alternatief mechanisme om repo-documenten uit te zetten is dan een vervolgonderzoek, geen fallback in dit plan.
4. De broker valideert `sourceKeys` tegen `config.sources` en `staged.pins` (regel 185); het overslaan van het `cp` voor `__repository_base` mag die validatie niet veranderen en `materializePreparedRepository` leest uit `staged.pins`, niet uit `/sources`.
5. De live-smoke `tests/dispatch-live-review.smoke.ts` (scrum4me-docker) eist op regel 216 een passed-check voor `__dispatch_input`; story 1 taak 4 haalt die gate weg vóór de promptwijziging landt. De probe `dispatch-model-image` kent geen checks-gate, wel de exacte env-lijst (story 1 taak 1 stap 3).

## Taakvolgorde en afhankelijkheden

1. De nulmeting is op 2026-10-12 uitgevoerd, vóór enige codewijziging, met de bevroren body (die pinde al alleen het plan); zij staat met ids en usage in docs/reviews/2026-10-12-review-context-meting.md, buiten de sprintvolgorde als afgeronde voorwaarde; uitrol en nameting controleren dat document eerst.
2. Story 1 (vier taken) en story 2 taak 1 zijn onafhankelijk en kunnen parallel; twee repo's, geen gedeelde bestanden.
3. Story 3 is doc-only en kan parallel.
4. Story 2 taak 2: bouwen, probe en Codex-smoke (stap 1-2b) na merge van story 1 en story 2 taak 1; uitrol (stap 4) pas na JP-akkoord; daarna story 4 (nameting + meetdocument). Bij DISPATCH_CHILD_RESULT_MISSING of een nameting zonder verdict: terugrollen (stap 5).

## Increment 2 (richting, niet uitgewerkt)

- Rondebody: "Fragments from other repositories" en JP's doel/beslissingen als klein gepind `.md` in de repo in plaats van elke ronde in de body; `summary` in de kind-prompt begrenzen tot ≤ 1.000 tekens (nu ≤ 4.000, grotendeels een herhaling van het rapport).
- `get_job_status` geeft de usage-kolommen terug, zodat de loop per ronde de kosten in het Review record zet zonder DB-toegang.
- Het CLI-aandeel van de Claude-child (≈ 25k gemeten in de eerste beurt: systeemprompt, tool-schema's, skills-, agent- en deferred-tool-lijsten, auto-memory) waar configureerbaar uitzetten; Codex-tegenhanger van de hook-hygiëne (`/work/.codex/hooks.json` wordt nu wel geladen).
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

### Ronde 2 (rev 2, commit `7f71e4f`, pin sha256 `47baedd3…a8133`)
**Reviewers (dispatch-jobs, alleen het plan gepind):**
- **CODEX:** request `96be2295-1cf8-4684-b06b-536172b6de33`, root `a9d3c357-fe9a-42a9-9e75-ca1cb061427c`, key `86d5f5a3-51fd-44ea-9339-9e5904bf1198`. Verdict **NO-GO**: 1 MAJOR, 3 MINOR. Ronde-1-fixes: 1, 3, 5, 6 held; 2, 4, 7 partially held.
- **CLAUDE:** request `d4217c4d-0c8b-4ee4-93a3-f3c82f4f969f`, root `82ff835c-8012-4dbf-803c-af48d6db1a78`, key `a991d2b4-7fba-4f81-8321-d50c47c1663c`. Verdict **NO-GO**: 2 MAJOR, 8 MINOR. Ronde-1-fixes: 2–6 held, 1 partially (nieuwe assert fout), 7 mostly held.

**MAJORs (alle geverifieerd, overgenomen in rev 3):**
- **CODEX MAJOR-1 — nulmeting in de sprintvolgorde.** Story 4 had nul- én nameting in één taak ná de uitrol-story; de sprint-dispatcher plant stappen niet om stories heen. Rev 3: de nulmeting is op 2026-10-12 uitgevoerd op het woord van JP en staat als afgeronde voorwaarde in de story-beschrijving en het meetdocument; de enige sprinttaak is de nameting plus meetdocument.
- **CLAUDE MAJOR-1 — vlaggen raken QUEUE_TASK-children.** `buildClaudeArgs`/`buildClaudeEnv`/`buildCodexArgs` hebben geen action-parameter; dezelfde child bedient free_task/task_implementation (`choosePromptFile(built.input.action)`, regel 302). Rev 3: vlaggen alleen bij action `review` via een `review`-parameter op de builders en de ADAPTERS-koppeling; tests per action (reviewInput/taskInput bestaan al in de testfile, regel 20-22).
- **CLAUDE MAJOR-2 — `'review.verdict'` staat niet in de prompts** (`grep` geeft 0; de prompts hebben de JSON-sleutel `"verdict"` op regel 39). Rev 3: assert op `"verdict"` en `` `review.documents` ``.

**MINORs overgenomen:** broker-skip moet ook de post-copy `hashSource(target)` overslaan (CLAUDE); regel 9 van beide prompts expliciet (CLAUDE); integriteitszin onderbouwd met `buildChildPayload` (dispatch-child.ts 64-67, 299) en commentaar sources.ts:80 (CLAUDE); Codex-live-smoke als pre-uitrol-bewijs toegevoegd — bestaat alleen voor CODEX, regel 136 (CLAUDE); Claude-acceptatie ook "lager dan nulmeting" (CLAUDE); story 3-skillregel crediteert story 4 niet meer (CLAUDE); grep-telling (CLAUDE); bereikbaarheidscheck b3caa8c (CLAUDE); AGENTS.md-in-home-fallback geschrapt (CODEX); "voordat hij één bronbestand opent" vervangen door de echte maat (CODEX); de bewering in de rondebody dat `/work/…iss-2…md` rev 5 was klopte niet (het bestand op main is inmiddels 222 regels, sha `570f8a9a…`) — de pin van de nulmeting (`b3caa8c`, `a587bf14…`) is wel juist en is door beide nulmeting-jobs opgehaald (CODEX/CLAUDE).

**Niet overgenomen:** CLAUDE MINOR "de probe pint ook de argv letterlijk". Bewijs: `tests/dispatch-model-image.integration.ts:40` (`hasPair`) en `:123` (`modelAndEffortInArgv`) controleren alleen de model/effort-paren in `argv_tail`, geen letterlijke argv. Geen wijziging nodig; in de taak benoemd.

**Adjudicatie:** beide reviewers accepteren het behoud van story 1 taak 3 (broker-skip; de bundle is 1,7 MB in de container) en de afwijzing van uitstel van story 3 (CLAUDE: het record in de huidige ISS-2-versie loopt van regel 121 tot 222 van 222).

**Scope-delta:** kleiner voor task-children (geen gedragswijziging meer); één extra operatorstap (Codex-smoke, ≈ $0,45) vóór de JP-gate; de nulmeting is uit de sprint gehaald omdat zij al is gedaan. Eerste bruikbare resultaat ongewijzigd.

### Ronde 3 (rev 3, commit `8ebce42`, pin sha256 `5f3481ed…6d127`)
**Reviewers (dispatch-jobs, alleen het plan gepind):**
- **CODEX:** request `e83db575-c58e-413a-b0b9-02c591c48893`, root `5e2f6c5a-2ab0-4224-8712-4b4f680538ae`, key `81e3e233-216d-4c3f-a7f1-e34900ea8b7e`. Verdict **NO-GO**: 1 MAJOR, 2 MINOR. Ronde-2-fixes: 1, 2, 4, 5, 6, 7 held; 3 partially held.
- **CLAUDE:** request `cec0a19e-de7b-4aa8-9674-cbf73c7417bc`, root `5e31324c-6875-40b1-a393-223ae6acd90e`, key `9322cbb9-c4c9-478f-9dbc-f8ed972daf7f`. Verdict **NO-GO**: 1 MAJOR, 8 MINOR. Ronde-2-fixes: 1, 2, 4, 5 held; 6 mostly; 3, 7 partially.

**Convergente MAJOR (geverifieerd, overgenomen in rev 4):** het plan noemde de nulmeting "afgerond" terwijl de CLAUDE-job op het gepinde commit nog wachtte en `docs/reviews/2026-10-12-review-context-meting.md` niet bestond; geen gate vóór uitrol eiste een geldige nulmeting. Rev 4: het meetdocument staat in de repo met beide job-ids, verdicts (GO/GO) en de letterlijke SQL-uitkomst (Claude cache_write 112.537 + input 38; Codex input 77.553); uitrol (story 2 taak 2 stap 0a) en nameting (story 4 stap 0) eisen dat document met DONE/succeeded, verdict en niet-null usage.

**Acceptatie aangepast op de nulmeting (aan JP voorgelegd):** de unieke Claude-context op dit één-pin-document is 112.6k; de delen die story 1 en 2 wegnemen zijn ≈ 12k (CLAUDE.md) + ≈ 1,5k (tweede lezing van de body); de rest is het CLI-aandeel (≈ 20k) en de broncode die de reviewer voor deze review leest. Een absolute grens van 80k is daarmee op dit document niet haalbaar door dit increment (CLAUDE waarschuwde hiervoor in ronde 2 en 3). Rev 4: Claude-acceptatie = daling ≥ 10k ten opzichte van de nulmeting; Codex = lager dan nulmeting; absolute waarden als diagnose; sprintdoel en doelzin herschreven. Dit verandert de in rev 1 voorgestelde grens en is een beslissing van JP bij de plangoedkeuring.

**MINORs overgenomen:** grep-telling (5 in tests, CLAUDE); `ls-remote` ziet geen niet-tip-commit → raw-fetch/`git fetch` + `cat-file` (CLAUDE); slotzin van promptregel 9 expliciet geschrapt (CLAUDE); `sources.ts` in de bestandenlijst en de randvoorwaarde "src/dispatch wijzigt niet" gecorrigeerd tot "alleen een commentaarregel" (CLAUDE); `listSourceArtifacts` doet alleen `readdir` — geen manifest-vergelijking, dus geen weigering bij ontbrekende bundle; `source_artifacts`-bewering gecorrigeerd naar de child-payload (CLAUDE); ADAPTERS-wrapper-vorm voor `buildClaudeEnv` (CLAUDE); CLI-aandeel als increment-2-regel (CLAUDE); de skill-bestanden en de validator zijn niet als bron meegegeven — bewust: de skill staat buiten git op de Mac en is een operator-preflight, de validator-regel (`checks: z.array(…)`, regel 120) is door de orchestrator lokaal gecontroleerd (CODEX, onverifieerbaar-lijst).

**Adjudicatie:** beide reviewers bevestigen de afwijzing van "de probe pint argv letterlijk" (`hasPair`/`modelAndEffortInArgv`).

**Scope-delta:** geen nieuw werk; de acceptatie is eerlijker gemaakt op de gemeten nulmeting (zie boven, JP-beslissing). Eerste bruikbare resultaat: de nameting toont de gemeten daling.

### Ronde 4 (rev 4, commit `41aca26`, pin sha256 `fa4036b1…a8ab2`)
**Reviewers (dispatch-jobs, alleen het plan gepind):**
- **CODEX:** request `3dd34334-1394-47b3-a73d-5492f05e3a43`, root `e3f7a7b4-6eb8-4de3-9fda-30e0cc78b417`, job `609a2b0e-82f6-4d37-b71c-30c7bc145183`, key `137d1951-8ab9-4e78-b07a-518168177603`. Verdict **GO**: 0 MAJOR, 2 MINOR. Ronde-3-fixes: alle held (2 partially: componentverdeling blijft een schatting).
- **CLAUDE:** request `6aba81f2-81dd-4328-a020-da7139a1c199`, root `88809ed7-2960-44b2-b370-3c9761f96b2c`, job `1f33f101-7003-4049-928e-991547e20f06`, key `20d1ccda-3ad7-41b2-bb25-95ad43d25ab5`. Verdict **NO-GO**: 1 MAJOR, 6 MINOR. Ronde-3-fixes: 1, 3, 4, 5, 6, 8 held; 2, 7 partially.

**CLAUDE MAJOR-1 (geverifieerd, overgenomen in rev 5) — de ≥ 10k-maat op `claude_jobs`-totalen is niet beslisbaar.** De gedeelde CLI-prefix (≈ 13k) staat bij een warme prompt-cache in cache_read en bij een koude in cache_write; dat verschuift `cache_write + input` met ongeveer het verwachte effect. Bewijs uit de run-logs op scrum4me-server (read-only gelezen): nulmeting-job 84f67fa4 eerste assistant-event `input 2 + cache_creation 24.639 + cache_read 13.241 = 37.882`; twee andere Claude-jobs van dezelfde avond 38.272 en 38.266 (stabiel ±0,5k) tegenover totalen van 107k–113k. Rev 5: beslissende Claude-maat = eerste-beurt-context uit de run-log (≤ 27.882 in de nameting); totalen zijn diagnose; Codex heeft één `turn.completed` en dus alleen de gedragscheck (checks-vorm, verdict) plus diagnose. Het meetdocument bevat het run-log-fragment en de nulmeting-waarde.

**Acceptatie-adjudicatie:** beide reviewers steunen het loslaten van de absolute 80k (CODEX: "retain the measured-drop criterion, subject to JP's approval"; CLAUDE: "dropping the absolute 80k is right … what is wrong is the instrument"). De beslissing blijft aan JP bij de plangoedkeuring.

**MINORs overgenomen:** 12k/1,5k als verwachting benoemd en "niet haalbaar" vervangen door "niet als verwacht resultaat gedragen" (CODEX); broker-skip geldt ook voor repo_write — bewust, geen lezer na de child (`dispatch-source-staging.ts:127` fetcht uit het staging-pad), taakprompts gebruiken de bundle niet (CLAUDE); checks-criterium: precies één `source:<key>` per documentkey, geen `source:__*`, andere namen toegestaan (CLAUDE); grep-telling ≥ 3 of `not.toHaveProperty` (CLAUDE); Codex laadt maximaal 32 KiB van AGENTS.md ≈ 8k (CLAUDE); "≈ $6" → ≈ $2,35 (CLAUDE); CLAUDE.md op b3caa8c = 46.768 B, "twee nieuwe replies" (CLAUDE); Codex-hooks als increment-2-hygiëne (CLAUDE); review focus 2 verwijst naar de eerste-beurt-maat en de `cc-plugin-agents-md`-route (CLAUDE).

**Niet overgenomen:** geen.

**Scope-delta:** geen nieuw werk; de meetstap leest één run-log op scrum4me-server in plaats van alleen de DB. Eerste bruikbare resultaat ongewijzigd.

### Ronde 5 (rev 5, commit `b43272d`, pin sha256 `1af5c3ee…c63e`) — **GO / GO**
**Reviewers (dispatch-jobs, alleen het plan gepind):**
- **CODEX:** request `0f9d5064-3692-4d6b-8128-123fe71d48da`, root `fdb9d512-0563-4eb5-883f-c18b6b081d20`, job `e0653e10-d06a-4ac7-9bb8-ecf198592a2b`, key `7aee5c4b-3e4f-4256-8a52-84e263acee60`. Verdict **GO**: 0 MAJOR, 3 MINOR. Ronde-4-fixes: 1, 2, 3, 5, 6 held; 4, 7 partially.
- **CLAUDE:** request `509e9e14-8f76-4005-9deb-c2934423f241`, root `78332d93-97d2-45be-88e2-0bab200c332c`, job `76daebe1-e91c-4989-b8b3-c83dada67cb6`, key `98ea001d-edc7-4298-b85e-0bf117e60372`. Verdict **GO**: 0 MAJOR, 5 MINOR. Ronde-4-fixes: 2–7 held, 1 partially. Eigen datapunt van de reviewer: eerste beurt 2 + 25.022 + 13.241 = 38.265 op CLI 2.1.287, binnen de ±0,5k-band.

**Instrument-adjudicatie:** beide reviewers bevestigen de eerste-beurt-context als juiste maat voor de vaste context (warmte-onafhankelijk by construction) en de ≥ 10k-grens als redelijk bij een verwachting van ≈ 11,5k; de Codex-splitsing (gedragscheck beslissend, tokens diagnose) is eerlijk. CODEX: een GO keurt de vervanging van de absolute 80k niet goed — dat blijft JP's beslissing bij de plangoedkeuring.

**MINORs overgenomen in rev 6 (geen nieuwe ronde: MINOR is verenigbaar met GO):** Doel-zin op de eerste-beurt-maat (CODEX/CLAUDE); verwachting ≈ 11,5k alleen uit CLAUDE.md, de body-herlezing naar de totalen-diagnose, CLI-aandeel ≈ 25k (CLAUDE); `claude_code_version` en tools/skills/plugins-aantallen uit `system/init` van beide run-logs vastleggen en bij afwijking "confounded" melden — nulmeting 2.1.287, 24/17/2 (CLAUDE, belangrijkste MINOR); randband 9k–11k, ≥ 10k is een pass (CLAUDE); Codex-verwachting benoemt de kolom (CLAUDE); smoke-gate telt precies één passed-entry per documentkey (CODEX/CLAUDE); "(below)" → "(see Input above)" (CLAUDE). Skill- en validator-bronnen blijven operator-preflight (CODEX).

**Scope-delta:** geen. Fase plan afgerond; ceremonie pas na akkoord van JP (plan én acceptatiewijziging).
