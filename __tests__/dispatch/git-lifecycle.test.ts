import {it,expect,vi} from 'vitest'
import {execFileSync} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {isolatedGit} from '../../src/dispatch/workspace.js'

it('finishes fetching without launching background maintenance or writing maintenance configuration',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dispatch-git-lifecycle-'))
 try{
  const source=join(root,'source'),target=join(root,'target'),bin=join(root,'bin'),trace=join(root,'trace.jsonl')
  await mkdir(source);await mkdir(target);await mkdir(bin)
  const git=execFileSync('which',['git'],{encoding:'utf8'}).trim()
  const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'"
  // Set tracing at the executable boundary: isolatedGit correctly strips ambient Git variables.
  await writeFile(join(bin,'git'),`#!/bin/sh\nexport GIT_TRACE2_EVENT=${quote(trace)}\nexec ${quote(git)} "$@"\n`,{mode:0o700})
  vi.stubEnv('PATH',`${bin}:${process.env.PATH}`)
  await isolatedGit(source,['init']);await isolatedGit(source,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','base'])
  await isolatedGit(target,['init']);await isolatedGit(target,['fetch',source,'HEAD'],'file')
  const events=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  const maintenance=events.filter(event=>event.event==='child_start'&&event.argv?.some((arg:string)=>arg==='maintenance'||arg==='gc'))
  expect(maintenance).toEqual([])
  expect(await isolatedGit(target,['rev-parse','FETCH_HEAD'])).toBe(await isolatedGit(source,['rev-parse','HEAD']))
  expect(await readFile(join(target,'.git','config'),'utf8')).not.toMatch(/maintenance|autoDetach|auto\s*=/i)
 }finally{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true,maxRetries:3})}
})
