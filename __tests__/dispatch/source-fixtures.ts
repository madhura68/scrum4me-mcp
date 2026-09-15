import {createDispatchSelection} from '../../src/dispatch/selection.js'
/** IP05-07 select/claim fixtures explicitly supply source readiness. They do not
 * claim source producer evidence; sources.integration uses the actual service. */
export function createReadyFixtureSelection(deps:Parameters<typeof createDispatchSelection>[0]){
 const selection=createDispatchSelection(deps)
 const ready=()=>deps.store.query("UPDATE queue_dispatch_requests SET sources_ready_at=COALESCE(sources_ready_at,now()) WHERE state='WAITING' AND product_id=ANY($1::text[])",[deps.productAllowlist])
 return {...selection,reserveRequest:async(id:string)=>{await ready();return selection.reserveRequest(id)},reserveNextRequest:async()=>{await ready();return selection.reserveNextRequest()}}
}
