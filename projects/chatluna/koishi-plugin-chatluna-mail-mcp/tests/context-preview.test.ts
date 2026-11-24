import test from 'node:test'
import assert from 'node:assert/strict'
import {gzipSync} from 'node:zlib'
import {createRequire} from 'node:module'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {contextPreviewSchema,previewHistory} from '../src/context-preview.js'
import type {HistoryRecord} from '../src/history.js'
import {Repository,registerModels} from '../src/repository.js'
import {MailService} from '../src/service.js'
import {Assets} from '../src/assets.js'
import {taskSchema,type Config} from '../src/types.js'
import {adminHandlers,registerConsole} from '../src/console.js'
const require=createRequire(import.meta.url),{Context}=require('koishi') as typeof import('koishi')
const now=new Date('2026-10-26T10:00:00Z')
const row=(id:string,hours:number,text=id):HistoryRecord=>({id,role:'human',text,createdAt:new Date(+now-hours*3600000)})
const request={id:'task',mode:'hours' as const,hours:6}

test('preview applies time before readable-message count and never decodes excluded old content',async()=>{
 const old={...row('old',7),get content():never{throw new Error('Excluded storage must not be decoded')}}
 const image={...row('image',1),text:null,content:gzipSync(JSON.stringify([{type:'image_url',image_url:{url:'data:image/png;base64,private-image'}}]))}
 const result=await previewHistory([old,row('boundary',6),row('one',5),row('two',2),image,row('three',0),row('future',-1)],request,null,2,24000,now)
 assert.deepEqual(result.history.map(r=>r.id),['two','three'])
 assert.equal(result.candidateRows,4);assert.equal(result.contextStorage.nonTextMessages,1)
 assert.ok(!JSON.stringify(result).includes('private-image'));assert.equal(result.historyLimit,2)
})

test('empty/image-only windows return readable empty previews, not a shouldSend decision',async()=>{
 const image={...row('image',1),text:null,content:gzipSync(JSON.stringify([{type:'image_url',image_url:{url:'private-image'}}]))}
 for(const rows of [[],[row('too-old',8)],[image]]){
  const result=await previewHistory(rows,request,null,60,24000,now)
  assert.equal(result.historyCount,0);assert.equal((result as any).decision,undefined)
 }
})

test('custom time offsets and unknown dates have explicit bounded semantics',async()=>{
 const custom=contextPreviewSchema.parse({id:'task',mode:'custom',start:'2026-10-26T12:00:00+08:00',end:'2026-10-26T16:00:00+08:00'})
 const result=await previewHistory([row('early',7),row('in',3),row('late',1),{id:'unknown',role:'human',text:'unknown date'},{...row('summary',3),name:'infinite_context'}],custom,null,60,24000,now)
 assert.deepEqual(result.history.map(r=>r.id),['in']);assert.equal(result.unknownDateRows,1);assert.equal(result.summaryRows,1)
 assert.ok(result.warnings.some(w=>w.includes('摘要')));assert.ok(result.warnings.some(w=>w.includes('有效时间')))
 for(const [start,end] of [['2026-10-26T10:00:00Z','2026-10-26T09:00:00Z'],['2026-10-26T09:00:00Z','2026-10-26T11:00:00Z']])
  await assert.rejects(()=>previewHistory([],{id:'task',mode:'custom',start,end},null,60,24000,now),/range/)
 assert.equal(contextPreviewSchema.safeParse({...request,hours:0}).success,false)
 assert.equal(contextPreviewSchema.safeParse({...request,historyLimit:201}).success,false)
 assert.equal(contextPreviewSchema.safeParse({...request,send:true}).success,false)
})

test('selected large text is rescued and stays within the preview character budget',async()=>{
 const result=await previewHistory([{...row('large',2),text:null,content:gzipSync(JSON.stringify('begin-'+ 'x'.repeat(2*1024*1024)+'-end'))},row('small',1,'recent fact')],request,null,60,3000,now)
 assert.equal(result.historyCount,2);assert.ok(result.contextChars<=3000)
 assert.ok(result.contextStorage.compactions.length);assert.ok(result.warnings.some(w=>w.includes('有损')))
 assert.ok(result.history[0].text.includes('begin'));assert.ok(result.history[0].text.includes('end'))
})

test('escaped control text still receives a bounded last-message rescue',async()=>{
 const result=await previewHistory([row('control',1,'prefix'+String.fromCharCode(1).repeat(4000)+'suffix')],request,null,1,1334,now)
 assert.equal(result.historyCount,1);assert.ok(result.contextChars<=1334)
 assert.ok(result.contextStorage.compactions.some(c=>c.strategy==='preview-escaped-character-budget'))
})

async function fixture(){
 const ctx=new Context();ctx.plugin(require('@koishijs/plugin-database-memory').default);registerModels(ctx);await ctx.start()
 const root=await mkdtemp(join(tmpdir(),'mail-context-preview-'))
 const rows=[{id:'old',parentId:null,role:'human',text:'old',createdAt:new Date(Date.now()-8*3600000)},{id:'new',parentId:'old',role:'human',text:'new',createdAt:new Date(Date.now()-3600000)}]
 const forbidden=()=>{throw new Error('Preview must not access models, presets or tools')}
 Object.defineProperty(ctx,'chatluna',{value:{conversation:{getConversation:async()=>({id:'conv',status:'active',latestMessageId:'new'}),listMessages:async()=>rows},createChatModel:forbidden,preset:{getPreset:forbidden},promptRenderer:{renderPresetTemplate:forbidden}}})
 const config:Config={endpoint:'/mcp/mail',token:'test-only-token-at-least-24',enabled:true,allowAgentSend:false,allowedRecipients:['test@example.com'],smtpHost:'localhost',smtpPort:465,smtpSecure:true,smtpUser:'',smtpPassword:'',from:'sender@example.com',maxPerDay:10,modelTimeoutMs:1000,maxContextChars:24000}
 const repo=new Repository(ctx),service=new MailService(ctx,config,repo,new Assets(root,repo),async()=>{throw new Error('Preview must not send')})
 service.workflow.run=forbidden;service.workflow.inspect=forbidden
 await service.saveTask(taskSchema.parse({id:'task',time:'09:00',conversationId:'conv',prompt:'write',to:['test@example.com'],executionMode:'tools',workflowImages:true,minNewMessages:100,contextMaxAgeHours:1,contextMode:'since-last-send'}))
 return {ctx,repo,service,stop:async()=>{await ctx.stop();await rm(root,{recursive:true,force:true})}}
}

test('admin preview is authority 4 and does not write task/run/draft/progress or invoke any model/tool',async()=>{
 const s=await fixture()
 try{
  const before=JSON.stringify(await s.ctx.database.get('chatluna_mail',{}))
  const result=await adminHandlers(s.service)['mail-admin/context-preview'](request)
  assert.equal(result.historyCount,1);assert.deepEqual(result.effects,{modelInvoked:false,toolsInvoked:false,mailSent:false,progressUpdated:false})
  assert.equal(JSON.stringify(await s.ctx.database.get('chatluna_mail',{})),before)
  const permissions=new Map<string,any>()
  registerConsole({console:{addEntry:()=>{},addListener:(name:string,_fn:unknown,options:unknown)=>permissions.set(name,options)}} as any,s.service,'/isolated-preview')
  assert.equal(permissions.get('mail-admin/context-preview').authority,4)
 }finally{await s.stop()}
})

test('event windows use successful same-conversation events; errors and no-new skips do not advance evaluation baseline',async()=>{
 const s=await fixture()
 try{
  const at=new Date(Date.now()-2*3600000).toISOString()
  await s.repo.put('run:sent','run','accepted',{taskId:'task',source:{conversationId:'conv',contextCapturedAt:at,modelInvoked:true}})
  await s.repo.put('run:error','run','error',{taskId:'task',source:{conversationId:'conv',modelInvoked:false}})
  await s.repo.put('run:no-new','run','skipped',{taskId:'task',source:{conversationId:'conv',modelInvoked:false}})
  await s.repo.put('run:other','run','accepted',{taskId:'task',source:{conversationId:'another',contextCapturedAt:new Date().toISOString(),modelInvoked:true}})
  for(const mode of ['since-send','since-evaluation'] as const){
   const result=await s.service.previewContext({id:'task',mode})
   assert.equal(result.range.baseline?.runId,'run:sent');assert.equal(result.range.start,at)
   assert.equal(result.range.baseline?.approximate,false);assert.deepEqual(result.history.map(r=>r.id),['new'])
  }
  await s.repo.put('run:judged','run','skipped',{taskId:'task',source:{conversationId:'conv',contextCapturedAt:at,modelInvoked:true}})
  // Deterministic run order even when the memory DB clock has millisecond ties.
  await s.ctx.database.set('chatluna_mail',{id:'run:judged'},{createdAt:new Date(Date.now()+100)})
  const judged=await s.service.previewContext({id:'task',mode:'since-evaluation'})
  assert.equal(judged.range.baseline?.runId,'run:judged')
  assert.equal((await s.service.previewContext({id:'task',mode:'since-send'})).range.baseline?.runId,'run:sent')
 }finally{await s.stop()}
})

test('missing/legacy baselines and partial history are disclosed rather than failing on missing message IDs',async()=>{
 const s=await fixture()
 try{
  const initial=await s.service.previewContext({id:'task',mode:'since-send'})
  assert.equal(initial.range.start,null);assert.ok(initial.warnings.some(w=>w.includes('未找到')))
  const at=new Date(Date.now()-12*3600000).toISOString()
  await s.repo.put('run:legacy','run','accepted',{taskId:'task',source:{conversationId:'conv',latestMessageId:'deleted-by-compression',latestMessageAt:at}})
  const recovered=await s.service.previewContext({id:'task',mode:'since-send'})
  assert.equal(recovered.range.start,at);assert.equal(recovered.range.baseline?.approximate,true)
  assert.ok(recovered.warnings.some(w=>w.includes('无法保证窗口完整')));assert.equal(recovered.historyCount,2)
 }finally{await s.stop()}
})
