import {cleanupDispatchDirectory} from './cleanup.js'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir,mkdtemp,readFile,writeFile,realpath,lstat,readdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {DispatchInput,DispatchResult} from '@shared/queue-dispatch.js'
import {ARTIFACT_MAX_BYTES} from '@shared/queue-dispatch-sources.js'
import {DispatchError} from './errors.js'
import {DispatchSourceError} from './sources.js'
const run=promisify(execFile),oid=/^[a-f0-9]{40}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const invalid=():never=>{throw new DispatchError('DISPATCH_INVALID_INPUT')}
/** Explicit minimal environment drops global/system Git config, SSH, askpass,
 * credentials, alternates and process Git variables. Only preparation may fetch.
 * Temporary repositories must not outlive an awaited command via auto-maintenance. */
export async function isolatedGitRaw(cwd:string,args:string[],protocols='',httpAuth?:{repoUrl:string;header:string}):Promise<Buffer>{
 try{const {stdout}=await run('git',['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','protocol.allow=never','-c','core.fsmonitor=false','-c','maintenance.auto=false','-c','gc.auto=0','-c','gc.autoDetach=false','-c','http.followRedirects=false',...args],{cwd,encoding:'buffer',maxBuffer:ARTIFACT_MAX_BYTES,timeout:60000,env:{PATH:process.env.PATH,HOME:cwd,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:protocols,...(httpAuth?{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`http.${httpAuth.repoUrl}.extraHeader`,GIT_CONFIG_VALUE_0:httpAuth.header}:{})}});return stdout}
 catch(error){
  const detail=String((error as {stderr?:string}).stderr??'')
  if(/not our ref|couldn't find remote ref|unadvertised object|reference is not a tree/i.test(detail))throw new DispatchSourceError('missing')
  if(/authentication failed|could not read username|access denied|403|401/i.test(detail))throw new DispatchSourceError('forbidden')
  throw new DispatchSourceError('network')
 }
}
/** R26: textual Git data is exact UTF-8, never replacement-decoded. Binary
 * patches emitted by git --binary are ASCII and retain their original bytes. */
function exactGitText(bytes:Uint8Array):string{
 try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{throw new DispatchError('DISPATCH_UNSUPPORTED_ENCODING')}
}
/** Only remove the single LF terminator emitted by scalar Git commands. */
export async function isolatedGit(cwd:string,args:string[],protocols='',httpAuth?:{repoUrl:string;header:string}):Promise<string>{
 const text=exactGitText(await isolatedGitRaw(cwd,args,protocols,httpAuth));return text.endsWith('\n')?text.slice(0,-1):text
}
export async function importBaseBundle(path:string,bundlePath:string,baseSha:string,repoUrl:string,branch:string){
 if(!oid.test(baseSha)||!/^codex\/queue-[a-f0-9-]{36}$/.test(branch))return invalid()
 await isolatedGit(path,['init','--template='])
 await isolatedGit(path,['config','core.hooksPath','/dev/null'])
 await isolatedGit(path,['config','protocol.allow','never'])
 // The authenticated exact base is the intentional shallow boundary. Parent
 // history is not transported or required to create/verify descendants.
 await writeFile(join(path,'.git','shallow'),baseSha+'\n',{flag:'wx',mode:0o600})
 await isolatedGit(path,['fetch','--no-tags','--no-recurse-submodules',bundlePath,'HEAD'],'file')
 if(await isolatedGit(path,['rev-parse','FETCH_HEAD'])!==baseSha)return invalid()
 await isolatedGit(path,['remote','add','origin',repoUrl])
 await isolatedGit(path,['checkout','--no-recurse-submodules','-b',branch,baseSha])
 if(await isolatedGit(path,['rev-parse','HEAD'])!==baseSha||await isolatedGit(path,['remote','get-url','origin'])!==repoUrl)return invalid()
}
export function createDispatchWorkspace(deps:{root:string;loadRepository:(productId:string)=>Promise<string|null>;allowedProtocols?:readonly string[];allowedHosts?:readonly string[];gitAuthHeader?:(repoUrl:string)=>Promise<string|null>}){
 async function prepareDispatchWorkspace(input:DispatchInput&{requestId:string;snapshot?:Record<string,unknown>},attemptId:string):Promise<{path:string;branch:string;baseSha:string}>{
  const repository=input.requirements.repository
  if(!uuid.test(attemptId)||!uuid.test(input.requestId)||!repository||!oid.test(repository.base_sha))return invalid()
  const repoUrl=await deps.loadRepository(repository.product_id);if(!repoUrl)return invalid()
  let url:URL;try{url=new URL(repoUrl)}catch{return invalid()}
  const protocols=deps.allowedProtocols??['https']
  if(!protocols.includes(url.protocol.slice(0,-1))||(url.protocol==='https:'&&!(deps.allowedHosts??['git.jp-visser.nl']).includes(url.hostname))||url.username||url.password||url.search||url.hash)return invalid()
  const snapshot=input.snapshot?.repository as {repo_url?:string;base_sha?:string;product_id?:string}|undefined
  if(snapshot&&(snapshot.repo_url!==repoUrl||snapshot.base_sha!==repository.base_sha||(snapshot.product_id!==undefined&&snapshot.product_id!==repository.product_id)))return invalid()
  await mkdir(deps.root,{recursive:true,mode:0o700})
  if(await realpath(deps.root)!==resolve(deps.root)||(await lstat(deps.root)).isSymbolicLink())return invalid()
  const path=join(deps.root,attemptId),branch=`codex/queue-${input.requestId}`
  await mkdir(path,{mode:0o700}) // existing/uncertain attempt directories never inherited
  await isolatedGit(path,['init','--template='])
  await isolatedGit(path,['config','core.hooksPath','/dev/null']);await isolatedGit(path,['config','protocol.allow','never'])
  await isolatedGit(path,['remote','add','origin',repoUrl])
  if(await isolatedGit(path,['remote','get-url','origin'])!==repoUrl)return invalid()
  const header=await deps.gitAuthHeader?.(repoUrl);if(header&&/[\r\n]/.test(header))return invalid()
  await isolatedGit(path,['fetch','--depth=1','--no-tags','--no-recurse-submodules','origin',repository.base_sha],protocols.join(':'),header?{repoUrl,header}:undefined)
  if(await isolatedGit(path,['rev-parse','FETCH_HEAD'])!==repository.base_sha)return invalid()
  await isolatedGit(path,['checkout','--no-recurse-submodules','-b',branch,repository.base_sha])
  return {path,branch,baseSha:repository.base_sha}
 }
 async function prepareRepositorySource(input:DispatchInput,requestId:string,snapshot:Record<string,unknown>){
  const x=await prepareDispatchWorkspace({...input,requestId,snapshot},randomUUID())
  const bundle=join(x.path,'.git','dispatch-base.bundle')
  await isolatedGit(x.path,['bundle','create',bundle,'HEAD'])
  const st=await lstat(bundle);if(st.size>ARTIFACT_MAX_BYTES)throw new DispatchError('DISPATCH_TOO_LARGE')
  return {bytes:new Uint8Array(await readFile(bundle)),repoUrl:await isolatedGit(x.path,['remote','get-url','origin']),baseSha:x.baseSha}
 }
 return {prepareDispatchWorkspace,prepareRepositorySource}
}
const checkSchema=z.object({name:z.string(),status:z.enum(['passed','failed','not_run']),evidence:z.string()}).strict()
const codeSchema=z.object({version:z.literal(1),repoUrl:z.string(),baseSha:z.string().regex(oid),headSha:z.string().regex(oid),branch:z.string().regex(/^codex\/queue-[a-f0-9-]{36}$/),files:z.array(z.string()),checks:z.array(checkSchema),bundle:z.string(),diff:z.string()}).strict()
type Expected={repoUrl:string;baseSha:string;headSha:string;branch:string;checks:DispatchResult['checks']}
async function verifyHead(path:string,x:Expected){
 if(!oid.test(x.baseSha)||!oid.test(x.headSha)||await isolatedGit(path,['remote','get-url','origin'])!==x.repoUrl)return invalid()
 await isolatedGit(path,['cat-file','-e',`${x.baseSha}^{commit}`]);await isolatedGit(path,['cat-file','-e',`${x.headSha}^{commit}`]);await isolatedGit(path,['merge-base','--is-ancestor',x.baseSha,x.headSha])
 const names=exactGitText(await isolatedGitRaw(path,['diff','--name-only','-z',x.baseSha,x.headSha]))
 if(names&&!names.endsWith('\0'))return invalid()
 return {files:names?names.slice(0,-1).split('\0'):[],diff:exactGitText(await isolatedGitRaw(path,['diff','--binary','--no-ext-diff','--no-textconv',x.baseSha,x.headSha]))}
}
/** Agent Git configuration and filesystem objects are untrusted at collection.
 * Git config itself is read without includes; filters/aliases/external helpers
 * are rejected before status/diff/rev traversal can execute them. */
async function assertCollectableRepository(path:string){
 const denied=():never=>{throw new DispatchError('DISPATCH_FORBIDDEN')}
 const gitPath=join(path,'.git')
 if(!(await lstat(gitPath)).isDirectory()||await realpath(gitPath)!==join(await realpath(path),'.git'))return denied()
 async function inspect(p:string):Promise<void>{const st=await lstat(p);if(st.isSymbolicLink()||(!st.isDirectory()&&(!st.isFile()||st.nlink!==1)))return denied();if(st.isDirectory())for(const name of await readdir(p))await inspect(join(p,name))}
 await inspect(gitPath)
 for(const name of ['alternates','http-alternates']){try{await lstat(join(gitPath,'objects','info',name));return denied()}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
 // Preflight raw local config before starting Git: even repository discovery
 // must not interpret model-supplied includes, worktree paths or extensions.
 const configPath=join(gitPath,'config');if((await lstat(configPath)).size>65536)return denied()
 const raw=await readFile(configPath,'utf8');let section=''
 for(const line of raw.split(/\r?\n/)){
  const text=line.trim();if(!text||text.startsWith('#')||text.startsWith(';'))continue
  const header=/^\[(core|user|protocol|remote "origin")\]$/.exec(text)
  if(header){section=header[1];continue}
  const field=/^([a-zA-Z]+)\s*=([^\r\n]*)$/.exec(text)
  if(!field||!section||field[2].includes('\\'))return denied()
  const allowed:Record<string,string[]>= {core:['repositoryformatversion','filemode','bare','logallrefupdates','hookspath','ignorecase','precomposeunicode','symlinks'],user:['name','email'],protocol:['allow'],'remote "origin"':['url','fetch']}
  if(!allowed[section].includes(field[1].toLowerCase()))return denied()
 }
 const config=exactGitText(await isolatedGitRaw(path,['config','--local','--no-includes','--null','--list']))
 for(const entry of config.split('\0').filter(Boolean)){
  const key=entry.split('\n',1)[0]
  if(!/^core\.(repositoryformatversion|filemode|bare|logallrefupdates|hookspath|ignorecase|precomposeunicode|symlinks)$/.test(key)&&!/^remote\.origin\.(url|fetch)$/.test(key)&&!/^user\.(name|email)$/.test(key)&&key!=='protocol.allow')return denied()
 }
}
export async function createCodeArtifact(path:string,expected:Expected):Promise<Uint8Array>{
 await assertCollectableRepository(path)
 if(await isolatedGit(path,['rev-parse','HEAD'])!==expected.headSha||await isolatedGit(path,['branch','--show-current'])!==expected.branch||await isolatedGit(path,['status','--porcelain']))return invalid()
 const details=await verifyHead(path,expected),bundlePath=join(path,'.git',`dispatch-code-${randomUUID()}.bundle`)
 // Only descendants since base; base is a verified prerequisite, not repo history.
 if(expected.baseSha===expected.headSha)return Buffer.from(JSON.stringify({version:1,...expected,...details,bundle:''}))
 await isolatedGit(path,['bundle','create',bundlePath,`${expected.baseSha}..HEAD`])
 if((await lstat(bundlePath)).size>ARTIFACT_MAX_BYTES)throw new DispatchError('DISPATCH_TOO_LARGE')
 const bytes=Buffer.from(JSON.stringify({version:1,...expected,...details,bundle:(await readFile(bundlePath)).toString('base64')}))
 if(bytes.length>ARTIFACT_MAX_BYTES)throw new DispatchError('DISPATCH_TOO_LARGE')
 return bytes
}
export async function verifyCodeArtifact(bytes:Uint8Array,baseBundle:Uint8Array,expected:Expected):Promise<{files:string[]}>{
 if(bytes.byteLength>ARTIFACT_MAX_BYTES||baseBundle.byteLength>ARTIFACT_MAX_BYTES)throw new DispatchError('DISPATCH_TOO_LARGE')
 const data=codeSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
 for(const key of ['repoUrl','baseSha','headSha','branch','checks'] as const)if(JSON.stringify(data[key])!==JSON.stringify(expected[key]))return invalid()
 const bundle=Buffer.from(data.bundle,'base64');if(bundle.toString('base64')!==data.bundle)return invalid()
 const root=await mkdtemp(join(tmpdir(),'dispatch-publisher-'))
 try{
  const path=join(root,'repo');await mkdir(path);const basePath=join(root,'base.bundle'),codePath=join(root,'code.bundle');await writeFile(basePath,baseBundle);await writeFile(codePath,bundle)
  await importBaseBundle(path,basePath,expected.baseSha,expected.repoUrl,expected.branch)
  if(expected.baseSha===expected.headSha){if(bundle.length)return invalid()}else{
   await isolatedGit(path,['bundle','verify',codePath]);await isolatedGit(path,['fetch','--no-tags','--no-recurse-submodules',codePath,'HEAD'],'file')
   if(await isolatedGit(path,['rev-parse','FETCH_HEAD'])!==expected.headSha)return invalid()
  }
  const actual=await verifyHead(path,expected)
  if(JSON.stringify(actual.files)!==JSON.stringify(data.files)||actual.diff!==data.diff)return invalid()
  return {files:actual.files}
 }finally{await cleanupDispatchDirectory(root,'verification')}
}
