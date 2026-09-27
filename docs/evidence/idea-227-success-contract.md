# IDEA-227 — bewijs succesgrens

27 september 2026. Basis MCP: `4c9489f2760dcbe37dea68d4b0c80c03d5711335`.
SDK 1.29.0; PostgreSQL 17 in eigen Docker-container `idea227-postgres`, uitsluitend loopback.
Schema uit bestaande shared-pin d8978191, zonder last_used_at. Alleen synthetische data.
De test gebruikt de echte entrypointconstructors, SDK, authenticatie, tools en PostgreSQL.
Alleen de timestamp-writer is in deze eerste proef vervangen door een tellende spy.

Uitgevoerde commando's (de expliciete lokale test-DSN staat niet in dit document):

```
npm test -- __tests__/token-usage-observer.test.ts __tests__/token-usage-transport.integration.test.ts __tests__/auth-scoped.test.ts
Test Files  3 passed (3)
Tests       30 passed (30)
npm run typecheck
# exit 0
```

| Proef | Werkelijk resultaat | Spy |
|---|---|---|
| get_context, stdio + HTTP | geldig toolresultaat, geen isError | +1 |
| create_sprint op ontbrekend product | isError=true | onveranderd |
| ingetrokken token, stdio | isError=true | 0 |
| ingetrokken token, HTTP | preflight 401 | onveranderd |
| ongeldig plan-YAML | PLAN_FAILED, isError=true na correctie | 0 |
| canary get_context | uitvoering geweigerd, isError=true | 0 |
| queue_wait_reply, stdio, annulering | LISTEN in pg_stat_activity waargenomen, client AbortError | 0 |
| get_context, HTTP disconnect | echte query geblokkeerd op products-lock; client abort vóór lock-release | onveranderd |
| queue_wait_reply, lege normale timeout | status=timeout zonder isError | +1 |

De HTTP-surface registreert bewust geen queue-tools. Een eerste ongeschikte
HTTP-wachtproef is daarom vervangen door de geblokkeerde echte leesactie.
Geen nieuwe abort-hook nodig: res.close sluit de server en SDK abort het callsignaal.
Dit bewijst server-side voltooiing, niet clientontvangst.

De SDK-tests bewijzen tevens outputSchema-/inputvalidatie, toolError, throw,
parallelle identiteitsscheiding en afwezigheid van identiteit bij health en de
vier dispatch-forwarders. De echte constructors behouden de canary-grens.

Gerichte foutpadscan: queue_done/fail en update_issue zetten interne error-outcomes
al om naar toolError; wait_for_job normaliseert worktreefouten en behoudt gewone
timeouts. queue_fail met status=failed betekent een geslaagde administratieve actie.
update_idea_plan_md was de aangetoonde uitzondering: parsefout gaf ok=false zonder
isError. De nieuwe integratietest faalde daarop en slaagt na toevoeging van isError;
het bestaande foutresultaat en PLAN_FAILED-write blijven behouden.

Geen migratie, echte timestamp, merge of deployment in deze eerste proef.
