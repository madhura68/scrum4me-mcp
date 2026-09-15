import {codeAttempt} from './code-lifecycle-fixtures.js'
import {it,expect} from 'vitest'
import {randomUUID,generateKeyPairSync} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {makeDispatchHarness} from './harness.js'
import {createDispatchAuth} from '../../src/dispatch/auth.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
import {createDispatchSources} from '../../src/dispatch/sources.js'
import {createDispatchSelection} from '../../src/dispatch/selection.js'
import {createDispatchRegistration} from '../../src/dispatch/registration.js'
import {createDispatchAttempts} from '../../src/dispatch/attempts.js'
import {createDispatchArtifacts,artifactHash} from '../../src/dispatch/artifacts.js'
import {createDispatchCompletion} from '../../src/dispatch/completion.js'
import {createDispatchPublication,createGitPublicationPort} from '../../src/dispatch/publication.js'
import {canonicalRuntimeStopObservation,type RuntimeStopObservationBody} from '@shared/queue-dispatch-runtime-observation.js'
import {isolatedGit,createCodeArtifact} from '../../src/dispatch/workspace.js'
import type {DispatchInput,DispatchResult} from '@shared/queue-dispatch.js'
it.each([false,true])('projects only the explicit Task using frozen verify_only=%s and releases real claimed occupancy',async verifyOnly=>{
 const h=await makeDispatchHarness(),root=await mkdtemp(join(tmpdir(),'ip09-task-'))
 try{
  const {f,task,story,pbi,proof,stop,artifacts,completion,result}=await codeAttempt(h,root,{verifyOnly})
  await completion.verifyStopEvidence(f.actor,proof,stop);await expect(h.dispatch.query('UPDATE tasks SET dispatch_request_id=NULL WHERE id=$1',[task])).rejects.toMatchObject({code:'42501'})
  const receipt=await completion.acceptDispatchResult(f.actor,proof,result);expect(receipt.accepted).toBe(true)
  expect((await h.web.query('SELECT status,dispatch_request_id FROM tasks WHERE id=$1',[task])).rows[0]).toEqual({status:verifyOnly?'DONE':'FAILED',dispatch_request_id:null})
  expect((await h.web.query('SELECT status FROM stories WHERE id=$1',[story])).rows[0].status).toBe(verifyOnly?'DONE':'FAILED')
  expect((await h.web.query('SELECT status FROM pbis WHERE id=$1',[pbi])).rows[0].status).toBe(verifyOnly?'DONE':'FAILED')
  await expect(artifacts.assertCleanupReceipt(f.actor,proof.attempt_id,receipt.resultId!)).resolves.toBeUndefined()
 }finally{await h.close();await rm(root,{recursive:true,force:true})}
})
it('closes the ordinary Sprint without touching its independent SprintRun',async()=>{
 const h=await makeDispatchHarness(),root=await mkdtemp(join(tmpdir(),'ip09-sprint-'))
 try{
  const {f,story,proof,completion,result}=await codeAttempt(h,root,{verifyOnly:true}),sprint=randomUUID(),run=randomUUID()
  await h.admin.query("INSERT INTO sprints(id,product_id,code,sprint_goal) VALUES($1,$2,'SP-IP09','Lifecycle')",[sprint,f.input.product_id])
  await h.admin.query('UPDATE stories SET sprint_id=$2 WHERE id=$1',[story,sprint])
  await h.admin.query("INSERT INTO sprint_runs(id,sprint_id,started_by_id,pr_strategy,updated_at) VALUES($1,$2,$3,'SPRINT',now())",[run,sprint,f.actor.userId])
  await completion.acceptDispatchResult(f.actor,proof,result)
  expect((await h.admin.query('SELECT status,completed_at FROM sprints WHERE id=$1',[sprint])).rows[0]).toMatchObject({status:'CLOSED',completed_at:expect.any(Date)})
  expect((await h.admin.query('SELECT status,finished_at FROM sprint_runs WHERE id=$1',[run])).rows[0]).toEqual({status:'QUEUED',finished_at:null})
 }finally{await h.close();await rm(root,{recursive:true,force:true})}
})
