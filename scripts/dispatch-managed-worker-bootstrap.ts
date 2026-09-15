import {readFileSync} from 'node:fs'
import {Pool} from 'pg'
import {bootstrapManagedWorker} from '../src/dispatch/managed-worker-bootstrap.js'
/** Run only through the existing central operator credential path. No DSN fallback. */
async function main(){
 if(process.argv.length!==3 || !process.env.DISPATCH_BOOTSTRAP_DATABASE_URL) throw Error('DISPATCH_BOOTSTRAP_CONFIG_REQUIRED')
 const input=JSON.parse(readFileSync(process.argv[2],'utf8'))
 const store=new Pool({connectionString:process.env.DISPATCH_BOOTSTRAP_DATABASE_URL,max:1})
 try {console.log(JSON.stringify(await bootstrapManagedWorker(store,input)))}finally{await store.end()}
}
main().catch(()=>{console.error('DISPATCH_BOOTSTRAP_FAILED');process.exitCode=1})
