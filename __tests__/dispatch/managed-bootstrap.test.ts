import {it,expect} from 'vitest'
import {parseManagedWorkerBootstrap} from '../../src/dispatch/managed-worker-bootstrap.js'
const config={owner_user_id:'owner',token_id:'token',instance_id:'managed:stable',product_id:'product',runtime:'CODEX',capabilities:['review'],tier:'LOW_P'}
it('requires concrete operator binding without implied authority',()=>{
 expect(parseManagedWorkerBootstrap(config)).toEqual(config)
 for(const delta of [{instance_id:'ordinary'},{instance_id:'managed:'},{product_id:null},{runtime:'SHELL'},{capabilities:['deploy']},{tier:'INFINITE'},{activate:true},{owner_user_id:''}]) expect(()=>parseManagedWorkerBootstrap({...config,...delta})).toThrow()
})
