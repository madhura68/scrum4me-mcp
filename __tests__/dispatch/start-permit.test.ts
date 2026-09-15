import { describe,expect,it } from 'vitest'
import { createPrivateKey,createPublicKey,generateKeyPairSync,sign } from 'node:crypto'
import fixture from '../../vendor/scrum4me-shared/__tests__/fixtures/dispatch-start-permit-v1.json' with { type: 'json' }
import { createStartPermitSigner,verifyStartPermit } from '../../src/dispatch/credentials.js'
const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,23)]),format:'der',type:'pkcs8'})
const publicKey=createPublicKey(fixture.publicKeyPem),now=Date.parse(fixture.claims.issuedAt)
const binding=fixture.claims
function signed(value:unknown){const bytes=Buffer.from(JSON.stringify(value));return {permitId:bytes.toString('base64url')+'.'+sign(null,bytes,privateKey).toString('base64url'),expiresAt:fixture.claims.expiresAt}}
describe('Ed25519 broker start authorization',()=>{
 it('matches the portable deterministic fixture using a dedicated key',()=>{
  expect(createStartPermitSigner(privateKey)(binding,now)).toEqual(fixture.permit)
  expect(verifyStartPermit(fixture.permit,publicKey,binding,now)).toEqual(fixture.claims)
 })
 it('rejects tampering, alternate keys, noncanonical encodings and outer expiry substitution',()=>{
  for(const permit of [{...fixture.permit,permitId:fixture.permit.permitId+'a'},{...fixture.permit,expiresAt:'2026-09-15T12:00:06.000Z'},signed({...fixture.claims,scope:{...fixture.claims.scope,scopeId:'other'}}),signed({...fixture.claims,purpose:'attempt'}),signed({...fixture.claims,extra:1})])expect(()=>verifyStartPermit(permit,publicKey,binding,now)).toThrow('DISPATCH_START_PERMIT_REFUSED')
  expect(()=>verifyStartPermit(fixture.permit,generateKeyPairSync('ed25519').publicKey,binding,now)).toThrow()
  expect(()=>verifyStartPermit(fixture.permit,publicKey,binding,now-1)).toThrow()
  expect(()=>verifyStartPermit(fixture.permit,publicKey,binding,now+5000)).toThrow()
 })
 it('does not accept symmetric or signing keys as pinned public verification keys',()=>{
  expect(()=>createStartPermitSigner(publicKey)).toThrow()
  expect(()=>verifyStartPermit(fixture.permit,privateKey,binding,now)).toThrow()
 })
})
