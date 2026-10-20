import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repository, registerModels, digest } from '../src/repository.js'
import { Assets } from '../src/assets.js'
import { MailService } from '../src/service.js'
import { taskSchema, type Config } from '../src/types.js'
import { TemplateStore, render } from '../src/templates.js'
import { nextOccurrence, occurrence } from '../src/schedule.js'
import { Scheduler } from '../src/scheduler.js'
import { adminHandlers, registerConsole } from '../src/console.js'
const require=createRequire(import.meta.url)
const {Context}=require('koishi') as typeof import('koishi')
const config:Config={endpoint:'/mcp/mail',token:'test-token-more-than-24-chars',enabled:true,allowAgentSend:true,allowedRecipients:['test@example.com'],smtpHost:'localhost',smtpPort:465,smtpSecure:true,smtpUser:'',smtpPassword:'secret-do-not-leak',from:'sender@example.com',maxPerDay:10,modelTimeoutMs:1000,maxContextChars:24000}
const input={id:'task',enabled:true,time:'09:00',conversationId:'conv',prompt:'按上下文决定',to:['test@example.com']}
const mail={to:['test@example.com'],subject:'主题',paragraphs:['<script>正文</script>'],images:[],templateId:'briefing'}
async function setup(){
 const ctx=new Context()
 ctx.plugin(require('@koishijs/plugin-database-memory').default)
 registerModels(ctx);await ctx.start()
 const repo=new Repository(ctx),assets=new Assets(await mkdtemp(join(tmpdir(),'mail-020-')),repo)
 const submitted:any[]=[]
 const service=new MailService(ctx,{...config},repo,assets,async m=>{submitted.push(m);return {accepted:['test@example.com'],rejected:[]}})
 return {ctx,repo,service,submitted}
}
const definition=(footer='致 {{name}}')=>({id:'custom',name:'个性通知',prompt:'写给 {{name}}，按当前上下文判断',fields:{name:{required:true,default:''}},layout:{footer,accent:'#123456'}})

test('legacy daily tasks parse with defaults; weekly and once validate',()=>{
 const old=taskSchema.parse(input)
 assert.equal(old.scheduleType,'daily');assert.equal(old.runAt,'')
 assert.throws(()=>taskSchema.parse({...input,scheduleType:'once'}))
 assert.throws(()=>taskSchema.parse({...input,scheduleType:'weekly',weekdays:[]}))
 assert.throws(()=>taskSchema.parse({...input,scheduleType:'weekly',weekdays:[0]}))
 assert.throws(()=>taskSchema.parse({...input,scheduleType:'once',runAt:'2026-10-20T09:00:00'}))
})
test('weekly and once occurrence keys, timezone offset, no catch-up',()=>{
 const weekly=taskSchema.parse({...input,scheduleType:'weekly',weekdays:[1,3]})
 assert.equal(occurrence(weekly,new Date('2026-10-19T01:00:00Z')),'2026-10-19')
 assert.equal(occurrence(weekly,new Date('2026-10-20T01:00:00Z')),undefined)
 assert.equal(nextOccurrence(weekly,new Date('2026-10-19T01:00:30Z')),'2026-10-21T01:00:00.000Z')
 const once=taskSchema.parse({...input,scheduleType:'once',runAt:'2026-10-20T09:00:00+08:00'})
 assert.ok(occurrence(once,new Date('2026-10-20T01:00:59Z'))?.startsWith('once-'))
 assert.equal(occurrence(once,new Date('2026-10-20T01:01:00Z')),undefined)
 assert.equal(nextOccurrence(once,new Date('2026-10-20T01:02:00Z')),null)
})
test('DST spring gap skips absent time and fall fold uses same daily identity',()=>{
 const spring=taskSchema.parse({...input,time:'02:30',timezone:'America/New_York'})
 assert.equal(nextOccurrence(spring,new Date('2026-03-08T05:00:00Z')),'2026-03-09T06:30:00.000Z')
 const fall=taskSchema.parse({...input,time:'01:30',timezone:'America/New_York'})
 assert.equal(occurrence(fall,new Date('2026-11-01T05:30:00Z')),occurrence(fall,new Date('2026-11-01T06:30:00Z')))
})
test('template versions, required variables, safe HTML and optimistic conflict',async()=>{
 const s=await setup()
 try {
  const one=await s.service.templates.save(definition(),0)
  assert.equal(one.version,1)
  await assert.rejects(()=>s.service.draft({...mail,templateId:'custom'}),/Missing template variable/)
  const draft=await s.service.draft({...mail,templateId:'custom',variables:{name:'<img src=x onerror=alert(1)>'}})
  assert.ok(draft.html.includes('&lt;img'))
  await s.service.templates.save(definition('新页脚 {{name}}'),1)
  assert.equal((await s.service.preview(draft.draftId)).templateVersion,1)
  await s.service.sendDraft(draft.draftId,'snapshot')
  assert.ok(s.submitted[0].html.includes('致 &lt;img'))
  assert.ok(!s.submitted[0].html.includes('新页脚'))
  assert.equal((await s.repo.list('template-version')).length,2)
  await assert.rejects(()=>s.service.templates.save(definition(),1),/conflict/)
  await assert.rejects(()=>s.service.templates.save({...definition(),layout:{accent:'red; background:url(http://evil)'}}),/Invalid/)
  await assert.rejects(()=>s.service.templates.save({...definition(),prompt:'{{undeclared}}'}),/Undeclared/)
  const fresh=new TemplateStore(s.repo)
  assert.equal((await fresh.get('custom')).version,2)
 } finally {await s.ctx.stop()}
})
test('two simultaneous editor saves cannot overwrite a newer revision',async()=>{
 const s=await setup()
 try {
  await s.service.saveTask(input)
  const hash=(await s.repo.get('task:task'))!.hash
  const result=await Promise.allSettled([s.service.saveTask({...input,prompt:'first'},hash),s.service.saveTask({...input,prompt:'second'},hash)])
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(result.filter(r=>r.status==='rejected').length,1)
 } finally {await s.ctx.stop()}
})
test('legacy delivery and old builtin draft remain idempotent after upgrade',async()=>{
 const s=await setup()
 try {
  await s.repo.put('delivery:old','delivery','accepted',{mail},digest(mail))
  const result=await s.service.send(mail,'old')
  assert.equal(result.status,'accepted');assert.equal(s.submitted.length,0)
  await s.repo.put('draft:old','draft','ready',mail)
  assert.equal((await s.service.preview('old')).templateVersion,1)
 } finally {await s.ctx.stop()}
})
test('once scheduler attempts once; completed or archived task has no next run',async()=>{
 const s=await setup(),scheduler=new Scheduler(s.service)
 try {
  const at=new Date(Date.now()+60000)
  await s.service.saveTask({...input,scheduleType:'once',runAt:at.toISOString()})
  ;(s.service.decision as any).evaluate=async()=>({decision:{shouldSend:false,reason:'skip'},source:{}})
  await scheduler.tick(at);await scheduler.tick(at)
  assert.equal((await s.repo.list('run')).length,1)
  assert.equal((await s.service.tasks(new Date(at.getTime()-60000)))[0].nextRunAt,null)
  await s.service.toggle('task',false);await s.service.archiveTask('task')
  assert.equal((await s.service.tasks()).length,0)
  assert.equal((await s.repo.list('run')).length,1)
 } finally {await s.ctx.stop()}
})
test('bad stored task does not prevent valid task execution',async()=>{
 const s=await setup()
 try {
  await s.repo.put('task:bad','task','enabled',{broken:true})
  await s.service.saveTask(input)
  ;(s.service.decision as any).evaluate=async()=>({decision:{shouldSend:false,reason:'skip'},source:{}})
  await new Scheduler(s.service).tick(new Date('2026-10-19T01:00:00Z'))
  assert.equal((await s.repo.list('run')).length,1)
 } finally {await s.ctx.stop()}
})
test('admin snapshot omits credentials, dry-run job polls and explicit send is idempotent',async()=>{
 const s=await setup()
 try {
  await s.service.saveTask(input)
  const api=adminHandlers(s.service)
  const snap=await api['mail-admin/snapshot']()
  assert.ok(!JSON.stringify(snap).includes(config.smtpPassword))
  assert.ok(!JSON.stringify(snap).includes(config.token))
  ;(s.service.decision as any).evaluate=async()=>({decision:{shouldSend:false,reason:'skip'},source:{}})
  const {jobId}=await api['mail-admin/evaluate']({id:'task'})
  let state:any
  for(let i=0;i<100;i++){
   state=await api['mail-admin/evaluation-result']({jobId})
   if(state.done) break
   await new Promise(r=>setTimeout(r,5))
  }
  assert.equal(state.result.status,'skipped');assert.equal(s.submitted.length,0)
  const d=await s.service.draft(mail)
  await api['mail-admin/send']({id:d.draftId});await api['mail-admin/send']({id:d.draftId})
  assert.equal(s.submitted.length,1)
 } finally {await s.ctx.stop()}
})
test('Console listeners use authority 4 and packaged frontend entry',async()=>{
 const ctx=new Context()
 ctx.plugin(require('@koishijs/plugin-database-memory').default)
 const serverFork=ctx.plugin(require('@koishijs/plugin-server').default,{host:'127.0.0.1',port:0})
 const consoleModule=require('@koishijs/plugin-console')
 const consoleFork=ctx.plugin(consoleModule.default ?? consoleModule,{open:false})
 registerModels(ctx);await ctx.start()
 const repo=new Repository(ctx),assets=new Assets(await mkdtemp(join(tmpdir(),'mail-console-')),repo)
 const service=new MailService(ctx,config,repo,assets,async()=>({accepted:[],rejected:[]}))
 const mailFork=ctx.plugin({inject:['console'],apply:(scope)=>registerConsole(scope,service,join(process.cwd(),'lib'))})
 try {
  await new Promise(resolve=>setImmediate(resolve))
  const listeners=ctx.console.listeners as any
  const names=Object.keys(listeners).filter(n=>n.startsWith('mail-admin/'))
  assert.equal(names.length,23)
  for(const name of names) assert.equal(listeners[name].authority,4)
  assert.ok(Object.values(ctx.console.entries).some((e:any)=>e.files.prod?.replace(/\\/g,'/').endsWith('console')))
 } finally {await mailFork?.dispose();await consoleFork?.dispose();await serverFork?.dispose();await ctx.stop()}
})
