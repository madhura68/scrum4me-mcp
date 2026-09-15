import {assertRetryAuthorization} from './retry-authorization.js'
import { randomUUID, type KeyObject } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AttemptProof, AttemptState, DispatchState, DispatchProfileConfig } from '@shared/queue-dispatch.js';
import { decideDispatchTransition } from '@shared/queue-dispatch-state.js';
import type { DispatchActor, DispatchClaimReceipt, ExecutionContext, RuntimeScope, DispatchStartPermit } from './ports.js';
import type { DispatchAuth } from './auth.js';
import { withDispatchRetryTransaction, type DispatchStore } from './db.js';
import { DispatchError } from './errors.js';
import { createAttemptCredentials, createStartPermitSigner, credentialHash, credentialMatches } from './credentials.js';
import { authenticateExecutorSession, type IncarnationScope } from './registration.js';
import { loadRegisteredCapacity } from './selection.js';
import { eligibleExecutors, tierPriority, requestJob, evaluateClaimPredicates } from './eligibility.js';
import { lockManagedTask, type ManagedRequest } from './job-adapter.js';
type Request = ManagedRequest & {
    input_hash:string;
    state: DispatchState;
    generation: number;
    first_claimed_at: Date | null;
    retry_authorization_event_id: string | null;
    principal_key: string;
    auth_source: {
        source: DispatchActor['source'];
        token_id: string | null;
    };
    root_message_id: string;
    reply_message_id: string;
};
type Candidate = {
    id: string;
    request_id: string;
    generation: number;
    route: 'job' | 'host';
    profile_revision_id: string;
    incarnation_id: string | null;
    reserved_slot_id: string;
    state: string;
    job_id: string | null;
    first_claimed_at: Date | null;
    claim_key: string | null;
};
type Attempt = {
    id: string;
    candidate_id: string;
    incarnation_id: string;
    state: AttemptState;
    scope_id: string | null;
    started_at: Date | null;
    heartbeat_at: Date | null;
    revoked_at: Date | null;
    claim_key: string;
    credential_hash: string;
    credential_key_version: number;
};
type Incarnation = {
    id: string;
    slot_id: string;
    boot_id: string;
    signed_off_at: Date | null;
    runtime_scope: IncarnationScope;
    owner_user_id: string;
    token_id: string;
    enabled: boolean;
};
type Locked = {
    r: Request;
    c: Candidate;
    a: Attempt;
    i: Incarnation;
};
const forbidden = (): never => { throw new DispatchError('DISPATCH_FORBIDDEN'); };
const conflict = (): never => { throw new DispatchError('DISPATCH_STATE_CONFLICT'); };
const actorForRequest = (r: Request): DispatchActor => ({ userId: r.user_id, tokenId: r.auth_source.token_id, source: r.auth_source.source, principalKey: r.principal_key, isDemo: false, scopedProducts: [], scopedRepos: [], tokenKind: null });
const now = async (db: PoolClient) => (await db.query<{
    now: Date;
}>('SELECT clock_timestamp() AS now')).rows[0].now;
const active = (x: Locked) => x.r.generation === x.c.generation && x.c.incarnation_id === x.a.incarnation_id && x.i.slot_id === x.c.reserved_slot_id && !x.a.revoked_at && !x.i.signed_off_at && x.i.enabled && ['CLAIMED', 'RUNNING', 'UNCERTAIN'].includes(x.c.state);
async function event(db: PoolClient, r: Request, type: string, payload: unknown) { await db.query('INSERT INTO queue_dispatch_events(id,request_id,type,actor,payload) VALUES($1,$2,$3,$4,$5)', [randomUUID(), r.id, type, { service: 'dispatch' }, payload]); }
async function state(db: PoolClient, r: Request, next: DispatchState) {
    const version = (await db.query<{
        version: string;
    }>('UPDATE queue_dispatch_requests SET state=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING version::text', [r.id, next])).rows[0].version;
    await db.query('INSERT INTO queue_dispatch_outbox(id,request_id,version,payload) VALUES($1,$2,$3,$4)', [randomUUID(), r.id, version, { version, request_id: r.id, root_message_id: r.root_message_id, reply_message_id: r.reply_message_id, state: next }]);
    r.state = next;
}
export function createDispatchAttempts(deps: {
    store: DispatchStore;
    auth: DispatchAuth;
    enabled: boolean;
    productAllowlist: readonly string[];
    credentialKeys: Record<number, Uint8Array>;
    keyVersion: number;
    startPermitPrivateKey: KeyObject;
}) {
    const credentials = createAttemptCredentials(deps);
    const signPermit = createStartPermitSigner(deps.startPermitPrivateKey);
    async function incarnation(db: PoolClient, id: string) { return (await db.query<Incarnation>('SELECT i.*,s.owner_user_id,s.token_id,s.enabled FROM queue_dispatch_incarnations i JOIN queue_dispatch_slots s ON s.id=i.slot_id WHERE i.id=$1', [id])).rows[0]; }
    async function lock(db: PoolClient, requestId: string, candidateId: string, attemptId: string): Promise<Locked> {
        const r = (await db.query<Request>('SELECT * FROM queue_dispatch_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0];
        if (!r)
            return forbidden();
        if (r.input.task_id)
            await db.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [r.input.task_id]);
        const c = (await db.query<Candidate>('SELECT * FROM queue_dispatch_candidates WHERE id=$1 AND request_id=$2 FOR UPDATE', [candidateId, r.id])).rows[0];
        if (!c)
            return forbidden();
        await db.query('SELECT id FROM queue_dispatch_slots WHERE id=$1 FOR UPDATE', [c.reserved_slot_id]);
        if (c.job_id)
            await db.query('SELECT id FROM claude_jobs WHERE id=$1 FOR UPDATE', [c.job_id]);
        const a = (await db.query<Attempt>('SELECT * FROM queue_dispatch_attempts WHERE id=$1 AND candidate_id=$2 FOR UPDATE', [attemptId, c.id])).rows[0];
        if (!a)
            return forbidden();
        const i = await incarnation(db, a.incarnation_id);
        if (!i)
            return forbidden();
        return { r, c, a, i };
    }
    function verifyProof(actor: DispatchActor, proof: AttemptProof, x: Locked) {
        if (proof.generation !== x.c.generation || proof.incarnation_id !== x.a.incarnation_id || actor.source !== 'bearer' || actor.userId !== x.i.owner_user_id
            || actor.tokenId !== x.i.runtime_scope.supervisor_token_id || !credentialMatches(proof.credential, x.a.credential_hash))
            return forbidden();
    }
    async function authorize(db: PoolClient, actor: DispatchActor, x: Locked, operation: 'claim' | 'start') {
        await deps.auth.authorizeDispatch(actor, x.r.input, operation, db);
        await deps.auth.authorizeDispatch(actorForRequest(x.r), x.r.input, operation, db);
        if (x.i.token_id !== actor.tokenId)
            return forbidden();
        const capacity = await loadRegisteredCapacity(db, x.r, deps.auth);
        const profile = capacity.profiles.find(p => p.id === x.c.profile_revision_id);
        if (!profile || profile.revoked_at || profile.sha256 !== x.i.runtime_scope.profile_sha256 || profile.config.image_digest !== x.i.runtime_scope.image_digest)
            return forbidden();
        const slots = capacity.slots.map(s => s.id === x.c.reserved_slot_id ? { ...s, open_reservation: false, live_job: false, busy: false } : s);
        const pool = eligibleExecutors(x.r, capacity.profiles, slots, await now(db)).find(p => p.route === x.c.route && p.profileRevisionId === x.c.profile_revision_id);
        if (!pool?.slotIds.includes(x.i.slot_id))
            return forbidden();
        return profile.config;
    }
    async function context(db: PoolClient, x: Locked): Promise<ExecutionContext> {
        const profile = (await db.query<{
            config: DispatchProfileConfig;
        }>('SELECT config FROM queue_dispatch_profiles WHERE id=$1', [x.c.profile_revision_id])).rows[0].config;
        const reserved = (await db.query<{
            payload: {
                job_config: {
                    model: string;
                    thinking_budget: string | null;
                    runtime: 'CLAUDE' | 'CODEX';
                };
            };
        }>("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='reserved' AND payload->>'candidate_id'=$2", [x.r.id, x.c.id])).rows[0];
        if (!reserved?.payload.job_config)
            return conflict();
        const cfg = reserved.payload.job_config;
        return { input: x.r.input, profile, proof: { request_id: x.r.id, candidate_id: x.c.id, generation: x.c.generation, attempt_id: x.a.id, incarnation_id: x.a.incarnation_id, credential: credentials.deriveAttemptCredential(x.a.id, x.a.incarnation_id, x.c.generation, x.a.credential_key_version) },
            sourceArtifacts: (await db.query<{
                key: string;
                artifactId: string;
                sha256: string;
            }>('SELECT key,id AS "artifactId",sha256 FROM queue_dispatch_artifacts WHERE request_id=$1 AND attempt_id IS NULL ORDER BY key', [x.r.id])).rows,
            modelConfig: { model: cfg.model, effort: cfg.thinking_budget, runtime: cfg.runtime } };
    }
    async function receipt(db: PoolClient, actor: DispatchActor, x: Locked): Promise<DispatchClaimReceipt> {
        const status = { requestId: x.r.id, attemptId: x.a.id, requestState: x.r.state, attemptState: x.a.state };
        const none: DispatchClaimReceipt = { ...status, authority: 'none', scopeId: x.a.scope_id, context: null };
        if (!deps.enabled || !deps.productAllowlist.includes(x.r.product_id) || !active(x) || !['CLAIMED', 'RUNNING', 'UNCERTAIN'].includes(x.r.state) || !['CLAIMED', 'RUNNING', 'UNCERTAIN'].includes(x.a.state))
            return none;
        try {
            await authorize(db, actor, x, 'claim');
        }
        catch (error) {
            if (error instanceof DispatchError)
                return none;
            throw error;
        }
        if (x.a.state === 'CLAIMED' && x.r.state === 'CLAIMED' && !x.a.scope_id)
            return { ...status, authority: 'prepare', scopeId: null, context: await context(db, x) };
        if (x.a.scope_id && x.a.started_at)
            return { ...status, authority: 'existing_scope', scopeId: x.a.scope_id, context: await context(db, x) };
        return none;
    }
    async function claimDispatchAttempt(actor: DispatchActor, incarnationId: string, claimKey: string, sessionCredential: string): Promise<DispatchClaimReceipt | null> {
        if (typeof claimKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(claimKey))
            throw new DispatchError('DISPATCH_INVALID_INPUT');
        return withDispatchRetryTransaction(deps.store, async (db) => {
            const initial = await authenticateExecutorSession(db, deps.auth, actor, incarnationId, sessionCredential);
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`dispatch-claim:${incarnationId}:${claimKey}`]);
            const prior = (await db.query<{
                request_id: string;
                candidate_id: string;
                id: string;
            }>('SELECT a.id,a.candidate_id,c.request_id FROM queue_dispatch_attempts a JOIN queue_dispatch_candidates c ON c.id=a.candidate_id WHERE a.incarnation_id=$1 AND a.claim_key=$2', [incarnationId, claimKey])).rows[0];
            if (prior) {
                const x = await lock(db, prior.request_id, prior.candidate_id, prior.id);
                await authenticateExecutorSession(db, deps.auth, actor, incarnationId, sessionCredential);
                return receipt(db, actor, x);
            }
            if (!deps.enabled)
                return null;
            const candidates = (await db.query<{
                id: string;
                request_id: string;
            }>(`SELECT c.id,c.request_id FROM queue_dispatch_candidates c JOIN queue_dispatch_requests r ON r.id=c.request_id WHERE r.state='RESERVED' AND c.state='RESERVED' AND r.generation=c.generation AND r.user_id=$1 AND r.product_id=ANY($2::text[]) ORDER BY r.created_at,c.id LIMIT 25`, [actor.userId, deps.productAllowlist])).rows;
            for (const candidate of candidates) {
                const r = (await db.query<Request>("SELECT * FROM queue_dispatch_requests WHERE id=$1 AND state='RESERVED' FOR UPDATE SKIP LOCKED", [candidate.request_id])).rows[0];
                if (!r) continue;
                if(r.first_claimed_at){try{await assertRetryAuthorization(db,r)}catch(error){if(error instanceof DispatchError&&error.code==='DISPATCH_STATE_CONFLICT')continue;throw error}}
                // Historical claims require a real, unconsumed accepted recovery event.
                await lockManagedTask(db, r);
                const c = (await db.query<Candidate>("SELECT * FROM queue_dispatch_candidates WHERE id=$1 AND state='RESERVED' FOR UPDATE", [candidate.id])).rows[0];
                if (!c || c.generation !== r.generation || c.first_claimed_at)
                    continue;
                await db.query('SELECT id FROM queue_dispatch_slots WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[c.reserved_slot_id, initial.slot_id]]);
                if (c.job_id)
                    await db.query('SELECT id FROM claude_jobs WHERE id=$1 FOR UPDATE', [c.job_id]);
                const i = await authenticateExecutorSession(db, deps.auth, actor, incarnationId, sessionCredential);
                if (c.route === 'host' && (c.incarnation_id !== i.id || c.reserved_slot_id !== i.slot_id))
                    continue;
                await deps.auth.authorizeDispatch(actor, r.input, 'claim', db);
                await deps.auth.authorizeDispatch(actorForRequest(r), r.input, 'claim', db);
                const capacity = await loadRegisteredCapacity(db, r, deps.auth), p = capacity.profiles.find(p => p.id === c.profile_revision_id);
                if (!p || p.sha256 !== i.runtime_scope.profile_sha256 || p.config.image_digest !== i.runtime_scope.image_digest)
                    continue;
                const slots = capacity.slots.map(s => s.id === c.reserved_slot_id ? { ...s, open_reservation: false } : s);
                const pool = eligibleExecutors(r, capacity.profiles, slots, await now(db)).find(p => p.profileRevisionId === c.profile_revision_id && p.route === c.route);
                if (!pool?.slotIds.includes(i.slot_id))
                    continue;
                const own = slots.find(s => s.id === i.slot_id)!, highest = slots.find(s => s.id === pool.slotIds[0])!;
                if (tierPriority(own.config.tier) < tierPriority(highest.config.tier))
                    continue;
                if (c.job_id) {
                    const j = (await db.query('SELECT * FROM claude_jobs WHERE id=$1', [c.job_id])).rows[0];
                    const expected = requestJob(r.input, r.user_id, p.config.runtime, p.id, r.id);
                    if (!j || j.claimed_at || j.dispatch_request_id !== r.id || j.dispatch_candidate_id !== c.id || j.kind !== expected.kind || j.task_id !== expected.taskId)
                        continue;
                    if (evaluateClaimPredicates({ ...expected, status: j.status, kind: j.kind, source: j.source, userId: j.user_id, productId: j.product_id, runtime: j.runtime, requiredCapability: j.required_capability, sprintRunId: j.sprint_run_id }, { userId: actor.userId, productIds: own.current_product_ids, runtime: own.config.runtime, capabilities: own.current_capabilities, managed: true, incarnationId: i.id, profileRevisionIds: own.incarnation_profile_ids, quotaPct: own.quota_pct, minQuotaPct: own.min_quota_pct }).length)
                        continue;
                }
                if (i.slot_id !== c.reserved_slot_id) {
                    await db.query('UPDATE queue_dispatch_candidates SET reserved_slot_id=$2 WHERE id=$1', [c.id, i.slot_id]);
                    await db.query('UPDATE queue_dispatch_reservations SET slot_id=$2 WHERE candidate_id=$1 AND released_at IS NULL', [c.id, i.slot_id]);
                    c.reserved_slot_id = i.slot_id;
                }
                const id = randomUUID(), secret = credentials.deriveAttemptCredential(id, i.id, c.generation, deps.keyVersion);
                await db.query("UPDATE queue_dispatch_requests SET first_claimed_at=COALESCE(first_claimed_at,now()) WHERE id=$1", [r.id]);
                await db.query("UPDATE queue_dispatch_candidates SET state='CLAIMED',incarnation_id=$2,first_claimed_at=now(),claim_key=$3 WHERE id=$1", [c.id, i.id, claimKey]);
                c.incarnation_id = i.id;
                c.state = 'CLAIMED';
                if (c.job_id)
                    await db.query("UPDATE claude_jobs SET status='CLAIMED',claimed_at=now(),worker_instance_id=$2,updated_at=now() WHERE id=$1", [c.job_id, i.runtime_scope.worker_instance_id]);
                const a = (await db.query<Attempt>("INSERT INTO queue_dispatch_attempts(id,candidate_id,incarnation_id,credential_hash,credential_key_version,claim_key,state,heartbeat_at) VALUES($1,$2,$3,$4,$5,$6,'CLAIMED',now()) RETURNING *", [id, c.id, i.id, credentialHash(secret), deps.keyVersion, claimKey])).rows[0];
                await event(db, r, 'claimed', { candidate_id: c.id, attempt_id: id, incarnation_id: i.id, slot_id: i.slot_id });
                if(r.retry_authorization_event_id){await event(db,r,'retry_consumed',{authorization_event_id:r.retry_authorization_event_id,attempt_id:a.id});await db.query('UPDATE queue_dispatch_requests SET retry_authorization_event_id=NULL WHERE id=$1',[r.id]);}
                await state(db, r, 'CLAIMED');
                return receipt(db, actor, { r, c, a, i });
            }
            return null;
        });
    }
    function validScope(scope: RuntimeScope, x: Locked) {
        if (!scope || typeof scope.scopeId !== 'string' || !scope.scopeId || scope.scopeId.length > 256 || scope.bootId !== x.i.boot_id || scope.imageDigest !== x.i.runtime_scope.image_digest || scope.profileSha256 !== x.i.runtime_scope.profile_sha256)
            return forbidden();
        if (x.a.scope_id && x.a.scope_id !== scope.scopeId)
            return conflict();
    }
    async function verifyRecordedScope(db: PoolClient, x: Locked, scope: RuntimeScope) {
        const recorded = (await db.query<{
            payload: {
                scope: RuntimeScope;
            };
        }>("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='started_scope' AND payload->>'attempt_id'=$2", [x.r.id, x.a.id])).rows;
        if (recorded.length !== 1)
            return conflict();
        const original = recorded[0].payload.scope;
        if (!original || original.scopeId !== scope.scopeId || original.bootId !== scope.bootId || original.imageDigest !== scope.imageDigest || original.profileSha256 !== scope.profileSha256)
            return conflict();
    }
    async function startDispatchAttempt(actor: DispatchActor, proof: AttemptProof, scope: RuntimeScope): Promise<DispatchStartPermit> {
        return withDispatchRetryTransaction(deps.store, async (db) => {
            const x = await lock(db, proof.request_id, proof.candidate_id, proof.attempt_id);
            verifyProof(actor, proof, x);
            validScope(scope, x);
            if (!deps.enabled || !deps.productAllowlist.includes(x.r.product_id) || !active(x) || !['CLAIMED', 'RUNNING'].includes(x.r.state) || !['CLAIMED', 'RUNNING'].includes(x.a.state))
                return conflict();
            const time = await now(db);
            if (!x.a.heartbeat_at || time.getTime() - x.a.heartbeat_at.getTime() >= 120000)
                return conflict();
            const profile = await authorize(db, actor, x, 'start');
            if (x.a.started_at && time.getTime() - x.a.started_at.getTime() >= profile.max_duration_seconds * 1000)
                return conflict();
            if (x.a.state === 'RUNNING')
                await verifyRecordedScope(db, x, scope);
            if (x.a.state === 'CLAIMED') {
                await db.query("UPDATE queue_dispatch_attempts SET state='RUNNING',scope_id=$2,started_at=now(),heartbeat_at=now() WHERE id=$1", [x.a.id, scope.scopeId]);
                await db.query("UPDATE queue_dispatch_candidates SET state='RUNNING' WHERE id=$1", [x.c.id]);
                if (x.c.job_id)
                    await db.query("UPDATE claude_jobs SET status='RUNNING',started_at=now(),updated_at=now() WHERE id=$1", [x.c.job_id]);
                await event(db, x.r, 'started_scope', { attempt_id: x.a.id, scope });
                await state(db, x.r, 'RUNNING');
            }
            return signPermit({ requestId: x.r.id, candidateId: x.c.id, generation: x.c.generation, attemptId: x.a.id, incarnationId: x.a.incarnation_id, scope }, time.getTime());
        });
    }
    async function uncertain(db: PoolClient, x: Locked) {
        await db.query("UPDATE queue_dispatch_attempts SET state='UNCERTAIN' WHERE id=$1", [x.a.id]);
        await db.query("UPDATE queue_dispatch_candidates SET state='UNCERTAIN' WHERE id=$1", [x.c.id]);
        await event(db, x.r, 'lease_expired', { attempt_id: x.a.id });
        await state(db, x.r, 'UNCERTAIN');
        x.a.state = 'UNCERTAIN';
    }
    async function cancelForStop(db: PoolClient, x: Locked, reason: string) {
        await db.query("UPDATE queue_dispatch_attempts SET state='CANCEL_REQUESTED',revoked_at=COALESCE(revoked_at,now()) WHERE id=$1", [x.a.id]);
        await db.query("UPDATE queue_dispatch_candidates SET state='CANCEL_REQUESTED' WHERE id=$1", [x.c.id]);
        await event(db, x.r, 'stop_required', { attempt_id: x.a.id, reason });
        await state(db, x.r, 'CANCEL_REQUESTED');
    }
    async function renewDispatchAttempt(actor: DispatchActor, proof: AttemptProof, scopeId: string): Promise<{
        stopRequired: boolean;
    }> {
        return withDispatchRetryTransaction(deps.store, async (db) => {
            const x = await lock(db, proof.request_id, proof.candidate_id, proof.attempt_id);
            verifyProof(actor, proof, x);
            if (!active(x) || !['CLAIMED', 'RUNNING', 'UNCERTAIN'].includes(x.r.state) || !['CLAIMED', 'RUNNING', 'UNCERTAIN'].includes(x.a.state))
                return { stopRequired: true };
            if (x.a.scope_id !== scopeId)
                return forbidden();
            const time = await now(db);
            if (x.a.state !== 'UNCERTAIN' && (!x.a.heartbeat_at || time.getTime() - x.a.heartbeat_at.getTime() >= 120000))
                await uncertain(db, x);
            let profile: DispatchProfileConfig;
            try {
                profile = await authorize(db, actor, x, 'start');
            }
            catch (error) {
                if (!(error instanceof DispatchError))
                    throw error;
                await cancelForStop(db, x, 'authorization_unavailable');
                return { stopRequired: true };
            }
            if (x.a.started_at && time.getTime() - x.a.started_at.getTime() >= profile.max_duration_seconds * 1000) {
                await cancelForStop(db, x, 'maximum_duration');
                return { stopRequired: true };
            }
            await db.query('UPDATE queue_dispatch_attempts SET heartbeat_at=now() WHERE id=$1', [x.a.id]);
            return { stopRequired: x.a.state === 'UNCERTAIN' };
        });
    }
    async function reconcileDispatchAttempt(actor: DispatchActor, proof: AttemptProof, scope: RuntimeScope): Promise<void> {
        await withDispatchRetryTransaction(deps.store, async (db) => {
            const x = await lock(db, proof.request_id, proof.candidate_id, proof.attempt_id);
            verifyProof(actor, proof, x);
            validScope(scope, x);
            if (!deps.enabled || !deps.productAllowlist.includes(x.r.product_id) || !active(x) || x.r.state !== 'UNCERTAIN' || x.a.state !== 'UNCERTAIN' || !x.a.started_at || !x.a.scope_id)
                return conflict();
            const profile = await authorize(db, actor, x, 'start');
            if ((await now(db)).getTime() - x.a.started_at.getTime() >= profile.max_duration_seconds * 1000)
                return conflict();
            await verifyRecordedScope(db, x, scope);
            decideDispatchTransition(x.r.state, 'resume_same_attempt');
            await db.query("UPDATE queue_dispatch_attempts SET state='RUNNING',heartbeat_at=now() WHERE id=$1", [x.a.id]);
            await db.query("UPDATE queue_dispatch_candidates SET state='RUNNING' WHERE id=$1", [x.c.id]);
            await event(db, x.r, 'resume_same_attempt', { attempt_id: x.a.id, scope_id: x.a.scope_id });
            await state(db, x.r, 'RUNNING');
        });
    }
    async function markExpiredAttempts(limit = 25): Promise<number> {
        const rows = (await deps.store.query<{
            request_id: string;
            candidate_id: string;
            id: string;
        }>(`SELECT a.id,a.candidate_id,c.request_id FROM queue_dispatch_attempts a JOIN queue_dispatch_candidates c ON c.id=a.candidate_id JOIN queue_dispatch_profiles p ON p.id=c.profile_revision_id WHERE (a.state IN ('CLAIMED','RUNNING') AND a.heartbeat_at<=now()-interval '120 seconds') OR (a.state IN ('CLAIMED','RUNNING','UNCERTAIN') AND a.started_at+make_interval(secs=>(p.config->>'max_duration_seconds')::int)<=now()) ORDER BY a.heartbeat_at,a.id LIMIT $1`, [Math.min(25, Math.max(0, limit))])).rows;
        let count = 0;
        for (const row of rows)
            if (await withDispatchRetryTransaction(deps.store, async (db) => {
                const x = await lock(db, row.request_id, row.candidate_id, row.id);
                if (x.r.generation !== x.c.generation || !['CLAIMED', 'RUNNING', 'UNCERTAIN'].includes(x.r.state) || !['CLAIMED', 'RUNNING', 'UNCERTAIN'].includes(x.a.state))
                    return false;
                const time = await now(db), profile = (await db.query<{
                    config: DispatchProfileConfig;
                }>('SELECT config FROM queue_dispatch_profiles WHERE id=$1', [x.c.profile_revision_id])).rows[0].config;
                if (x.a.started_at && time.getTime() - x.a.started_at.getTime() >= profile.max_duration_seconds * 1000) {
                    await cancelForStop(db, x, 'maximum_duration');
                    return false;
                }
                if (x.a.state === 'UNCERTAIN' || !x.a.heartbeat_at || time.getTime() - x.a.heartbeat_at.getTime() < 120000)
                    return false;
                await uncertain(db, x);
                return true;
            }))
                count++;
        return count;
    }
    return { claimDispatchAttempt, startDispatchAttempt, renewDispatchAttempt, reconcileDispatchAttempt, markExpiredAttempts };
}
export type DispatchAttempts = ReturnType<typeof createDispatchAttempts>;
