# Managed worker bootstrap and runtime handoff — IDEA-213 IP07

This is source and operator-runbook handoff for IP14. No managed production worker, slot, profile or service was activated. R9 exact owner/token/managed-instance authority and frozen scope remain unchanged.

## One-time central operator bootstrap

Use the existing central schema-owner privilege (`current_user = scrum4me`) only. Never give this credential to a supervisor or child. Create a private JSON file with exact `owner_user_id`, original `token_id`, stable `instance_id` starting `managed:`, concrete `product_id`, runtime `CLAUDE|CODEX`, unique nonempty capabilities drawn from `review|code_edit`, and nullable tier `HIGH_P|MEDIUM_P|LOW_P`.

```sh
# DISPATCH_BOOTSTRAP_DATABASE_URL must already be provided by the authorized
# operator credential mechanism; there is deliberately no DATABASE_URL fallback.
node --import tsx scripts/dispatch-managed-worker-bootstrap.ts /operator/managed-worker.json
```

The command validates current token/owner/product authorization, serializes the exact instance, refuses every conflicting existing binding, inserts only a missing exact worker advertisement or refreshes its timestamp. It creates no slot/profile and changes no known quota. Output is only `{created:boolean}`; errors are redacted. Do not run the ordinary legacy worker registration/poll path to seed a managed worker.

After preseed, existing operator slot creation still requires fresh worker observation and freezes exact authority. Executor registration may restart an already preseeded, exactly compatible stale worker; the new authenticated incarnation refreshes only narrow observation fields. Missing/incompatible worker fails. Replaying a signed-off registration does not revive it, and old reservations/scopes remain held.

## Ongoing authenticated observation (R16)

`ExecutorHeartbeat = ExecutorSession & {busy:boolean; worker_observation?: {quota_pct:number|null; observed_at:string}}` extends the existing heartbeat, with strict keys and bounds. Job heartbeat authenticates the current actor/slot/session, then invokes the dispatch-only helper; host heartbeat rejects a job quota observation. Omission refreshes liveness and preserves known quota. Explicit quota is nullable integer0..100; timestamp must be within DB now minus30s and DB now, monotonic (equal timestamps only permit identical quota). No new endpoint, legacy poll fallback, admin Prisma pool or broad worker UPDATE/INSERT grant was added.

The forward main migration defines `public.s4m_dispatch_observe_managed_worker(uuid, timestamp with time zone, integer, boolean)` as SECURITY DEFINER, owner existing migration role, `search_path=pg_catalog`, all table references schema qualified. Policy gives EXECUTE only to scrum4me_dispatch and removes PUBLIC access. The helper derives the original owner/token/managed instance from the authenticated incarnation/slot binding and checks runtime, capabilities, tier and product compatibility. Worker table access for dispatch remains SELECT-only. Ordinary web/queue/prepared-web/observer/projector helper invocation was rejected in the real isolated DB; direct dispatch UPDATE was rejected.

Schema producer is main `ac56f016cf78b1183410cf8273de126c8e79e285`, frozen test root `schema-ip07-contract-fix`. Pure shared runtime observation additions do not change this schema producer. Preserve old SQL migrations/roots. The earlier416d producer failed contract identity precheck (named arguments); final unnamed signature/local aliases and canonical spaced contract identity passed full provision and policy checks.

## Produced runtime and capability interfaces

`RuntimePort.start(scope,permit)` requires Ed25519 permit; `stop(scope)` returns pure shared RuntimeStopObservation, never a synthetic artifact ID. The Docker consumer in IP07 provides the concrete Unix RuntimePort. The runtime scope bootId is supervisor/registration boot; observation also preserves the actual Linux runtime boot ID.

Client adds `reconcileAttempt({proof,scope_id,boot_id,image_digest,profile_sha256}):Promise<void>` for `POST /dispatch/v1/attempts/reconcile`. This is the explicit same-proof/scope contract; actual REST assembly is IP13, no guessed live endpoint was installed.

`createAgentOutputCapabilities(key)` in `src/dispatch/agent-output-capability.ts` is a central crypto producer, not a wired gateway. It uses a separate >=32-byte HMAC key and purpose/version `agent-output`. Mint accepts an already authorized internal `AgentOutputMintContext` containing exact request/candidate/generation/attempt/incarnation/input-hash/profile-hash binding, action/access and remaining attempt deadline. Token lifetime is at most300000ms and at most that deadline; future-issued, expired, wrong-binding and altered tokens are rejected.

Allowed operations are exactly `read_source`, `stage_report`, `stage_checks`, and `stage_code` only for permitted code-writing non-review actions. The child gets only this scoped token in protected attempt config. It never gets AttemptProof.credential or the general bearer. The generic control auth path refuses an agent-output token.

IP08 gateway must separately enforce current state, generation, lease, product/profile rights, per-key operation and reserved namespace on EVERY request, including real artifact provenance. IP13 mints from the actual authenticated current context and refreshes before expiry; the child cannot mint/refresh/enlarge. Storage/read handlers remain IP08 (`agent-gateway.ts` was deliberately not stubbed), immutable completion is IP09, actual assembly IP13, installation/eligibility IP14. Code-write runtime remains refused until IP08 produces and materializes the exact prepared repository/base contract (R21).
