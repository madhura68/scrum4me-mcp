# Fix-plan — tier-preferentie enum-ordinal in `buildHigherTierIdleFragment`

**Status:** draft (awaiting codex review)
**Author:** mac:claude
**Datum:** 2026-06-08
**Diagnose-bestand:** s4m-queue task `bd8a083d-8a92-44f8-bf8a-2ea9b1995141` (scrum4me-server:claude diagnose, 2026-06-08 10:37 UTC)

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

De subquery vindt nooit een rij. `NOT EXISTS (...)` is altijd `TRUE`. Het tier-fragment is dus een **complete no-op** voor élke combinatie van capabilities. Claims gaan first-come via `FOR UPDATE OF cj SKIP LOCKED`.

Live evidence: PLAN_CHAT CODEX-canary `cmq523mlc0002mooixjp3xabn` (s4m-queue `fd5f2b7d` seed) werd om 10:16:51 UTC geclaimd door 154's LOW_P codex `b9c507061b82` terwijl max2's HIGH_P codex `9d9858c45d5b` healthy + idle was. Q5 in de diagnose herconstrueerde de subquery vanuit 154's perspectief en bevestigde: alle voorwaarden behalve `higher_tier` waren TRUE; `higher_tier` was FALSE → subquery 0 rijen → claim niet geweigerd.

> **Niet codex-specifiek.** De bug was altijd actief; tot Phase B (worker-capability rollout) hadden alle workers dezelfde tier (null of LOW_P), waardoor het no-op-zijn van de fragment geen waarneembare consequentie had. De canary op divergente tiers (max2=HIGH_P, scrum4me-server=LOW_P) bracht het aan het licht.

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

### Step 2: Aanvullen `__tests__/build-higher-tier-idle-fragment.test.ts`

Het bestaande test-bestand dekt structurele SQL-text-shape. Voeg **regression tests** toe die expliciet de ordinal-bug onmogelijk maken — niet enkel via tekst-match, maar via SQL-text die de CASE-priority bewijst:

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

De bestaande tests in dit bestand (`AND NOT EXISTS`, `FROM claude_workers w`, etc.) blijven onveranderd én moeten nog passeren — de fragment is functioneel equivalent op alle dimensies behalve de priority-vergelijking.

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
- **NULL-capability legacy-pad.** De CASE retourneert NULL voor onbekende waarden; `NULL > X` is NULL. Dit moet bestaande "legacy worker zonder capability"-rijen niet uit de fleet sluiten. Mitigatie: bestaande Step-2 test (`passes null capability through (legacy worker semantics: no blocking)`) blijft staan en valideert het.
- **PostgreSQL CASE-expression semantiek.** Een lange CASE-clause is iets duurder dan een directe enum-vergelijking. Voor een subquery die per claim-poging één keer evalueert is dit verwaarloosbaar; geen index nodig.

## Out of scope

- Toevoegen van `MEDIUM_P`-deployment elders (Phase B rollout staat los; we wijzigen alleen de fragment).
- Aanpassen van `parseWorkerRuntime`, `getWorkerRuntimeFromEnv` of capability-tags in `run-one-job.ts`.
- Migratie van de enum-volgorde in Prisma-schema (Optie B — actief afgewezen).
- Een SQL-functie maken voor priority-mapping. YAGNI tot er een tweede call-site is.
- Capability-tags op jobs (`required_capability`) — die werken al via `buildClaimableJobWhereFragment` en raakt niet door deze fix.
