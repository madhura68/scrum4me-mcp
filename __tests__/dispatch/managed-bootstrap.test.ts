import {it,expect,describe} from 'vitest'
import {parseManagedWorkerBootstrap,classifyBootstrapBinding,bootstrapClaimProducts} from '../../src/dispatch/managed-worker-bootstrap.js'
const config={owner_user_id:'owner',token_id:'token',instance_id:'managed:stable',product_id:'product',runtime:'CODEX',capabilities:['review'],tier:'LOW_P'}
it('requires concrete operator binding without implied authority',()=>{
 expect(parseManagedWorkerBootstrap(config)).toEqual(config)
 for(const delta of [{instance_id:'ordinary'},{instance_id:'managed:'},{product_id:''},{runtime:'SHELL'},{capabilities:['deploy']},{tier:'INFINITE'},{activate:true},{owner_user_id:''},{rebind:'yes'}]) expect(()=>parseManagedWorkerBootstrap({...config,...delta})).toThrow()
})
it('accepts an explicit all-products binding and an explicit rebind flag (ISS-11)',()=>{
 expect(parseManagedWorkerBootstrap({...config,product_id:null})).toEqual({...config,product_id:null})
 expect(parseManagedWorkerBootstrap({...config,rebind:true})).toEqual({...config,rebind:true})
})

describe('classifyBootstrapBinding',()=>{
 const row={user_id:'owner',token_id:'token',product_id:'product',runtime:'CODEX',capabilities:['review'],capability:'LOW_P'}
 const input=parseManagedWorkerBootstrap(config)
 it('creates a missing worker and refreshes an exact one',()=>{
  expect(classifyBootstrapBinding([],input)).toBe('create')
  expect(classifyBootstrapBinding([row],input)).toBe('refresh')
  expect(classifyBootstrapBinding([{...row,product_id:null}],{...input,product_id:null})).toBe('refresh')
 })
 it('refuses a different token or product without rebind',()=>{
  expect(classifyBootstrapBinding([{...row,token_id:'old'}],input)).toBe('conflict')
  expect(classifyBootstrapBinding([row],{...input,product_id:null})).toBe('conflict')
 })
 it('rebinds only token and product when explicitly requested',()=>{
  expect(classifyBootstrapBinding([{...row,token_id:'old'}],{...input,rebind:true})).toBe('rebind')
  expect(classifyBootstrapBinding([row],{...input,product_id:null,rebind:true})).toBe('rebind')
  expect(classifyBootstrapBinding([row],{...input,rebind:true})).toBe('refresh')
 })
 it('never rebinds another owner, runtime, tier, capabilities or an ambiguous row set',()=>{
  for(const delta of [{user_id:'other'},{runtime:'CLAUDE'},{capability:'HIGH_P'},{capabilities:['review','code_edit']}])
   expect(classifyBootstrapBinding([{...row,token_id:'old',...delta}],{...input,rebind:true})).toBe('conflict')
  expect(classifyBootstrapBinding([row,row],{...input,rebind:true})).toBe('conflict')
 })
})

describe('bootstrapClaimProducts',()=>{
 it('authorizes the one concrete product',()=>{
  expect(bootstrapClaimProducts('product',[])).toEqual(['product'])
  expect(bootstrapClaimProducts('product',['a','product'])).toEqual(['product'])
 })
 it('authorizes every scoped product for an all-products binding',()=>{
  expect(bootstrapClaimProducts(null,['a','b'])).toEqual(['a','b'])
 })
 it('leaves an unscoped all-products binding to slot registration and claim',()=>{
  expect(bootstrapClaimProducts(null,[])).toEqual([])
 })
})
