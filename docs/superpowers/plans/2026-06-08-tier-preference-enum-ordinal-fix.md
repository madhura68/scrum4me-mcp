# Fix-plan — tier-preferentie enum-ordinal in `buildHigherTierIdleFragment`

**Status:** r2 (codex round-1 GO na twee P2-edits + twee P3-nuances — verwerkt hieronder)
**Author:** mac:claude
**Datum:** 2026-06-08
**Diagnose-bestand:** s4m-queue task `bd8a083d-8a92-44f8-bf8a-2ea9b1995141` (scrum4me-server:claude diagnose, 2026-06-08 10:37 UTC)
**Review-bestand r1:** `/Users/janpetervisser/Development/s4m-queue/reviews/2026-06-08-scrum4me-mcp-tier-preference-fix-plan-review-codex.md`

## Goal

`buildHigherTierIdleFragment` (`src/tools/wait-for-job.ts:385`) baseert tier-preferentie op directe enum-vergelijking (`w.capability > selfCapability`). De `WorkerCapability`-enum is gedeclareerd in **aflopende prioriteit** (HIGH_P=1, MEDIUM_P=2, LOW_P=3 in Postgres-ordening), waardoor de "higher" operator semantisch op z'n kop staat. Vervang door een expliciete CASE-priority zodat de fragment robuust is tegen toekomstige enum-declaratie-volgorde en de naam/intent matched met de werking.

## Problem (grounded)

### Wat de fragment beweert te doen

[`src/tools/wait-for-job.ts:376-385`](src/tools/wait-for-job.ts:376):
> Excludes claims when any other alive idle worker with strictly **higher** capability exists for the same user + runtime.

[`src/tools/wait-for-job.ts:393`](src/tools/wait-for-job.ts:393):
```sql
AND w.capability > ${input.selfCapability}::"WorkerCapability"
```

### Wat het écht doet

Bevestigd door diagnose 2026-06-08 (Q3 in s4m-queue `bd8a083d` antwoord):
```sql
SELECT 'HIGH_P'::"WorkerCapability" > 'LOW_P'::"WorkerCapability";  -- false
SELECT 'LOW_P'::"WorkerCapability"  > 'HIGH_P'::"WorkerCapability";  -- true
```

Postgres ordent enums op declaratievolgorde. [`prisma/schema.prisma:34-38`](prisma/schema.prisma:34) declareert:
```prisma
enum WorkerCapability {
  HIGH_P
  MEDIUM_P
  LOW_P
}
```
→ ordinals: HIGH_P=1, MEDIUM_P=2, LOW_P=3. Dus `HIGH_P < MEDIUM_P < LOW_P` in enum-vergelijking. De expressie `w.capability > selfCapability` vindt **alleen** workers met een **lagere** tier (= grotere ordinal), nooit een hogere.

### Het gevolg

De expressie `w.capability > selfCapability` is **semantisch omgekeerd**, niet leeg (P2.2 uit codex r1: mijn oorspronkelijke "complete no-op"-statement was te beknopt). Drie subscenario's per caller-tier:

| Caller-tier | Zoekt peers met ordinal | Vindt in praktijk | Gevolg |
|---|---|---|---|
| **LOW_P** (ordinal 3) | `> 3` | geen (LOW_P is grootste) | claim nooit geblokkeerd (toevallig "correct" maar om de verkeerde reden) |
| **MEDIUM_P** (ordinal 2) | `> 2` | LOW_P (ordinal 3) | **geblokkeerd door een lager-tier idle worker** |
| **HIGH_P** (ordinal 1) | `> 1` | MEDIUM_P + LOW_P | **geblokkeerd door beide lager-tier idle workers** |

Dat verklaart onze canary precies: 154 LOW_P claim passed altijd (alle peers hebben lagere ordinal); max2 HIGH_P claim werd **actief geblokkeerd door 154's idle LOW_P-aanwezigheid**. Niet first-come, actief omgedraaide voorrang. Live evidence: PLAN_CHAT CODEX-canary `cmq523mlc0002mooixjp3xabn` (s4m-queue `fd5f2b7d` seed) werd om 10:16:51 UTC geclaimd door 154's LOW_P codex `b9c507061b82` terwijl max2's HIGH_P codex `9d9858c45d5b` healthy + idle was. Q5 in de diagnose herconstrueerde de subquery vanuit 154's perspectief en bevestigde `higher_tier=FALSE` → subquery 0 rijen → claim niet geweigerd.

Claims gaan in praktijk via `FOR UPDATE OF cj SKIP LOCKED`, maar de tier-clause beïnvloedt de winnende worker NIET naar wens.

> **Niet codex-specifiek.** De bug was altijd actief; tot Phase B (worker-capability rollout) hadden alle workers dezelfde tier (null of LOW_P), waardoor de omgekeerde-prioriteit geen waarneembare consequentie had. De canary op divergente tiers (max2=HIGH_P, scrum4me-server=LOW_P) bracht het aan het licht.

## Options considered

### A — CASE-priority in de SQL *(aanbevolen)*

Vervang de directe enum-vergelijking door een expliciete priority-mapping in beide kanten van de `>`-operator:

```sql
AND CASE w.capability
      WHEN 'HIGH_P' THEN 3
      WHEN 'MEDIUM_P' THEN 2
      WHEN 'LOW_P' THEN 1
    END
  > CASE ${input.selfCapability}
      WHEN 'HIGH_P' THEN 3
      WHEN 'MEDIUM_P' THEN 2
      WHEN 'LOW_P' THEN 1
    END
```

**Pros:**
- **Robuust tegen enum-declaratie-volgorde.** Of de enum nu HIGH→LOW staat (huidig) of LOW→HIGH (toekomst), de semantiek blijft correct.
- **Self-documenting.** Een lezer ziet meteen "HIGH=3, MEDIUM=2, LOW=1, hoger getal = hogere prioriteit".
- **Geen migratie-risico.** Pure SQL-tweak; geen enum-recreate, geen schema-change.
- **Behoudt NULL-semantiek.** `CASE w.capability WHEN ... END` levert `NULL` als `w.capability IS NULL` (geen WHEN matched), en `CASE selfCapability WHEN ... END` idem. `NULL > NULL` = NULL = drop row → behoud van het bestaande "NULL-capability is legacy + niet-blocking" gedrag.

**Cons:**
- Iets meer SQL-text dan een operator-flip.
- Twee CASE-statements zijn duplicatie; je zou een SQL-functie kunnen overwegen (out of scope — YAGNI tot er een tweede call-site is).

### A.simple — operator flippen `>` → `<`

```sql
AND w.capability < ${input.selfCapability}::"WorkerCapability"
```

**Pros:**
- Eén-karakter fix.

**Cons:**
- **Fragiel.** Breekt stil als de enum ooit her-gedeclareerd wordt op de logische volgorde (LOW_P, MEDIUM_P, HIGH_P).
- **Misleidend.** De naam `buildHigherTierIdleFragment` + de doc-comment "strictly higher capability" matchen niet met `<`. Een lezer wordt actief in de verkeerde richting gestuurd.
- **Subtiele NULL-asymmetrie risk.** `null < 'HIGH_P'` heeft dezelfde NULL-semantiek als `>`, dus geen nieuw NULL-gat — maar het is iets om in de test expliciet te dekken.

### B — Enum her-declareren oplopend (`LOW_P, MEDIUM_P, HIGH_P`)

**Cons (genoeg om het direct af te schieten):**
- Postgres kan een enum niet in-place herordenen. Een migratie vereist: nieuwe enum-type aanmaken, alle kolommen rewriten met cast, oude type droppen. Dat raakt elke bestaande `claude_workers.capability`-rij — invasief + downtime.
- Mismatch met de Prisma-schema (Prisma kent geen migrate-strategie voor enum-reorder zonder destructive change).
- Zelfs ná de migratie hangt de SQL fragile aan een specifieke enum-volgorde, terwijl Optie A daar onafhankelijk van wordt.

### Decision

**Optie A.** Eenmalig iets meer SQL-tekst, blijvend robuust + self-documenting.

## Implementation

### Step 1: Update `buildHigherTierIdleFragment`

Vervang [`src/tools/wait-for-job.ts:385-403`](src/tools/wait-for-job.ts:385) met:

```ts
/**
 * Returns a SQL fragment that the caller appends inside the WHERE-clause of a
 * claim query. Excludes claims when any other alive idle worker with strictly
 * higher capability exists for the same user + runtime.
 *
 * Priority mapping (NOT the enum ordinal — see below):
 *   HIGH_P   = 3
 *   MEDIUM_P = 2
 *   LOW_P    = 1
 *
 * Why explicit CASE instead of `w.capability > selfCapability`:
 * The WorkerCapability enum is declared HIGH_P, MEDIUM_P, LOW_P (descending
 * priority), which gives Postgres-ordinals HIGH_P=1, MEDIUM_P=2, LOW_P=3 —
 * exactly inverted vs. semantic priority. A direct `>` comparison would
 * therefore find LOWER-tier workers, not higher ones (the original 2026-06-08
 * canary bug; see docs/superpowers/plans/2026-06-08-tier-preference-enum-ordinal-fix.md).
 *
 * Null-capability semantics: if either self or peer has NULL capability, the
 * CASE evaluates to NULL and the comparison drops the row — preserving the
 * pre-fix "first-come for unset workers" behaviour.
 */
export function buildHigherTierIdleFragment(input: HigherTierIdleInput): Prisma.Sql {
  return Prisma.sql`
    AND NOT EXISTS (
      SELECT 1 FROM claude_workers w
      LEFT JOIN users u ON u.id = w.user_id
      WHERE w.user_id = ${input.selfUserId}
        AND w.runtime = ${input.selfRuntime}::"AgentRuntime"
        AND w.instance_id <> ${input.selfInstanceId}
        AND CASE w.capability
              WHEN 'HIGH_P' THEN 3
              WHEN 'MEDIUM_P' THEN 2
              WHEN 'LOW_P' THEN 1
            END
          > CASE ${input.selfCapability}::"WorkerCapability"
              WHEN 'HIGH_P' THEN 3
              WHEN 'MEDIUM_P' THEN 2
              WHEN 'LOW_P' THEN 1
            END
        AND w.last_seen_at > NOW() - INTERVAL '30 seconds'
        AND (w.last_quota_pct IS NULL OR w.last_quota_pct >= COALESCE(u.min_quota_pct, 0))
        AND NOT EXISTS (
          SELECT 1 FROM claude_jobs k
          WHERE k.worker_instance_id = w.instance_id
            AND k.status IN ('CLAIMED','RUNNING')
        )
    )
  `
}
```

Geen wijziging in de input-type (`HigherTierIdleInput`); geen call-site changes elders.

### Step 2: Update + uitbreiden `__tests__/build-higher-tier-idle-fragment.test.ts`

**P2.1 uit codex r1:** het bestaande test-bestand asserteert nu de bare `w.capability > ?::"WorkerCapability"`-vorm — dat is precies wat de fix vervangt. De P1-versie van dit plan zei abusievelijk "bestaande tests blijven onveranderd"; dat klopt niet. Twee aanpassingen in hetzelfde test-bestand:

**A. Edit de bestaande structurele test** (`it('emits NOT EXISTS guarded by higher capability, alive, idle, quota', ...)`):

Vervang de regel:
```ts
expect(text).toMatch(/w\.capability\s*>\s*\?::"WorkerCapability"/i)
```

door asserties die de CASE-priority-shape verifiëren:
```ts
expect(text).toMatch(/CASE w\.capability\s+WHEN 'HIGH_P' THEN 3\s+WHEN 'MEDIUM_P' THEN 2\s+WHEN 'LOW_P' THEN 1\s+END/i)
expect(text).toMatch(/CASE \?::"WorkerCapability"\s+WHEN 'HIGH_P' THEN 3\s+WHEN 'MEDIUM_P' THEN 2\s+WHEN 'LOW_P' THEN 1\s+END/i)
```

De overige asserties in dezelfde test (`AND NOT EXISTS`, `FROM claude_workers w`, runtime/instance-clauses, `last_seen_at`-window, quota-clause, idle-NOT-EXISTS) blijven onveranderd.

De andere twee bestaande tests in dit bestand (`binds the right values in order`, `passes null capability through`) blijven volledig onveranderd; de `frag.values`-volgorde (`userId, runtime, instanceId, capability`) stays identiek omdat we de selfCapability gewoon op een ander syntactisch pad consumeren (CASE-rhs i.p.v. de directe vergelijking).

**B. Voeg regression-tests toe** in een nieuwe `describe('priority mapping (regression for 2026-06-08 enum-ordinal bug)', ...)`-blok onderaan het bestand:

```ts
describe('priority mapping (regression for 2026-06-08 enum-ordinal bug)', () => {
  it('encodes HIGH_P=3, MEDIUM_P=2, LOW_P=1 in the SQL (not enum ordinal)', () => {
    const frag = buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'CLAUDE',
      selfCapability: 'LOW_P',
    })
    const text = sqlText(frag)
    // Both CASE expressions must contain the explicit HIGH=3, MEDIUM=2, LOW=1 mapping.
    const caseClauses = text.match(/CASE[^E]*WHEN 'HIGH_P' THEN 3 WHEN 'MEDIUM_P' THEN 2 WHEN 'LOW_P' THEN 1[^E]*END/g)
    expect(caseClauses).not.toBeNull()
    expect(caseClauses!.length).toBe(2)
  })

  it('does NOT use the bare enum-ordinal comparison w.capability > ?::"WorkerCapability"', () => {
    const frag = buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'CLAUDE',
      selfCapability: 'LOW_P',
    })
    const text = sqlText(frag)
    // The bug was an enum-ordinal comparison; the fix replaces it with CASE-priority.
    // Either of these would signal a regression to the pre-fix shape.
    expect(text).not.toMatch(/w\.capability\s*>\s*\?::"WorkerCapability"/i)
    expect(text).not.toMatch(/w\.capability\s*<\s*\?::"WorkerCapability"/i)
  })

  it('still passes the selfCapability through as a bound value (for the CASE rhs)', () => {
    const frag = buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'CLAUDE',
      selfCapability: 'MEDIUM_P',
    })
    // The bound values list stays unchanged in shape: userId, runtime, instanceId, capability
    expect(frag.values).toEqual(['u1', 'CLAUDE', 'i1', 'MEDIUM_P'])
  })
})
```

Eindstaat in dit test-bestand: **3 updated structural tests** (één edit, twee passthrough) + **3 nieuwe regression-tests** = 6 totaal. (De r1-versie van dit plan beweerde "3 oud + 3 nieuw" naast elkaar; dat was niet sluitend zoals codex r1 P2.1 aanwees.)

**Tijdens implementatie ontdekt:** `__tests__/try-claim-job-capability-filter.test.ts` heeft óók asserties tegen de bare `w.capability >` vorm (regels 30 + 40). Die test verifieert dat `tryClaimJob` de fragment wel/niet appliceert op basis van `capability !== null`. De bare-comparison marker is daar geen invariant van het test-doel; vervang door de CASE-priority marker (`CASE w.capability WHEN 'HIGH_P' THEN 3...`) zodat het test-doel behouden blijft. Eén-locatie-edit per assertie.

### Step 3: Local verify

Vanaf de worktree `/tmp/scrum4me-mcp-tier-fix`:

```bash
npx tsc --noEmit
npx vitest run __tests__/build-higher-tier-idle-fragment.test.ts
npx vitest run  # volledige suite
```

**Verwachting:** tsc clean; 6 tests passing (3 oud + 3 nieuw) in de tier-test; volledige suite groen.

### Step 4: Commit + PR

```bash
git add src/tools/wait-for-job.ts __tests__/build-higher-tier-idle-fragment.test.ts docs/superpowers/plans/2026-06-08-tier-preference-enum-ordinal-fix.md
git commit -m "fix(claim): tier-preferentie gebruikt CASE-priority i.p.v. enum-ordinal

WorkerCapability is gedeclareerd HIGH→MEDIUM→LOW (aflopende prioriteit),
zodat Postgres HIGH_P als kleinste ordinal ziet. buildHigherTierIdleFragment's
'w.capability > selfCapability' was daardoor altijd een no-op — de subquery
vond nooit een hogere-tier worker, en first-come-wins via SKIP LOCKED.
Vervang door expliciete CASE-priority (HIGH=3, MEDIUM=2, LOW=1) zodat de
fragment robuust is tegen enum-declaratie-volgorde en matched met de doc.

Bug-evidence: PLAN_CHAT CODEX-canary cmq523mlc0002mooixjp3xabn werd
geclaimd door 154's LOW_P codex terwijl max2's HIGH_P codex idle was
(2026-06-08 10:16:51 UTC, diagnose s4m-queue bd8a083d).

Plan: docs/superpowers/plans/2026-06-08-tier-preference-enum-ordinal-fix.md
(codex-review gepland)."
git push -u origin fix/tier-preference-enum-ordinal
```

Open PR via Forgejo API tegen `main` van `git.jp-visser.nl/janpeter/scrum4me-mcp`.

### Step 5: Rollout + monitoring

**Geen aparte feature flag.** De fix wijzigt het claim-gedrag direct na merge → image-rebuild → fleet-recreate. Dit is een gedragsverandering:
- Vóór de fix: tier-routing was een no-op; alle workers van dezelfde runtime/user concurreerden first-come.
- Ná de fix: HIGH_P-workers krijgen voorrang boven MEDIUM_P en LOW_P; MEDIUM_P krijgt voorrang boven LOW_P.

Operationele impact:
- **max2 (HIGH_P)** gaat de meeste codex- en claude-jobs claimen zodra de fleet recreate'd is. Het beleid van Phase B-rollout ("workers polleren per tier-preferentie") gaat dan eindelijk werken zoals bedoeld.
- **scrum4me-server (LOW_P)** workers claimen alleen nog als max2 bezet of buiten de 30s heartbeat-window is. Dat is **per-design** — LOW_P is een fallback.
- **mac (MEDIUM_P, indien actief)** zit ertussen.

Rollout-volgorde na merge:
1. scrum4me-mcp main → image-rebuild → docker rebuild → fleet-recreate over 154 + max2.
2. Verifieer met een schone seed-canary: HIGH_P-replica claimt; LOW_P-replicas blijven idle tenzij HIGH_P bezet of buiten 30s. Reuse het seed-script + Q1-Q6 query-set uit de diagnose-task.
3. Monitor 1 dag op load-balance-shift: zijn LOW_P-replicas materieel langer idle? Zo ja → by-design, geen actie. Zo nee → check of de fragment écht vuurt (eens met EXPLAIN op een live claim).

**Geen rollback nodig.** Als de fix tegenvalt is `git revert` voldoende; de SQL is zelfstandig en raakt geen migration of data.

## Verification (rolled up)

- Diagnose bewijst de bug (s4m-queue `bd8a083d`). **Gate.**
- tsc + vitest tier-test 6/6 + volledige suite groen (Step 3). **Gate.**
- Codex r1 review GO (Step 4 voor PR-open). **Gate.**
- Post-merge canary: re-run de seed van 2026-06-08 10:16 en verwacht dat de HIGH_P-replica claimt, niet de LOW_P (Step 5). **Final gate.**

## Risks

- **Live load-balance-shift na merge.** HIGH_P gaat alle jobs eten als 'ie idle is. Mitigatie: monitor 1 dag; als LOW_P essentieel actief moet blijven (bv. voor specifieke kind-affiniteit), heroverweeg een aanvullende routing-feature (out of scope voor deze fix).
- **NULL-capability legacy-pad — peer-side.** De CASE retourneert NULL voor onbekende waarden; `NULL > X` is NULL. Dit moet bestaande "legacy worker zonder capability"-rijen niet uit de fleet sluiten. Mitigatie: bestaande Step-2 test (`passes null capability through (legacy worker semantics: no blocking)`) blijft staan en valideert het.
- **NULL-capability legacy-pad — caller-side (P3.1 uit codex r1).** [`src/tools/wait-for-job.ts:586-593`](src/tools/wait-for-job.ts:586) wrapt de fragment-injectie in `capability !== null ? buildHigherTierIdleFragment(...) : Prisma.empty`. Dat betekent: een **actieve** legacy worker met `capability=NULL` omzeilt de tier-clause **volledig** en kan first-come claimen alsof tier niet bestond — ook na deze fix. Dit is bewuste backward-compat, niet een bug. Maar **strikte tier-preferentie** geldt pas zodra elke actieve worker een non-null capability rapporteert. Mitigatie + verificatie tijdens rollout:
  ```sql
  SELECT instance_id, capability, last_seen_at
  FROM claude_workers
  WHERE last_seen_at > NOW() - INTERVAL '2 minutes'
    AND capability IS NULL;
  ```
  Verwacht: 0 rijen. Phase B-rollout heeft alle drie productie-hosts (mac=MEDIUM_P, max2=HIGH_P, scrum4me-server=LOW_P) inmiddels op non-null gezet — `worker_capability=` env-var loopt via `entrypoint.sh` + `run-one-job.ts:readWorkerCapability`. Als er toch nog actieve NULL-rijen opduiken: identificeer de bron-worker (geen `WORKER_CAPABILITY` in z'n env) en zet 'm vóór de fix-rollout.
- **PostgreSQL CASE-expression semantiek.** Een lange CASE-clause is iets duurder dan een directe enum-vergelijking. Voor een subquery die per claim-poging één keer evalueert is dit verwaarloosbaar; geen index nodig. (Codex r1 P3.2 bevestigt: drie WHEN-branches in een per-claim-subquery zijn negligible — geen blocker.)

## Out of scope

- Toevoegen van `MEDIUM_P`-deployment elders (Phase B rollout staat los; we wijzigen alleen de fragment).
- Aanpassen van `parseWorkerRuntime`, `getWorkerRuntimeFromEnv` of capability-tags in `run-one-job.ts`.
- Migratie van de enum-volgorde in Prisma-schema (Optie B — actief afgewezen).
- Een SQL-functie maken voor priority-mapping. YAGNI tot er een tweede call-site is.
- Capability-tags op jobs (`required_capability`) — die werken al via `buildClaimableJobWhereFragment` en raakt niet door deze fix.
- **Dedicated DB integration test** in CI (vereist `S4M_TEST_DATABASE_URL` setup). De tekstuele regression-tests (Step 2) + de post-merge canary (Step 5) dekken het primaire pad af; een CI integration-test met live Postgres CASE-evaluatie is nice-to-have voor later, geen blocker voor deze PR. (Codex r1 P3.2 bevestigt: "DB integration test is optional, not required for this PR".)
