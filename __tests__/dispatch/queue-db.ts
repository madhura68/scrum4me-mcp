import {Pool} from 'pg'
import {assertDispatchTestUrl,assertTestCluster} from '../../scripts/dispatch-test-db.mjs'

/** A second, separate queue database in the same disposable cluster: DISPATCH_QUEUE_DATABASE_URL may point
 * somewhere else than the dispatch database, and only a real second database proves nothing leans on sharing
 * one. Its two tables, the in_reply_to foreign key, both row guards and the projector/queue grants are rebuilt
 * from the catalog of the provisioned dispatch database, so they are the literal migrated definitions. */
export const QUEUE_TEST_DATABASE='s4m_dispatch_queue_test'
const TABLES=['agent_message','agent_message_archive'],GUARDS=['queue_dispatch_guard_message','queue_dispatch_guard_archive'],ROLES=['s4m_dispatch_projector','s4m_queue']
const elsewhere=(raw:string|undefined,role?:{username:string;password:string})=>{const url=assertDispatchTestUrl(raw);url.pathname='/'+QUEUE_TEST_DATABASE;if(role){url.username=role.username;url.password=role.password}return url.href}

export async function makeQueueDatabase(){
 const source=new Pool({connectionString:assertDispatchTestUrl(process.env.DISPATCH_TEST_ADMIN_URL).href,max:1})
 try{
  await assertTestCluster(source)
  if(!(await source.query('SELECT 1 FROM pg_database WHERE datname=$1',[QUEUE_TEST_DATABASE])).rowCount)await source.query(`CREATE DATABASE ${QUEUE_TEST_DATABASE}`)
  const ddl:string[]=[]
  for(const table of TABLES){
   const columns=(await source.query(`SELECT format('%I %s%s%s',a.attname,format_type(a.atttypid,a.atttypmod),CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,COALESCE(' DEFAULT '||pg_get_expr(d.adbin,d.adrelid),'')) AS col
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[`public.${table}`])).rows.map(r=>r.col)
   ddl.push(`CREATE TABLE public.${table} (${columns.join(', ')})`)
   // Every constraint of the table itself, plus the self-referencing reply link; foreign keys into PPE tables stay behind.
   const constraints=(await source.query(`SELECT format('ALTER TABLE public.%I ADD CONSTRAINT %I %s',$2::text,conname,pg_get_constraintdef(oid)) AS sql FROM pg_constraint
     WHERE conrelid=$1::regclass AND (contype IN ('p','u','c') OR (contype='f' AND confrelid=conrelid)) ORDER BY contype DESC,conname`,[`public.${table}`,table])).rows.map(r=>r.sql)
   ddl.push(...constraints)
  }
  for(const guard of GUARDS)ddl.push((await source.query('SELECT pg_get_functiondef($1::regproc) AS sql',[`public.${guard}`])).rows[0].sql)
  ddl.push(...(await source.query("SELECT pg_get_triggerdef(oid) AS sql FROM pg_trigger WHERE tgname LIKE 'queue_dispatch_guard_%' AND NOT tgisinternal AND tgrelid=ANY($1::regclass[]) ORDER BY tgname",[TABLES.map(t=>`public.${t}`)])).rows.map(r=>r.sql))
  ddl.push(...(await source.query(`SELECT format('GRANT %s ON public.%I TO %I',string_agg(privilege_type,','),table_name,grantee) AS sql FROM information_schema.table_privileges
    WHERE table_schema='public' AND table_name=ANY($1::text[]) AND grantee=ANY($2::text[]) GROUP BY table_name,grantee ORDER BY 1`,[TABLES,ROLES])).rows.map(r=>r.sql))
  const admin=new Pool({connectionString:elsewhere(process.env.DISPATCH_TEST_ADMIN_URL),max:1})
  try{
   await admin.query('DROP TABLE IF EXISTS public.agent_message_archive,public.agent_message CASCADE')
   for(const guard of GUARDS)await admin.query(`DROP FUNCTION IF EXISTS public.${guard}() CASCADE`)
   for(const sql of ddl)await admin.query(sql)
   for(const role of ROLES)await admin.query(`GRANT CONNECT ON DATABASE ${QUEUE_TEST_DATABASE} TO "${role}"`)
  }finally{await admin.end()}
 }finally{await source.end()}
 const credentials=(key:string)=>{const u=assertDispatchTestUrl(process.env[key]);return {username:u.username,password:u.password}}
 const projector=new Pool({connectionString:elsewhere(process.env.DISPATCH_TEST_PROJECTOR_URL,credentials('DISPATCH_TEST_PROJECTOR_URL')),max:4,connectionTimeoutMillis:1500})
 const admin=new Pool({connectionString:elsewhere(process.env.DISPATCH_TEST_ADMIN_URL),max:2})
 const control=new Pool({connectionString:assertDispatchTestUrl(process.env.DISPATCH_TEST_ADMIN_URL).href,max:1})
 return {projector,admin,
  /** A real outage: the database refuses every new connection and drops the existing ones. */
  async setAvailable(available:boolean){
   await control.query(`ALTER DATABASE ${QUEUE_TEST_DATABASE} ALLOW_CONNECTIONS ${available}`)
   if(!available)await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[QUEUE_TEST_DATABASE])
  },
  async close(){await control.query(`ALTER DATABASE ${QUEUE_TEST_DATABASE} ALLOW_CONNECTIONS true`).catch(()=>undefined);await Promise.all([projector.end(),admin.end(),control.end()])}}
}
