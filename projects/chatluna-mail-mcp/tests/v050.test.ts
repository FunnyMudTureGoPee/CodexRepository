import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repository, registerModels, digest } from '../src/repository.js'
import { Assets } from '../src/assets.js'
import { MailService, type Sender } from '../src/service.js'
import { taskSchema, mailSchema, type Config } from '../src/types.js'
import { failureInfo } from '../src/transport.js'
import { adminHandlers } from '../src/console.js'
const require=createRequire(import.meta.url)
const {Context}=require('koishi') as typeof import('koishi')
const base:Config={endpoint:'/mcp/mail',token:'test-only-token-over-24-characters',enabled:true,allowAgentSend:true,allowedRecipients:['a@example.com','b@example.com'],smtpHost:'localhost',smtpPort:465,smtpSecure:true,smtpUser:'',smtpPassword:'not-to-be-printed',from:'sender@example.com',maxPerDay:100,modelTimeoutMs:500,maxContextChars:24000,maxRetryAttempts:2,retryDelayMinutes:1,retentionDays:30}
const mail={to:['a@example.com'],subject:'stable subject',paragraphs:['private-body'],images:[],templateId:'briefing'}
const task={id:'task',enabled:true,time:'09:00',conversationId:'conv',prompt:'根据上下文判断',to:['a@example.com'],retryOnFailure:true}
async function setup(sender?:Sender,config:Partial<Config>={},sqlitePath?:string,dir?:string){
 const ctx=new Context()
 if(sqlitePath) ctx.plugin(require('@koishijs/plugin-database-sqlite').default,{path:sqlitePath})
 else ctx.plugin(require('@koishijs/plugin-database-memory').default)
 registerModels(ctx);await ctx.start()
 const repo=new Repository(ctx),assets=new Assets(dir ?? await mkdtemp(join(tmpdir(),'mail-050-assets-')),repo)
 const sent:any[]=[]
 const service=new MailService(ctx,{...base,...config},repo,assets,sender ?? (async m=>{sent.push(m);return {accepted:m.to,rejected:[]}}))
 return {ctx,repo,assets,service,sent}
}
async function age(repo:Repository,id:string,days=40){
 const old=new Date(Date.now()-days*86400000)
 await repo.ctx.database.set('chatluna_mail',{id},{createdAt:old,updatedAt:old})
}
function mockContext(ctx:InstanceType<typeof Context>,texts=['one','two'],at=new Date()){
 let calls=0
 Object.defineProperty(ctx,'chatluna',{configurable:true,value:{
  conversation:{getConversation:async()=>({id:'conv',status:'active',preset:'main',model:'chosen/model',latestMessageId:'m'+texts.length,lastChatAt:at}),listMessages:async()=>texts.map((text,i)=>({id:'m'+(i+1),parentId:i?'m'+i:null,role:i%2?'ai':'human',text,createdAt:at}))},
  preset:{getPreset:()=>({value:{}})},promptRenderer:{renderPresetTemplate:async()=>({messages:[['system','主插件预设']]})},
  createChatModel:async()=>({value:{invoke:async()=>{calls++;return {content:'{"shouldSend":false,"reason":"no need"}'}}}}),
 }})
 return ()=>calls
}
test('transport classification is conservative and does not expose secrets',()=>{
 assert.equal(failureInfo({code:'ETIMEDOUT'}).status,'unknown')
 assert.equal(failureInfo({code:'ECONNECTION'}).transient,true)
 assert.equal(failureInfo({code:'EAUTH',responseCode:535}).transient,false)
 assert.equal(failureInfo({code:'EMESSAGE',responseCode:451}).status,'failed')
 assert.equal(failureInfo({code:'EMESSAGE',responseCode:451}).transient,true)
 assert.equal(failureInfo({code:'secret URL password'}).errorCode,'TRANSPORT_ERROR')
})
test('automatic retry reuses the original content and one LLM decision',async()=>{
 let count=0,decisions=0;const submitted:any[]=[]
 const s=await setup(async m=>{submitted.push(m);if(++count===1) throw Object.assign(new Error('do not expose'),{code:'ECONNECTION'});return {accepted:m.to,rejected:[]}},{autoRetryEnabled:true})
 try{
  await s.service.saveTask(task)
  ;(s.service.decision as any).evaluate=async()=>{decisions++;return {decision:{shouldSend:true,reason:'send',mail:{subject:'fixed',paragraphs:['same content'],images:[]}},source:{latestMessageId:'m2'},templateSnapshot:await s.service.templates.get('briefing')}}
  const result:any=await s.service.evaluate('task','day')
  assert.equal(result.status,'failed')
  const jobs=await s.repo.list('retry');assert.equal(jobs.length,1)
  await s.service.retries.tick(new Date(JSON.parse(jobs[0].payload).dueAt))
  assert.equal(count,2);assert.equal(decisions,1)
  assert.equal(submitted[0].html,submitted[1].html)
  assert.equal((await s.repo.list('run'))[0].status,'accepted')
  assert.equal(await s.service.checkpoint('task'),'m2')
 }finally{await s.ctx.stop()}
})
test('retry cap, backoff, cancellation and unknown outcome prevent repeated delivery',async()=>{
 let count=0;const s=await setup(async()=>{count++;throw Object.assign(new Error('network'),{code:'ECONNECTION'})},{autoRetryEnabled:true})
 try{
  const t=await s.service.saveTask(task)
  await s.service.send(mail,'limited',undefined,undefined,{origin:{kind:'task',taskId:t.id,taskHash:digest(t),autoRetry:true}})
  let job=(await s.repo.list('retry'))[0]
  await s.service.retries.tick(new Date(JSON.parse(job.payload).dueAt))
  const jobs=await s.repo.list('retry');assert.equal(jobs.length,2)
  job=jobs.find(e=>e.status==='scheduled')!
  await s.service.retries.cancel(job.id)
  await s.service.retries.tick(new Date(Date.now()+86400000))
  assert.equal(count,2)
 }finally{await s.ctx.stop()}
 const u=await setup(async()=>{throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})})
 try{
  const original=await u.service.send(mail,'uncertain')
  await assert.rejects(()=>u.service.retries.queue(original.id),/definite/)
 }finally{await u.ctx.stop()}
})
test('partial retry includes only explicitly rejected original recipients',async()=>{
 let n=0;const targets:string[][]=[]
 const s=await setup(async m=>{targets.push(m.to);return ++n===1?{accepted:['a@example.com'],rejected:['b@example.com']}:{accepted:m.to,rejected:[]}})
 try{
  const original=await s.service.send({...mail,to:['a@example.com','b@example.com']},'partial')
  assert.equal(original.status,'partial')
  const queued:any=await s.service.retries.queue(original.id)
  await s.service.retries.cancel(queued.id)
  const restarted:any=await s.service.retries.queue(original.id)
  assert.equal(restarted.id,queued.id);assert.equal(restarted.status,'scheduled')
  await s.service.retries.tick(new Date(Date.now()+1000))
  assert.deepEqual(targets,[['a@example.com','b@example.com'],['b@example.com']])
 }finally{await s.ctx.stop()}
})
test('retry checks current task authorization and whitelist immediately before sending',async()=>{
 let calls=0
 const s=await setup(async()=>{calls++;throw Object.assign(new Error('fail'),{code:'ECONNECTION'})})
 try{
  const t=await s.service.saveTask(task)
  const original=await s.service.send(mail,'revoked',undefined,undefined,{origin:{kind:'task',taskId:t.id,taskHash:digest(t),autoRetry:false}})
  await s.service.retries.queue(original.id)
  await s.service.toggle(t.id,false)
  await s.service.retries.tick(new Date(Date.now()+1000))
  assert.equal(calls,1);assert.equal((await s.repo.list('retry'))[0].status,'blocked')
 }finally{await s.ctx.stop()}
})
test('context diagnostics do not invoke LLM; since-last-send skips unchanged history',async()=>{
 const s=await setup()
 try{
  const calls=mockContext(s.ctx)
  await s.service.saveTask({...task,contextMode:'since-last-send'})
  const before=await s.service.diagnose('task')
  assert.equal(before.modelInvoked,false);assert.equal(before.model,'chosen/model');assert.equal(calls(),0)
  await s.repo.put('run:previous','run','accepted',{taskId:'task',source:{latestMessageId:'m2'}})
  const result:any=await s.service.evaluate('task')
  assert.equal(result.status,'skipped');assert.equal(calls(),0)
  assert.ok(!(JSON.stringify(await s.service.diagnose('task'))).includes('"one"'))
  await s.service.saveTask({...task,contextMode:'recent',minNewMessages:1})
  assert.equal((await s.service.evaluate('task') as any).status,'skipped')
  assert.equal(calls(),0)
 }finally{await s.ctx.stop()}
})
test('context freshness, missing checkpoint and explicit truncation are enforced',async()=>{
 const s=await setup()
 try{
  mockContext(s.ctx,['old'],new Date(Date.now()-48*3600000))
  await s.service.saveTask({...task,contextMaxAgeHours:24})
  await assert.rejects(()=>s.service.diagnose('task'),/freshness limit/)
  mockContext(s.ctx,Array.from({length:6},()=> 'x'.repeat(1100)))
  s.service.config.maxContextChars=3500
  await s.service.saveTask({...task,contextOverflow:'trim-oldest',historyLimit:100})
  const info=await s.service.diagnose('task')
  assert.ok(info.droppedMessages>0);assert.ok(info.contextChars<=3500)
  await s.service.saveTask({...task,contextMode:'since-last-send'})
  await s.repo.put('run:checkpoint','run','accepted',{taskId:'task',source:{latestMessageId:'missing'}})
  await assert.rejects(()=>s.service.diagnose('task'),/checkpoint/)
 }finally{await s.ctx.stop()}
})
test('cleanup preview changes nothing; compaction preserves idempotency and checkpoint',async()=>{
 const s=await setup()
 try{
  const d=await s.service.draft(mail)
  await s.service.send(mail,'old')
  await s.repo.put('run:task:old','run','accepted',{taskId:'task',decision:{reason:'private-body'},source:{latestMessageId:'m2'}})
  for(const id of ['draft:'+d.draftId,'delivery:old','run:task:old']) await age(s.repo,id)
  const plan=await s.service.maintenance.plan()
  assert.ok((await s.repo.get('delivery:old'))!.payload.includes('private-body'))
  assert.ok(plan.counts.compact>=2)
  await assert.rejects(()=>s.service.maintenance.apply(plan.planId,false),/confirmation/)
  s.service.config.retentionDays=90
  await assert.rejects(()=>s.service.maintenance.apply(plan.planId,true),/policy changed/)
  s.service.config.retentionDays=30
  const done=await s.service.maintenance.apply(plan.planId,true)
  assert.equal(done.failed.length,0)
  assert.ok(!(await s.repo.get('delivery:old'))!.payload.includes('private-body'))
  assert.equal((await s.service.send(mail,'old')).status,'accepted')
  assert.equal(s.sent.length,1)
  assert.equal(await s.service.checkpoint('task'),'m2')
  assert.equal(await s.repo.claim('run:task:old','run',{}),false)
  await assert.rejects(()=>s.service.preview(d.draftId),/expired/)
 }finally{await s.ctx.stop()}
})
test('cleanup rejects stale plans and protects queued retries',async()=>{
 const s=await setup(async()=>{throw Object.assign(new Error('failed'),{code:'ECONNECTION'})})
 try{
  const original=await s.service.send(mail,'protected')
  await age(s.repo,original.id)
  const plan=await s.service.maintenance.plan()
  await s.service.retries.queue(original.id)
  await assert.rejects(()=>s.service.maintenance.apply(plan.planId,true),/changed/)
  const current=await s.service.maintenance.plan()
  assert.ok(!current.items.some(i=>i.id===original.id))
 }finally{await s.ctx.stop()}
})
test('only unpinned orphan images enter recoverable trash; active references protect assets',async()=>{
 const s=await setup()
 try{
  const file=join(s.assets.dir,'source.png')
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=','base64')
  await writeFile(file,bytes)
  const pinned=await s.assets.import(file);await age(s.repo,'asset:'+pinned.id)
  assert.equal((await s.service.maintenance.plan()).counts.trashedAssets,0)
  await s.assets.setPinned(pinned.id,false);await age(s.repo,'asset:'+pinned.id)
  const plan=await s.service.maintenance.plan()
  assert.equal(plan.counts.trashedAssets,1)
  await s.service.maintenance.apply(plan.planId,true)
  assert.equal((await s.repo.get('asset:'+pinned.id))?.status,'trashed')
  await s.service.withMaintenance(()=>s.assets.restore(pinned.id))
  assert.deepEqual(await readFile(join(s.assets.dir,pinned.name)),bytes)
  assert.equal((await s.assets.list())[0].pinned,true)
  await s.assets.setPinned(pinned.id,false);await age(s.repo,'asset:'+pinned.id)
  await s.service.draft({...mail,images:[{assetId:pinned.id}]})
  assert.equal((await s.service.maintenance.plan()).counts.trashedAssets,0)
 }finally{await s.ctx.stop()}
})
test('concurrent decisions respect one shared hourly cap',async()=>{
 const s=await setup(undefined,{maxDecisionsPerHour:1})
 try{
  mockContext(s.ctx)
  await s.service.saveTask(task);await s.service.saveTask({...task,id:'second'})
  const results=await Promise.allSettled([s.service.evaluate('task'),s.service.evaluate('second')])
  assert.equal((await s.repo.list('run')).length,1)
  assert.equal(results.filter(r=>r.status==='rejected').length,1)
 }finally{await s.ctx.stop()}
})
test('SQLite upgrade and restart retain old tasks and do not resend an uncertain retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-050-sqlite-')),path=join(dir,'mail.sqlite'),assetDir=join(dir,'assets')
 let calls=0
 const first=await setup(async()=>{calls++;throw Object.assign(new Error('connection'),{code:'ECONNECTION'})},{},path,assetDir)
 let childKey=''
 try{
  await first.repo.put('task:old','task','paused',{...task,id:'old',enabled:false,retryOnFailure:undefined})
  const original=await first.service.send(mail,'restart')
  const job:any=await first.service.retries.queue(original.id)
  childKey=job.childKey
  const snapshot=await first.service.templates.get('briefing'),normalized=mailSchema.parse(mail)
  await first.repo.claim('delivery:'+childKey,'delivery',{mail:normalized,templateSnapshot:snapshot,rootDeliveryId:original.id,attempt:1},digest({mail:normalized,templateSnapshot:snapshot}))
  await first.repo.put(job.id,'retry','running',JSON.parse((await first.repo.get(job.id))!.payload))
 }finally{await first.ctx.stop()}
 const second=await setup(async()=>{calls++;return {accepted:['a@example.com'],rejected:[]}},{},path,assetDir)
 try{
  await second.repo.recover()
  assert.equal((await second.service.task('old')).contextMode,'recent')
  assert.equal((await second.repo.get('delivery:'+childKey))?.status,'unknown')
  await second.service.retries.tick(new Date(Date.now()+1000))
  assert.equal(calls,1)
  const job=(await second.repo.list('retry'))[0]
  assert.equal(job.status,'completed');assert.equal(JSON.parse(job.payload).outcome,'unknown')
 }finally{await second.ctx.stop()}
})
test('admin history filters and paginates without leaking configuration secrets',async()=>{
 const s=await setup()
 try{
  for(let n=0;n<23;n++) await s.repo.put('run:'+n,'run',n%2?'skipped':'error',{taskId:'task'})
  const api=adminHandlers(s.service)
  const page:any=await api['mail-admin/records']({kind:'run',page:1,status:'error'})
  assert.equal(page.total,12);assert.equal(page.items.length,12)
  const next:any=await api['mail-admin/records']({kind:'run',page:2,status:''})
  assert.equal(next.items.length,3)
  assert.ok(!JSON.stringify(await api['mail-admin/snapshot']()).includes(base.smtpPassword))
 }finally{await s.ctx.stop()}
})

test('automatic retry stops after the configured number of attempts',async()=>{
 let count=0
 const s=await setup(async()=>{count++;throw Object.assign(new Error('fail'),{code:'ECONNECTION'})},{autoRetryEnabled:true,maxRetryAttempts:2})
 try{
  const t=await s.service.saveTask(task)
  await s.service.send(mail,'max-chain',undefined,undefined,{origin:{kind:'task',taskId:t.id,taskHash:digest(t),autoRetry:true}})
  for(let n=0;n<4;n++){
   const pending=(await s.repo.list('retry')).find(e=>e.status==='scheduled')
   if(!pending) break
   await s.service.retries.tick(new Date(JSON.parse(pending.payload).dueAt))
  }
  assert.equal(count,3)
  assert.equal((await s.repo.list('retry')).length,2)
  const latest=(await s.repo.list('delivery')).find(e=>JSON.parse(e.payload).attempt===2)!
  await assert.rejects(()=>s.service.retries.queue(latest.id),/limit/)
 }finally{await s.ctx.stop()}
})
test('maintenance cannot race an active decision and revoked recipients block retries',async()=>{
 const s=await setup()
 let release:any,entered:any
 const ready=new Promise<void>(resolve=>entered=resolve)
 try{
  await s.service.saveTask(task)
  ;(s.service.decision as any).evaluate=()=>{entered();return new Promise(resolve=>release=resolve)}
  const work=s.service.evaluate('task')
  await ready
  const plan=await s.service.maintenance.plan()
  await assert.rejects(()=>s.service.maintenance.apply(plan.planId,true),/idle/)
  release({decision:{shouldSend:false,reason:'skip'},source:{}})
  await work
 }finally{await s.ctx.stop()}
 let count=0
 const r=await setup(async()=>{count++;throw Object.assign(new Error('fail'),{code:'ECONNECTION'})})
 try{
  const result=await r.service.send(mail,'white-list')
  await r.service.retries.queue(result.id)
  r.service.config.allowedRecipients=[]
  await r.service.retries.tick(new Date(Date.now()+1000))
  assert.equal(count,1)
  assert.equal((await r.repo.list('retry'))[0].status,'blocked')
 }finally{await r.ctx.stop()}
})

