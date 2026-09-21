import { describe,expect,it } from 'vitest'
import { createPrivateKey,createPublicKey,generateKeyPairSync,sign } from 'node:crypto'
import fixture from '../../vendor/scrum4me-shared/__tests__/fixtures/dispatch-start-permit-v2.json' with { type: 'json' }
import v1 from '../../vendor/scrum4me-shared/__tests__/fixtures/dispatch-start-permit-v1.json' with { type: 'json' }
import { createStartPermitSigner,verifyStartPermit } from '../../src/dispatch/credentials.js'
const kid=fixture.kid
const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,23)]),format:'der',type:'pkcs8'})
const publicKey=createPublicKey(fixture.publicKeyPem),now=Date.parse(fixture.claims.issuedAt)
const binding=fixture.claims
// The identity binding alone (no version/purpose/kid/timestamps): what the signer callback takes.
const signBinding={requestId:binding.requestId,candidateId:binding.candidateId,generation:binding.generation,attemptId:binding.attemptId,incarnationId:binding.incarnationId,scope:binding.scope}
// The verifier's trusted keyset; a rotation would add a second entry before flipping the signer.
const keyset=[{kid:'retired-key',publicKey:generateKeyPairSync('ed25519').publicKey},{kid,publicKey}]
function signed(value:unknown){const bytes=Buffer.from(JSON.stringify(value));return {permitId:bytes.toString('base64url')+'.'+sign(null,bytes,privateKey).toString('base64url'),expiresAt:fixture.claims.expiresAt}}
describe('Ed25519 broker start authorization (v2 key id)',()=>{
 it('matches the portable deterministic v2 fixture and verifies against the keyed set',()=>{
  expect(createStartPermitSigner(privateKey,kid)(signBinding,now)).toEqual(fixture.permit)
  expect(verifyStartPermit(fixture.permit,keyset,binding,now)).toEqual(fixture.claims)
 })
 it('refuses a permit whose kid is not in the verifier keyset (rotation safety)',()=>{
  // Same signer key, valid signature, but the verifier has not been given this kid: refused.
  const orphan=createStartPermitSigner(privateKey,'orphan-key')(signBinding,now)
  expect(()=>verifyStartPermit(orphan,keyset,binding,now)).toThrow('DISPATCH_START_PERMIT_REFUSED')
  // The v1 (no-kid) permit format is refused outright.
  expect(()=>verifyStartPermit(v1.permit,keyset,v1.claims,Date.parse(v1.claims.issuedAt))).toThrow('DISPATCH_START_PERMIT_REFUSED')
 })
 it('rejects tampering, alternate keys, noncanonical encodings and outer expiry substitution',()=>{
  for(const permit of [{...fixture.permit,permitId:fixture.permit.permitId+'a'},{...fixture.permit,expiresAt:'2026-09-15T12:00:06.000Z'},signed({...fixture.claims,scope:{...fixture.claims.scope,scopeId:'other'}}),signed({...fixture.claims,purpose:'attempt'}),signed({...fixture.claims,extra:1})])expect(()=>verifyStartPermit(permit,keyset,binding,now)).toThrow('DISPATCH_START_PERMIT_REFUSED')
  // Right kid, wrong key material for it: the signature does not verify.
  expect(()=>verifyStartPermit(fixture.permit,[{kid,publicKey:generateKeyPairSync('ed25519').publicKey}],binding,now)).toThrow()
  // m10: a permit read as issued in the future is tolerated within START_PERMIT_CLOCK_SKEW_MS (5000ms);
  // beyond that bounded skew (5001ms lead) it is still refused. Mirrors scrum4me-shared's own boundary.
  expect(()=>verifyStartPermit(fixture.permit,keyset,binding,now-5001)).toThrow()
  expect(()=>verifyStartPermit(fixture.permit,keyset,binding,now+5000)).toThrow()
 })
 it('does not accept symmetric or signing keys as pinned public verification keys, nor a bad kid',()=>{
  expect(()=>createStartPermitSigner(publicKey,kid)).toThrow()
  expect(()=>createStartPermitSigner(privateKey,'has:colon')).toThrow()
  expect(()=>verifyStartPermit(fixture.permit,[{kid,publicKey:privateKey}],binding,now)).toThrow()
 })
})
