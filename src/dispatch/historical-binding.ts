import type {ArtifactAttempt} from './artifacts.js'
import {dispatchStartPermitClaimsSchema,type DispatchStartBinding} from '@shared/queue-dispatch-start-permit.js'
import {canonicalResult} from './lifecycle.js'
import {DispatchError} from './errors.js'
const bindingSchema=dispatchStartPermitClaimsSchema.omit({version:true,purpose:true,issuedAt:true,expiresAt:true})
const conflict=():never=>{throw new DispatchError('DISPATCH_STATE_CONFLICT')}
export async function validateHistoricalBinding(db:import('pg').PoolClient,x:ArtifactAttempt,b:DispatchStartBinding){
 bindingSchema.parse(b)
 if(b.requestId!==x.r.id||b.candidateId!==x.c.id||b.generation!==x.c.generation||b.attemptId!==x.a.id||b.incarnationId!==x.i.id||b.scope.bootId!==x.i.boot_id||b.scope.imageDigest!==x.scope.image_digest||b.scope.profileSha256!==x.scope.profile_sha256)return conflict()
 const started=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='started_scope' AND payload->>'attempt_id'=$2",[x.r.id,x.a.id])).rows
 if(x.a.scope_id!==null&&(x.a.scope_id!==b.scope.scopeId||started.length!==1||canonicalResult(started[0].payload.scope)!==canonicalResult(b.scope)))return conflict()
 if(x.a.scope_id===null&&(x.a.started_at||started.length))return conflict()
 const accepted=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND attempt_id=$2 AND type='stop_accepted'",[x.r.id,x.a.id])).rows
 if(accepted.length&&(accepted.length!==1||canonicalResult(accepted[0].payload.binding)!==canonicalResult(b)))return conflict()
}
