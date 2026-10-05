import type {DispatchResult} from '@shared/queue-dispatch.js'
import {withDispatchRetryTransaction,type DispatchStore} from './db.js'
import {lockArtifactAttempt,artifactHash} from './artifacts.js'
import {acceptSignedOffUnstartedStopInTransaction,SIGNED_OFF_UNSTARTED_REASON} from './stop-evidence.js'
import {canonicalResult,finishStoppedCancellation} from './lifecycle.js'
import {finishResult} from './completion.js'

/** ISS-12: close attempts whose supervisor was replaced before start. The candidate query is a hint;
 * `acceptSignedOffUnstartedStopInTransaction` rechecks the full signature under the lifecycle locks. */
export async function closeSignedOffUnstartedAttempts(store:DispatchStore,limit=25):Promise<number>{
 const rows=(await store.query<{id:string}>(`SELECT a.id FROM queue_dispatch_attempts a JOIN queue_dispatch_incarnations i ON i.id=a.incarnation_id
  WHERE i.signed_off_at IS NOT NULL AND a.scope_id IS NULL AND a.started_at IS NULL AND a.stopped_at IS NULL AND a.state IN ('CLAIMED','UNCERTAIN','CANCEL_REQUESTED')
  ORDER BY i.signed_off_at,a.id LIMIT $1`,[Math.min(25,Math.max(0,limit))])).rows
 let count=0
 for(const row of rows)
  if(await withDispatchRetryTransaction(store,async db=>{
   const x=await lockArtifactAttempt(db,row.id)
   if(!await acceptSignedOffUnstartedStopInTransaction(db,x))return false
   if(x.r.state==='CANCEL_REQUESTED'){await finishStoppedCancellation(db,x);return true}
   const result:DispatchResult={version:1,outcome:'failed',summary:SIGNED_OFF_UNSTARTED_REASON,
    report_markdown:'The supervisor holding this claim was replaced before the attempt started. No start permit was ever issued, so nothing ran.',checks:[]}
   await finishResult(db,x,result,artifactHash(canonicalResult(result)))
   return true
  }))count++
 return count
}
