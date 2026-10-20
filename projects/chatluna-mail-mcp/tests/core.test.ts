import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context as KoishiContext } from 'koishi'
import { createRequire } from 'node:module'
const { Context } = createRequire(import.meta.url)('koishi') as typeof import('koishi')
const memoryModule=createRequire(import.meta.url)('@koishijs/plugin-database-memory')
import nodemailer from 'nodemailer'
import { SMTPServer } from 'smtp-server'
import { Repository, registerModels } from '../src/repository.js'
import { Assets } from '../src/assets.js'
import { MailService, type Sender } from '../src/service.js'
import { taskSchema, type Config } from '../src/types.js'
import { activeHistory } from '../src/context.js'
import { render } from '../src/templates.js'
import { Scheduler, localMinute } from '../src/scheduler.js'
const config:Config={endpoint:'/mcp/mail',token:'test-token-at-least-24-characters',enabled:true,allowAgentSend:true,allowedRecipients:['test@example.com'],smtpHost:'localhost',smtpPort:465,smtpSecure:true,smtpUser:'',smtpPassword:'',from:'sender@example.com',maxPerDay:10,modelTimeoutMs:100,maxContextChars:24000}
const mail={to:['test@example.com'],subject:'中文通知',paragraphs:['<script>alert(1)</script>','第二段'],images:[],templateId:'briefing'}
async function setup(sender?:Sender) {
 const ctx=new Context();ctx.plugin((memoryModule.default ?? memoryModule) as never);registerModels(ctx);await ctx.start()
 const repo=new Repository(ctx),dir=await mkdtemp(join(tmpdir(),'mail-test-')),assets=new Assets(dir,repo)
 return {ctx,repo,assets,dir,service:new MailService(ctx,{...config},repo,assets,sender ?? (async()=>({accepted:['test@example.com'],rejected:[]})))}
}
const task=()=>taskSchema.parse({id:'daily',enabled:true,time:'09:00',conversationId:'conv',prompt:'有必要才发',to:['test@example.com'],cooldownMinutes:60})
function mockChat(ctx:KoishiContext,response:unknown,onInvoke?:(messages:any[])=>void) {
 Object.defineProperty(ctx,'chatluna',{value:{
 conversation:{getConversation:async()=>({id:'conv',status:'active',preset:'persona',model:'platform/default',latestMessageId:'2'}),listMessages:async()=>[{id:'1',role:'human',text:'需要提醒',parentId:null},{id:'2',parentId:'1',role:'ai',text:'好的'},{id:'branch',parentId:'1',role:'human',text:'其他分支'}]},
 preset:{getPreset:(name:string)=>({value:{name}})},
 promptRenderer:{renderPresetTemplate:async()=>({messages:[['system','主插件预设人格']]})},
 createChatModel:async(name:string)=>({value:{invoke:async(messages:any[])=>{onInvoke?.(messages);return {content:JSON.stringify(response),model:name}}}})
 },configurable:true})
}
test('HTML escaping and timezone boundary',()=>{
 assert.ok(render({...mail,templateId:'briefing'} as any).html.includes('&lt;script&gt;'))
 assert.deepEqual(localMinute(new Date('2026-10-18T17:00:00Z'),'Asia/Shanghai'),{day:'2026-10-19',time:'01:00',weekday:1})
})
test('active branch excludes siblings and rejects missing/cyclic history',()=>{
 const rows=[{id:'1',role:'human'},{id:'2',parentId:'1',role:'ai'},{id:'3',parentId:'1',role:'human'}]
 assert.deepEqual(activeHistory(rows,'2').map(r=>r.id),['1','2'])
 assert.throws(()=>activeHistory([{id:'1',parentId:'1',role:'human'}],'1'));assert.throws(()=>activeHistory(rows,'unknown'))
})
test('idempotency, conflict, recipient denial and daily limit',async()=>{
 let calls=0;const s=await setup(async()=>{calls++;return {accepted:['test@example.com'],rejected:[]}})
 try {
 const results=await Promise.all([s.service.send(mail,'same'),s.service.send(mail,'same')])
 assert.equal(calls,1);assert.equal(results[0].status,'accepted')
 await assert.rejects(()=>s.service.send({...mail,subject:'different'},'same'),/conflicts/)
 await assert.rejects(()=>s.service.send({...mail,to:['other@example.com']},'other'),/authorized/)
 s.service.config.maxPerDay=1;await assert.rejects(()=>s.service.send(mail,'new'),/limit/)
 } finally {await s.ctx.stop()}
})
test('unknown result is not retried or logged with secrets',async()=>{
 let calls=0;const s=await setup(async()=>{calls++;throw Object.assign(new Error('secret password'),{code:'ETIMEDOUT'})})
 try {
 assert.equal((await s.service.send(mail,'unknown')).status,'unknown')
 assert.equal((await s.service.send(mail,'unknown')).status,'unknown');assert.equal(calls,1)
 assert.ok(!(await s.repo.get('delivery:unknown'))!.payload.includes('secret password'))
 } finally {await s.ctx.stop()}
})
test('restart marks in-flight delivery unknown and retains claim',async()=>{
 const s=await setup()
 try {await s.repo.claim('delivery:crash','delivery',{mail});await s.repo.recover()
 assert.equal((await s.repo.get('delivery:crash'))?.status,'unknown')
 assert.equal(await s.repo.claim('delivery:crash','delivery',{mail}),false)
 } finally {await s.ctx.stop()}
})
test('dry-run uses preset and active history, never sends',async()=>{
 let calls=0,seen:any[]=[];const s=await setup(async()=>{calls++;return {accepted:[],rejected:[]}})
 try {
 mockChat(s.ctx,{shouldSend:true,reason:'有提醒',mail:{subject:'提醒',paragraphs:['正文']}},m=>seen=m)
 await s.service.saveTask(task());const r:any=await s.service.evaluate('daily')
 assert.equal(r.status,'preview');assert.ok(r.draftId);assert.equal(calls,0)
 assert.ok(JSON.stringify(seen).includes('主插件预设人格'));assert.ok(JSON.stringify(seen).includes('需要提醒'))
 assert.ok(!JSON.stringify(seen).includes('其他分支'));assert.equal(r.source.model,'platform/default')
 } finally {await s.ctx.stop()}
})
test('scheduled send, skip, invalid result and daily uniqueness',async()=>{
 let calls=0;const s=await setup(async()=>{calls++;return {accepted:['test@example.com'],rejected:[]}})
 try {
 await s.service.saveTask(task());mockChat(s.ctx,{shouldSend:false,reason:'无需提醒'})
 assert.equal((await s.service.evaluate('daily','2026-10-19') as any).status,'skipped')
 mockChat(s.ctx,{shouldSend:true,reason:'需要提醒',mail:{subject:'提醒',paragraphs:['正文']}})
 assert.equal((await s.service.evaluate('daily','2026-10-20') as any).status,'accepted')
 assert.equal((await s.service.evaluate('daily','2026-10-20') as any).status,'duplicate');assert.equal(calls,1)
 mockChat(s.ctx,{shouldSend:'true',reason:'invalid'})
 assert.equal((await s.service.evaluate('daily') as any).status,'error');assert.equal(calls,1)
 } finally {await s.ctx.stop()}
})
test('disable during model call prevents delivery',async()=>{
 const s=await setup();let resolve:any,entered:any;const ready=new Promise<void>(r=>entered=r)
 try {
 await s.service.saveTask(task());mockChat(s.ctx,{shouldSend:false,reason:'unused'})
 ;(s.ctx as any).chatluna.createChatModel=async()=>({value:{invoke:()=>{entered();return new Promise(r=>resolve=r)}}})
 const run=s.service.evaluate('daily','2026-10-19');await ready;assert.equal((await s.service.evaluate('daily') as any).status,'busy');await s.service.toggle('daily',false)
 resolve({content:JSON.stringify({shouldSend:true,reason:'send',mail:{subject:'标题',paragraphs:['正文']}})})
 const result:any=await run;assert.ok(['error','unknown'].includes(result.status))
 assert.equal((await s.repo.list('delivery')).length,0)
 } finally {await s.ctx.stop()}
})
test('scheduler ticks once and honors disabled task',async()=>{
 const s=await setup(),scheduler=new Scheduler(s.service)
 try {
 await s.service.saveTask(task());mockChat(s.ctx,{shouldSend:false,reason:'skip'})
 const at=new Date('2026-10-19T01:00:00Z');await scheduler.tick(at);await scheduler.tick(at)
 assert.equal((await s.repo.list('run')).length,1);await s.service.toggle('daily',false)
 await scheduler.tick(new Date('2026-10-20T01:00:00Z'));assert.equal((await s.repo.list('run')).length,1)
 } finally {await s.ctx.stop()}
})
test('real local SMTP receives MIME text and CID PNG',async()=>{
 let received=''
 const smtp=new SMTPServer({authOptional:true,disabledCommands:['STARTTLS'],onData(stream,_session,cb){
 stream.on('data',chunk=>received+=chunk.toString());stream.on('end',()=>cb())}})
 await new Promise<void>(r=>smtp.listen(0,'127.0.0.1',r))
 const transport=nodemailer.createTransport({host:'127.0.0.1',port:(smtp as any).server.address().port,secure:false,ignoreTLS:true})
 const s=await setup(async m=>transport.sendMail(m))
 try {
 const png=join(s.dir,'source.png')
 await writeFile(png,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=','base64'))
 const asset=await s.assets.import(png)
 assert.equal((await s.service.send({...mail,images:[{assetId:asset.id,alt:'图片',caption:'说明'}]},'mime')).status,'accepted')
 assert.match(received,/multipart\/alternative/);assert.match(received,/Content-ID: <image-0@chatluna-mail>/)
 assert.match(received,/Content-Type: image\/png/)
 await assert.rejects(()=>s.service.draft({...mail,images:[{assetId:'missing'}]}),/Unknown/)
 } finally {transport.close();await s.ctx.stop();await new Promise<void>(r=>smtp.close(r))}
})

test('task overrides preset/model and model timeout fails closed',async()=>{
 const s=await setup();let selected='',preset=''
 try {
  await s.service.saveTask({...task(),model:'another/chosen',preset:'alternate'})
  mockChat(s.ctx,{shouldSend:false,reason:'skip'})
  const cl=(s.ctx as any).chatluna
  cl.preset.getPreset=(name:string)=>{preset=name;return {value:{name}}}
  cl.createChatModel=async(name:string)=>{selected=name;return {value:{invoke:async()=>({content:'{"shouldSend":false,"reason":"skip"}'})}}}
  assert.equal((await s.service.evaluate('daily') as any).status,'skipped')
  assert.equal(selected,'another/chosen');assert.equal(preset,'alternate')
  cl.createChatModel=async()=>({value:{invoke:()=>new Promise(()=>{})}})
  assert.equal((await s.service.evaluate('daily') as any).detail,'Model timeout')
  assert.equal((await s.repo.list('delivery')).length,0)
 } finally {await s.ctx.stop()}
})
test('missing context and malformed model output fail without sending',async()=>{
 const s=await setup()
 try {
  await s.service.saveTask(task());mockChat(s.ctx,{shouldSend:false,reason:'skip'})
  const cl=(s.ctx as any).chatluna
  cl.conversation.getConversation=async()=>null
  assert.equal((await s.service.evaluate('daily') as any).detail,'Conversation unavailable or not active')
  mockChat(s.ctx,{shouldSend:false,reason:'skip'})
  ;(s.ctx as any).chatluna.createChatModel=async()=>({value:{invoke:async()=>({content:'not json'})}})
  assert.equal((await s.service.evaluate('daily') as any).errorCode,'INVALID_MODEL_JSON')
  assert.equal((await s.repo.list('delivery')).length,0)
 } finally {await s.ctx.stop()}
})
test('SMTP explicit rejection, partial acceptance and global pause',async()=>{
 const s=await setup(async()=>({accepted:['test@example.com'],rejected:['test@example.com']}))
 try {
  assert.equal((await s.service.send(mail,'partial')).status,'partial')
  s.service.stopped=true
  await assert.rejects(()=>s.service.send(mail,'paused'),/paused/)
 } finally {await s.ctx.stop()}
 const f=await setup(async()=>{throw Object.assign(new Error('sensitive'),{code:'EAUTH'})})
 try {assert.equal((await f.service.send(mail,'auth')).status,'failed')} finally {await f.ctx.stop()}
})

