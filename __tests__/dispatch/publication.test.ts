import {createServer} from 'node:http'
import {it,expect,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {isolatedGit,createCodeArtifact,verifyCodeArtifact} from '../../src/dispatch/workspace.js'
import {createGitPublicationPort} from '../../src/dispatch/publication.js'
const cleanupFault=vi.hoisted(()=>({enabled:false,paths:new Set<string>()}))
vi.mock('node:fs/promises',async importOriginal=>{
 const fs=await importOriginal<typeof import('node:fs/promises')>()
 return {...fs,rm:async(...args:Parameters<typeof fs.rm>)=>{
  if(cleanupFault.enabled&&/(?:dispatch-publisher-|[\\/]publication-)/.test(String(args[0]))){cleanupFault.paths.add(String(args[0]));throw Object.assign(new Error('sensitive cleanup details'),{code:'ENOTEMPTY'})}
  return fs.rm(...args)
 }}
})
// These fixtures execute dozens of real Git processes plus local HTTP. Under the
// full parallel suite they exceed Vitest's 5s unit-test default; keep a finite 30s budget.
const publicationTimeout=30_000
it.each([false,true])('publishes verified code into an absent request branch and reconciles without overwriting a foreign remote head (cleanup failure: %s)',async cleanupFails=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{})
 const root=await mkdtemp(join(tmpdir(),'ip09-publish-'))
 try{
  const remote=join(root,'remote.git'),repo=join(root,'repo');await mkdir(repo);await isolatedGit(root,['init','--bare',remote]);await isolatedGit(remote,['config','receive.autogc','false']);await isolatedGit(repo,['init','-b','main']);await isolatedGit(repo,['config','user.email','fixture@example.invalid']);await isolatedGit(repo,['config','user.name','Fixture'])
  await writeFile(join(repo,'file.txt'),'base\n');await isolatedGit(repo,['add','.']);await isolatedGit(repo,['commit','-m','base']);const baseSha=await isolatedGit(repo,['rev-parse','HEAD']);await isolatedGit(repo,['remote','add','origin',remote]);await isolatedGit(repo,['push','origin','main'],'file');await isolatedGit(repo,['bundle','create',join(root,'base.bundle'),'HEAD'])
  const requestId=randomUUID(),branch=`codex/queue-${requestId}`;await isolatedGit(repo,['checkout','-b',branch]);await writeFile(join(repo,'file.txt'),'head\n');await isolatedGit(repo,['commit','-am','head']);const headSha=await isolatedGit(repo,['rev-parse','HEAD']),checks:import('@shared/queue-dispatch.js').DispatchResult['checks']=[]
  const bytes=await createCodeArtifact(repo,{repoUrl:remote,baseSha,headSha,branch,checks}),base=await import('node:fs/promises').then(fs=>fs.readFile(join(root,'base.bundle')))
  const port=createGitPublicationPort({root:join(root,'publisher'),allowedProtocols:['file'],allowedHosts:[]}),intent={operationId:randomUUID(),requestId,attemptId:randomUUID(),repoUrl:remote,baseBranch:'main',baseSha,headSha,branch,mode:'branch' as const,expectedRemoteHead:null,codeBytes:bytes,baseBytes:base,checks}
  cleanupFault.enabled=cleanupFails
  await expect(verifyCodeArtifact(bytes,base,intent)).resolves.toEqual({files:['file.txt']})
  const tampered=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(bytes).toString()),diff:'wrong diff'}))
  await expect(verifyCodeArtifact(tampered,base,intent)).rejects.toThrow('DISPATCH_INVALID_INPUT')
  expect((await port.publish(intent)).status).toBe('confirmed');expect((await port.reconcile(intent)).status).toBe('confirmed')
  await writeFile(join(repo,'file.txt'),'foreign\n');await isolatedGit(repo,['commit','-am','foreign']);await isolatedGit(repo,['push','origin',branch],'file');expect((await port.reconcile(intent)).status).toBe('unknown')
  expect((await port.publish(intent)).status).toBe('failed')
  if(cleanupFails){
   expect(warn).toHaveBeenCalledWith(expect.stringContaining('verification temporary directory cleanup failed (ENOTEMPTY)'))
   expect(warn).toHaveBeenCalledWith(expect.stringContaining('publication temporary directory cleanup failed (ENOTEMPTY)'))
   expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive cleanup details')
  }
 }finally{cleanupFault.enabled=false;warn.mockRestore();for(const path of cleanupFault.paths)await rm(path,{recursive:true,force:true,maxRetries:3});cleanupFault.paths.clear();await rm(root,{recursive:true,force:true,maxRetries:3})}
},publicationTimeout)
it('requires explicit protocol/host authority before any remote publication',async()=>{
 const port=createGitPublicationPort({root:join(tmpdir(),'never-created-ip09'),allowedProtocols:['https'],allowedHosts:['git.example.invalid']})
 await expect(port.publish({operationId:randomUUID(),requestId:'x',attemptId:randomUUID(),repoUrl:'https://attacker.invalid/repo.git',baseBranch:'main',baseSha:'a'.repeat(40),headSha:'b'.repeat(40),branch:'codex/queue-x',mode:'branch',expectedRemoteHead:null,codeBytes:new Uint8Array(),baseBytes:new Uint8Array(),checks:[]})).rejects.toThrow('DISPATCH_FORBIDDEN')
})
it('reconciles an actual lost HTTP create response to one draft PR marker without creating twice',async()=>{
 const pulls:Array<unknown>=[];let posts=0,sha='';const server=createServer((req,res)=>{if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(pulls));return}posts++;let bytes='';req.on('data',chunk=>{bytes+=chunk});req.on('end',()=>{const body=JSON.parse(bytes);pulls.push({head:{ref:body.head,sha},base:{ref:body.base},body:body.body,html_url:'https://fixture.invalid/pulls/1'});res.destroy()})});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as import('node:net').AddressInfo
 const root=await mkdtemp(join(tmpdir(),'ip09-publish-')),remote=`/tmp/ip09-remote-${randomUUID()}`
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{})
 try{
  const repo=join(root,'repo');await mkdir(repo);await isolatedGit(root,['init','--bare',remote]);await isolatedGit(remote,['config','receive.autogc','false']);await isolatedGit(repo,['init','-b','main']);await isolatedGit(repo,['config','user.email','fixture@example.invalid']);await isolatedGit(repo,['config','user.name','Fixture'])
  await writeFile(join(repo,'file.txt'),'base\n');await isolatedGit(repo,['add','.']);await isolatedGit(repo,['commit','-m','base']);const baseSha=await isolatedGit(repo,['rev-parse','HEAD']);await isolatedGit(repo,['remote','add','origin',remote]);await isolatedGit(repo,['push','origin','main'],'file');await isolatedGit(repo,['bundle','create',join(root,'base.bundle'),'HEAD'])
  const requestId=randomUUID(),branch=`codex/queue-${requestId}`;await isolatedGit(repo,['checkout','-b',branch]);await writeFile(join(repo,'file.txt'),'head\n');await isolatedGit(repo,['commit','-am','head']);const headSha=await isolatedGit(repo,['rev-parse','HEAD']),checks:import('@shared/queue-dispatch.js').DispatchResult['checks']=[]
  const bytes=await createCodeArtifact(repo,{repoUrl:remote,baseSha,headSha,branch,checks}),base=await import('node:fs/promises').then(fs=>fs.readFile(join(root,'base.bundle')))
  sha=headSha;const port=createGitPublicationPort({root:join(root,'publisher'),allowedProtocols:['file'],allowedHosts:[],forgejo:{apiOrigin:`http://127.0.0.1:${address.port}/api/v1`,token:'fixture-token'}}),intent={operationId:randomUUID(),requestId,attemptId:randomUUID(),repoUrl:remote,baseBranch:'main',baseSha,headSha,branch,mode:'pull_request' as const,expectedRemoteHead:null,codeBytes:bytes,baseBytes:base,checks}
  cleanupFault.enabled=true
  expect((await port.publish(intent)).status).toBe('unknown');expect(posts).toBe(1);expect((await port.reconcile(intent)).prUrl).toBe('https://fixture.invalid/pulls/1');expect((await port.publish(intent)).status).toBe('confirmed');expect(posts).toBe(1)
 }finally{
  cleanupFault.enabled=false;warn.mockRestore()
  try{for(const path of cleanupFault.paths)await rm(path,{recursive:true,force:true,maxRetries:3});cleanupFault.paths.clear();await rm(remote,{recursive:true,force:true,maxRetries:3});await rm(root,{recursive:true,force:true,maxRetries:3})}
  finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
 }
},publicationTimeout)
it('reports an unverifiable artifact as a receipt instead of throwing out of the publisher',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ip09-unverifiable-'))
 try{
  const requestId=randomUUID(),port=createGitPublicationPort({root:join(root,'publisher'),allowedProtocols:['file'],allowedHosts:[]})
  const intent={operationId:randomUUID(),requestId,attemptId:randomUUID(),repoUrl:join(root,'remote.git'),baseBranch:'main',baseSha:'a'.repeat(40),headSha:'b'.repeat(40),branch:`codex/queue-${requestId}`,mode:'branch' as const,expectedRemoteHead:null,codeBytes:Buffer.from('not a code artifact'),baseBytes:new Uint8Array(),checks:[]}
  // Nothing was sent, so a publish is a definite failure; a reconcile cannot tell and stays unknown.
  expect((await port.publish(intent)).status).toBe('failed');expect((await port.reconcile(intent)).status).toBe('unknown')
 }finally{await rm(root,{recursive:true,force:true,maxRetries:3})}
})
