---
title: On-demand repo-clone fallback voor resolveRepoRoot
slug: on-demand-repo-clone-fallback
status: reviewed
author: claude (mac)
version: 0.3
date: 2026-07-08
product: scrum4me-mcp (SC2)
touches: [scrum4me-mcp, scrum4me-docker]
review_log:
  - v0.1 → codex NO-GO (4 blockers): terminal-failure kanaal, owner-guarded lease + wait_for_job-dekking, task.repo_url-fallback, lock-semantiek
  - v0.2 → codex NO-GO ("close to GO", 2 blockers): ownerCtx ook door attachWorktreeToJob-pad; terminal-vs-transient classifier (niet elke npm-ci-fout = terminal) + SprintRun-status
  - v0.3 → codex GO (implementation-ready, geen ontwerp-blockers; msg e6743a23, 2026-07-08)
related:
  - 2026-05-24-reused-worktree-freshness-design.md
  - 2026-06-07-codex-runner-substrate-phase0-design.md (scrum4me-docker)
---

# On-demand repo-clone fallback voor `resolveRepoRoot`

> **Line-refs**: alle `file:line` in dit doc verwijzen naar **`origin/main`**
> (`scrum4me-mcp` @ 0ed4d60), de implementatie-basis. (v0.1 citeerde per abuis de
> `feat/copilot-mcp-foundation`-branch → gecorrigeerd.)

## 1. Aanleiding

`SPRINT_IMPLEMENTATION`-job voor het **scrum4me-workers**-product (idea-139) crashte
met `getFullJobContext returned null`, voorafgegaan door
`repoRoot.unresolved (productId=cmpn8hd5k…, taskRepoUrl=null)`. De job rolde terug
naar `QUEUED` en liep oneindig (re-claim → re-fail).

**Root cause:** het product had een geldige `repo_url`, maar de docker-runner-fleet
had de repo niet gecloned. `resolveRepoRoot` valt bij sprint-jobs terug op conventie
`~/Projects/<repo-name>/.git`, en die clone bestaat alleen als de repo in de
runner-env `GH_PRECLONE_REPOS` staat (bootstrap via
`scrum4me-docker/bin/repo-bootstrap.sh` bij container-start). scrum4me-workers stond
niet in die lijst → geen clone → `null`.

De directe fix (scrum4me-workers toevoegen aan `GH_PRECLONE_REPOS` op alle
runner-hosts + recreate) is uitgerold, maar legt een structureel probleem bloot:
**een geldige `repo_url` volstaat niet om een product door de fleet te laten
uitvoeren — je onderhoudt per host een env-lijst.** Elk nieuw product vereist een
config-edit op scrum4me-server én max2 + recreate, en faalt bij vergeten *hard en
stil* (oneindige requeue-loop).

## 2. Doel & niet-doel

### Doel
- Een product met geldige `repo_url` "werkt gewoon" op elke runner, zonder per-host
  `GH_PRECLONE_REPOS`-onderhoud.
- Behoud de snelheid van de warme preclone-cache (gesymlinkte `node_modules`) voor
  hot repo's; de éérste job voor een nog-niet-geclonede repo mag trager zijn.
- Geen hard/stil falen meer: een écht onoplosbare repo faalt **terminaal en
  zichtbaar**, niet in een oneindige requeue-loop.

### Niet-doel
- Geen herontwerp van de worktree-/branch-strategie (`createWorktreeForJob` blijft).
- Geen algehele requeue-loop-refactor voor niet-repo-gerelateerde faalgevallen; wél
  het **smalle** terminal-failure-kanaal dat on-demand-clone veilig maakt (§7).
- `GH_PRECLONE_REPOS` / `repo-bootstrap.sh` blijft de warm-cache-primer.

## 3. Huidige situatie (grounding, origin/main)

### 3.1 `resolveRepoRoot` — 4-staps lookup + `task.repo_url`
`src/tools/wait-for-job.ts` (`resolveRepoRoot`, regel 55). Signatuur:
`resolveRepoRoot(productId, taskRepoUrl?): Promise<string | null>`. Eerste hit wint:
1. **`task.repo_url`-override** (regel 68-87): match op repo-naam via
   `SCRUM4ME_REPO_ROOT_REPO_<name>` env → config → conventie `~/Projects/<name>`.
   **Kritiek gat**: als de task-repo niet lokaal staat, *valt het stil terug* naar
   product-resolutie (regel 88+) → een cross-repo taak draait dan in de **verkeerde**
   repo.
2. env `SCRUM4ME_REPO_ROOT_<productId>` (regel 90-91).
3. `~/.scrum4me-agent-config.json` → `repoRoots[productId]` (regel 94-98).
4. Conventie `~/Projects/<repo-name-uit-product.repo_url>/.git` via `fs.access` (104-116).

Faalt alles → `unresolved()` (regel 63-66) logt alléén `productId`/`taskRepoUrl` en
returnt `null` — **geen gestructureerde faalreden**.

### 3.2 Callsites van `resolveRepoRoot`
- **TASK** `attachWorktreeToJob` — regel 254; gooit al een beschrijvende error bij null.
- **cleanup** — regel 177 (removeWorktreeForJob) en regel 608 (best-effort).
- **IDEA** `setupProductWorktrees((pid) => resolveRepoRoot(pid))` — regel 1501.
- **SPRINT** — regel 1591; bij `null` → stil `rollbackClaim` + `return null`.

De fallback hoort **binnen `resolveRepoRoot`** zodat alle callers profiteren; de
task-override-tak (§3.1.1) krijgt hem óók.

### 3.3 Preclone + node_modules-symlink (het snelheidsvoordeel)
`repo-bootstrap.sh` doet per repo in `GH_PRECLONE_REPOS`: clone-of-fetch +
`git reset --hard origin/main` + volledige install. **Belangrijk**: install-fouten
zijn er *warnings* — de repo blijft bruikbaar als repo-root
(`repo-bootstrap.sh` regel 88-105). `createWorktreeForJob` → `linkNodeModules`
**symlinkt** de repoRoot-`node_modules` in elke worktree (`src/git/worktree.ts`
regel 73-82), zodat een worktree in seconden klaar is. Dít is waarom preclonen
bestaat; het blijft de warme cache.

### 3.4 Lease-timing (kritieke constraint)
`scrum4me-docker/bin/run-one-job.ts`:
- `tryClaimJob` claimt en zet `lease_until` (PBI-50 recovery = 5 min).
- `getFullJobContext(jobId)` draait daarna (regel 286). NB: de runner geeft nú alléén
  `jobId` mee — het `runtime`/`ownerCtx`-argument is een **toevoeging** van dit ontwerp,
  niet iets wat de runner vandaag al doet.
- De **job-lease-renewal `setInterval(60s)`** start **pas op regel 413** — ná
  `getFullJobContext`, ná TASK-worktree-attach (regel 310+), payload-write én
  arg-constructie. De worker-*presence*-heartbeat (regel 224) start eerder maar
  is niet de job-lease. De renewal-SQL update **op `id` alleen** (regel 415).
- **Tweede pad**: de MCP-tool `wait_for_job` roept `getFullJobContext(jobId, runtime)`
  óók aan (regel 1806, 1858) — dit is het pad voor niet-docker agents (Mac/max2
  claude via MCP). Daar is er **geen** runner-heartbeat.

⇒ Een langlopende clone + install binnen `resolveRepoRoot`/`getFullJobContext`
draait **zonder job-lease-renewal**, op *beide* paden. Overschrijdt het 5 min →
`resetStaleClaimedJobs` kan de job herclaimen (dubbele uitvoering). De naïeve
renewal-op-`id` kan bovendien een job renewen die je **niet meer bezit**.

## 4. Voorgesteld ontwerp (Approach A: fallback in `resolveRepoRoot`)

Stap-5 fallback: ontbreekt de conventie-clone maar is er een geldige repo-url, dan
**cloon on-demand** (mirror van bootstrap) en returnt het pad. Preclone blijft de
snelle pad. De fallback geldt zowel voor de **task-override** (§3.1.1) als de
**product**-tak.

```
task.repo_url aanwezig?
  ja → probeer env/config/conventie (bestaand)
     → niet lokaal? → CLONE task-repo on-demand (§4.a)
         faalt → TERMINAL-fail (NIET stil degraderen naar product-repo)
product-tak:
  env/config/conventie hit? → gebruik (warm, ongewijzigd)
  anders repo_url geldig?   → CLONE product-repo on-demand (§4.a)
      faalt → TERMINAL-fail
  geen bruikbare url        → unresolved() (bestaand)
```

### 4.a De on-demand clone-helper (`cloneRepoOnDemand`)
Nieuwe helper (bv. `src/git/on-demand-clone.ts`):
1. **Lock** — acquire clone-specifieke lock (§4.3) op de parent + repo-naam.
2. **Re-check onder lock** — bestaat `~/Projects/<name>/.git` inmiddels (winnaar was
   sneller)? → return dat pad, klaar.
3. **Clone** naar **uniek temp** `~/Projects/<name>.tmp.<pid>` (HTTPS; cred-helper
   is door entrypoint gezet), `git reset --hard origin/<default>`.
4. **Install** — `npm ci` (of `npm install` zonder lockfile) **alléén als
   `package.json` bestaat**, met stamp-guard (`node_modules/.s4m-deps-stamp` op
   lockfile-hash). **Fail-fast**: install-fout ⇒ clone-readiness-fout (§4.4).
5. **Atomic** `rename(<name>.tmp.<pid>, <name>)`. Bestaat `<name>` al maar corrupt
   (`.git` aanwezig maar `git rev-parse` faalt) → onder lock verwijderen en de
   temp promoveren.
6. **`finally`**: verwijder resterende `<name>.tmp.<pid>`, release lock.
7. Succes → return pad; elke definitieve fout → typed terminal-fout (§7).

### 4.1 Lease-veiligheid (bij §3.4) — owner-guarded, caller-agnostisch
**Primair (correctheidsfix, MCP-laag):** de clone-helper start bij aanvang een
**owner-guarded lease-renewal-ticker** (elke 60s) die dekt tot de clone klaar is.
Zo is *elke* caller gedekt — docker-runner én `wait_for_job`-tool — omdat de renewal
bij de trage operatie zelf zit, niet bij één runner. Renewal-SQL is
**ownership-geguard**:
```sql
UPDATE claude_jobs SET lease_until = NOW() + INTERVAL '5 minutes'
WHERE id = :jobId AND status IN ('CLAIMED','RUNNING')
  AND worker_instance_id = :instanceId AND claimed_by_token_id = :tokenId
```
0 rijen geraakt ⇒ eigenaarschap verloren ⇒ **stop de ticker en abort de clone**
(een andere runner heeft de job). De helper heeft dus `jobId`/`instanceId`/`tokenId`
nodig.

**`ownerCtx` moet door twee paden gethreaded worden (blocker v0.2-#1)** — een TASK-clone
gebeurt **buiten** `getFullJobContext`. De default TASK-payload returnt alleen context
(regel 1729-1748); daarna roept de `wait_for_job`-tool `attachWorktreeToJob` (regel 247,
aangeroepen op 1815 en 1864), en díe roept `resolveRepoRoot` → `cloneRepoOnDemand`. Dus:
- `getFullJobContext(jobId, runtime, ownerCtx?)` — SPRINT/IDEA-clones.
- `attachWorktreeToJob(jobId, …, ownerCtx?)` → `resolveRepoRoot(…, ownerCtx?)` →
  `cloneRepoOnDemand(…, ownerCtx?)` — TASK-clones.

De owner-context is beschikbaar in de `wait_for_job`-tool: `tokenId` uit
`requireWriteAccess()` en `instanceId` uit `SCRUM4ME_WORKER_INSTANCE_ID` / `getInstanceId()`
(regel 1791-1795). De guard-kolommen zijn exact wat `tryClaimJob` bij claim zet
(`claimed_by_token_id`, `worker_instance_id`, regel 758-766).

**Secundair (defense-in-depth, runner-laag = A1):** verplaats óók de runner-heartbeat
(`run-one-job.ts` regel 413) naar vlak ná `tryClaimJob`, met dezelfde
owner-guard-WHERE. Dekt de overige trage pre-spawn-paden (TASK-attach, payload-write)
die vandaag ook lease-loos zijn. A1 is los te shippen maar hoort in dezelfde
docker-rebuild (§8).

### 4.2 Atomiciteit
`.tmp.<pid>` + same-parent `rename`. Stap-5 mag **nooit** een half-`<name>` als
"valid" laten tellen. Corrupte bestaande `<name>` (`.git` aanwezig, `rev-parse`
faalt) → onder lock repareren via herclone. Zie §4.a stap 2/5.

### 4.3 Concurrency-lock
De race is **lokale filesystem-state**, dus een file-lock, **geen DB advisory lock**.
Hergebruik het `proper-lockfile`-primitief maar **niet** de defaults van
`src/git/file-lock.ts` (regel 8: `retries:60 × 1s` ≈ 60s — te kort; een wachter
faalt terwijl de winnaar nog gezond `npm ci`'t). Clone-lock krijgt eigen instellingen:
- ruime wachtbudget (minuten, ≥ verwachte clone+install),
- `stale`/`update` afgestemd op een levende install,
- re-check ná acquire (§4.a stap 2),
- release in `finally` (kortlevende lock, **niet** als job-lange product-worktree-lock).

### 4.4 `npm ci` — bewust afwijkend van bootstrap
On-demand **fail-fast** bij install-fout wanneer `package.json` bestaat: `linkNodeModules`
gaat ervan uit dat repoRoot-`node_modules` bestaat en symlinkbaar is; zonder deps
faalt de eerste job later in `verify` op een minder actiegerichte plek. Dit **wijkt
bewust af** van `repo-bootstrap.sh` (dat install-fouten als warning logt en de repo
tóch als root laat staan): "fail-fast" = **promoveer de temp-clone niet**. Repo's
zonder `package.json` (bv. agent-rules) slaan install over.

**Belangrijk (blocker v0.2-#2):** "install-fout ⇒ terminal" is **te breed**. De fout
loopt door de classifier (§4.6): registry/netwerk/timeout tijdens `npm ci` = *transient*
→ rollback/requeue; deterministische lockfile/package-fouten = *terminal*. In beide
gevallen wordt de temp niet gepromoveerd; alleen het **kanaal** (terminal vs transient)
verschilt.

### 4.6 Terminal-vs-transient classifier (blocker v0.2-#2)
`cloneRepoOnDemand` classificeert elke git/npm-fout vóór het gooien, via een
**apart getest** helpertje:
```ts
classifyRepoBootstrapError(phase: 'clone'|'reset'|'install', err): 'terminal' | 'transient'
```
- **terminal** (definitief onoplosbaar → `TerminalJobError`, geen requeue): ongeldige/
  onondersteunde repo-URL, repo niet gevonden/404, auth geweigerd/401/403, default
  branch ontbreekt, corrupte repo na clone (`rev-parse` faalt), deterministische
  npm/package-fouten (lockfile/package-mismatch, unsupported package config).
- **transient** (herstelbaar → rollback/requeue zoals nu): DNS-fout,
  connection reset/refused, TLS/netwerk-timeout, Forgejo/registry 5xx, npm-registry-
  timeout, git-lock-contentie, early-EOF/`RPC failed`, onderbroken clone/install.

Zonder deze classificatie zou de implementatie óf terminale fouten oneindig loopen, óf
tijdelijke storingen terminaal fail-en. Vereist **unit-tests met representatieve
git/npm-stderr-strings** (§9).

### 4.5 Disk-groei
On-demand-clones stapelen ~GB per repo per runner-volume (disk-backed, 307G vrij).
Voorlopig aanvaardbaar; documenteer + observability. LRU-eviction expliciet
**uitgesteld** tot disk-druk reëel is.

## 5. Alternatieven (afgewogen)
- **B — pre-claim bootstrap in de runner.** Runner cloont post-claim, pre-context.
  Nadeel: runner kent het product pas ná claim; dupliceert cred/freshness + mist de
  `wait_for_job`-tool-pad. A centraliseert beter.
- **C — DB-gedreven preclone.** Bootstrap bevraagt DB voor alle `repo_url IS NOT NULL`
  en precloont bij start. Verwijdert lijstbeheer maar precloont *alles* (disk/startup)
  — precies wat de aanleiding wil vermijden. Later bruikbaar als **warm-list-primer**
  bovenop A, niet als vervanging.
- **D — status quo** (`GH_PRECLONE_REPOS` handmatig blijven onderhouden). Faalt hard
  en stil bij het volgende vergeten product. Afgewezen.

**Aanbeveling: A** (correctheid + geen lijstonderhoud); preclone = warm-cache; C
optioneel later.

## 6. Implementatieschets
- `src/git/on-demand-clone.ts` (nieuw): `cloneRepoOnDemand({repoUrl, name, ownerCtx})`
  met lock/atomic/install/owner-guarded-lease (§4.a/§4.1) + `classifyRepoBootstrapError`
  (§4.6); hergebruik `withRetry`/`isTransientGitError` uit `worktree.ts`.
- `src/tools/wait-for-job.ts`:
  - `resolveRepoRoot(productId, taskRepoUrl?, ownerCtx?)`: task-override-tak + product-tak
    roepen `cloneRepoOnDemand` aan als lokaal ontbreekt; behoud van bestaande hits.
  - Typed terminal-fout propageren (§7) i.p.v. kaal `null` bij terminale clone-fout.
  - `getFullJobContext(jobId, runtime, ownerCtx?)` **én** `attachWorktreeToJob(jobId, …,
    ownerCtx?)` (regel 247/1815/1864) geven owner-context door — TASK-clones lopen via
    de attach-tak, niet via getFullJobContext.
  - `wait_for_job`-tool: bouw `ownerCtx` uit `tokenId`/`instanceId` (regel 1791-1795)
    en geef door aan beide.
- `scrum4me-docker/bin/run-one-job.ts`:
  - Vervang de kale null→rollback (regel 293-296) door: **terminal-fout → markeer
    `FAILED` (geen rollback)**; alleen transient/onbekend-null → rollback (bestaand).
  - A1: owner-guarded early lease-renewal ná claim (§4.1 secundair).

## 7. Faalsemantiek — typed terminal-kanaal (blocker v0.1-#1)
Kaal `null` betekent vandaag *rollback→QUEUED* (`run-one-job.ts` regel 293-296), dus
"markeer FAILED in getFullJobContext" beklijft niet. Daarom een **getypeerd** kanaal:
- Een clone-fout die de classifier (§4.6) als **terminal** merkt ⇒ de resolve-laag
  **gooit `TerminalJobError(reason)`** (of returnt discriminated `{ terminal: true, reason }`).
  Transient ⇒ herstelbare fout → rollback/requeue zoals nu.
- De runner (`run-one-job.ts`) en de `wait_for_job`-tool onderscheiden terminal van
  kaal `null`/transient: **terminal → job `FAILED` met `reason`, géén `rollbackClaim`**.
  NB: `run-one-job.ts` regel 293-296 doet nu bij élk null-context een `rollbackClaim`;
  dat pad splitst in terminal (FAILED) vs transient (rollback).
- **SprintRun-status (v0.2-review):** bij een terminale fout op een
  `SPRINT_IMPLEMENTATION`-job moet óók de bijbehorende `sprint_run` naar `FAILED` met
  dezelfde `reason` (via de bestaande status-helper), anders staat `claude_jobs=FAILED`
  terwijl de `SprintRun` op `RUNNING` blijft hangen.
- `unresolved()` en de clone-helper leveren de gestructureerde `reason` aan.

Dit is de **minimale** verbetering om on-demand-clone veilig te maken; de bredere
requeue-refactor blijft buiten scope.

## 8. Rollout & lockstep
- Wijziging zit in de MCP-laag die runners importeren (`/opt/scrum4me-mcp`), gebouwd
  in de image via `MCP_GIT_REF`. Bevat het ook `run-one-job.ts` (§4.1-secundair/§6),
  dan is dat dezelfde `scrum4me-docker`-rebuild.
- Uitrol = image-rebuild + runner-recreate op **scrum4me-server én max2**
  (fleet-pariteit).
- MCP-runtime draait op `scrum4me-mcp-stable` (origin/main): merge → stable pull
  --ff-only + `npm ci`.

## 9. Testplan
- **Unit `resolveRepoRoot`** (gemockt fs/exec/lock/db):
  (a) conventie-hit → geen clone; (b) product mist + repo_url → clone-pad;
  (c) task.repo_url mist lokaal → clone **task**-repo, **niet** degraderen naar product;
  (d) clone-fail → `TerminalJobError` + reden (geen null-rollback);
  (e) `.tmp.<pid>`-atomiciteit (geen half `<name>` bij mid-clone-crash);
  (f) lock serialiseert twee gelijktijdige resolves → één clone, wachter hit re-check;
  (g) corrupte bestaande `<name>` → herclone.
- **Lease** (blocker v0.1-#2): owner-guard-SQL raakt 0 rijen na simulate-reclaim →
  ticker stopt + clone abort; renewal dekt clone > 5 min → geen stale-reclaim; test
  zowel runner- als `wait_for_job`-pad, én de TASK-`attachWorktreeToJob`-clone-tak.
- **Classifier** (§4.6, blocker v0.2-#2): representatieve git/npm-stderr-strings →
  correcte `terminal`/`transient`-labels (404/auth/lockfile → terminal; DNS/timeout/5xx/
  RPC-failed → transient); npm-ci-timeout → transient (requeue), lockfile-mismatch →
  terminal (FAILED).
- **SprintRun** (v0.2-review): terminale SPRINT-fout → `claude_jobs=FAILED` **én**
  `sprint_run=FAILED` (geen achterblijvende `RUNNING`).
- **E2E**: verse runner zónder scrum4me-workers in `GH_PRECLONE_REPOS` claimt een
  workers-sprintjob → resolve via on-demand-clone, worktree klopt; 2e job hit warme
  cache (geen herclone); onoplosbare repo → job `FAILED` zichtbaar (geen loop).

## 10. Besliste vragen (codex-ronde 1)
1. **Lease-laag:** A1 **én** clone-helper-renewal — owner-guarded, dekt runner +
   `wait_for_job`. (was: A1 vs A2)
2. **Lock:** `proper-lockfile`-primitief met **clone-specifieke** timeout/stale, niet
   de 60s-defaults; niet de `job-locks`-lifecycle.
3. **`npm ci`-kost:** geaccepteerd op de eerste on-demand-clone; fail-fast (§4.4).
4. **SPRINT-faalsemantiek:** in scope via het **typed terminal-kanaal** (§7).
5. **Disk-eviction:** uitgesteld; documenteren + observability.

## 11. Besliste vragen (codex-ronde 2)
1. **Terminal-vs-transient classificatie:** opgelost via `classifyRepoBootstrapError`
   (§4.6) met expliciete case-lijsten + unit-tests (§9). "install-fout" is niet meer
   pauschaal terminal.
2. **ownerCtx-threading:** owner-context wordt door **beide** paden geleid —
   `getFullJobContext` (SPRINT/IDEA) én `attachWorktreeToJob` (TASK). De
   `wait_for_job`-tool heeft `tokenId`/`instanceId` paraat (regel 1791-1795).
3. **SprintRun-status:** terminale SPRINT-fout zet óók `sprint_run=FAILED` (§7).
