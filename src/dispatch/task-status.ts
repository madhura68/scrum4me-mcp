import type {PoolClient} from 'pg'
import {decideStoryStatus,decidePbiStatus,decideSprintStatus} from '../lib/task-status-decisions.js'
import {DispatchError} from './errors.js'
/** Acquire after request and before candidate/slot/job; never resolve SprintRun. */
export async function lockManagedTaskHierarchy(db:PoolClient,taskId:string){
 const task=(await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0]
 if(!task)throw new DispatchError('DISPATCH_STATE_CONFLICT')
 const story=(await db.query('SELECT * FROM stories WHERE id=$1 FOR UPDATE',[task.story_id])).rows[0]
 const pbi=(await db.query('SELECT * FROM pbis WHERE id=$1 FOR UPDATE',[story.pbi_id])).rows[0]
 if(story.sprint_id)await db.query('SELECT id FROM sprints WHERE id=$1 FOR UPDATE',[story.sprint_id])
 return {task,story,pbi}
}
export async function projectManagedTaskStatus(db:PoolClient,taskId:string,status:'DONE'|'FAILED'):Promise<void>{
 const {story,pbi}=await lockManagedTaskHierarchy(db,taskId)
 await db.query('UPDATE tasks SET status=$2,updated_at=now() WHERE id=$1',[taskId,status])
 const tasks=(await db.query('SELECT status FROM tasks WHERE story_id=$1',[story.id])).rows
 await db.query('UPDATE stories SET status=$2,updated_at=now() WHERE id=$1',[story.id,decideStoryStatus(tasks.map(x=>x.status),!!story.sprint_id)])
 const stories=(await db.query('SELECT status FROM stories WHERE pbi_id=$1',[pbi.id])).rows
 await db.query('UPDATE pbis SET status=$2,updated_at=now() WHERE id=$1',[pbi.id,decidePbiStatus(stories.map(x=>x.status),pbi.status)])
 if(story.sprint_id){
  const rows=(await db.query('SELECT DISTINCT p.id,p.status FROM pbis p JOIN stories s ON s.pbi_id=p.id WHERE s.sprint_id=$1',[story.sprint_id])).rows
  const next=decideSprintStatus(rows.map(x=>x.status))
  await db.query("UPDATE sprints SET status=$2::\"SprintStatus\",completed_at=CASE WHEN $2::text='CLOSED' AND status::text<>$2::text THEN now() ELSE completed_at END WHERE id=$1",[story.sprint_id,next])
 }
}
