import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {z} from 'zod'
import {registerModels,Repository} from '../src/repository.js'
import {Assets} from '../src/assets.js'
import {MailService} from '../src/service.js'
import {workflowSettingsSchema,WorkflowError,WorkflowPolicy,blockedTool,sameOwner} from '../src/workflow-policy.js'
import {taskSchema,type Config} from '../src/types.js'
const require=createRequire(import.meta.url)
const {Context}=require('koishi') as typeof import('koishi')
const peerRequire=createRequire(require.resolve('koishi-plugin-chatluna'))
const {DynamicStructuredTool}=peerRequire('@langchain/core/tools')
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=','base64')
const config:Config={endpoint:'/mcp/mail',token:'test-only-token-longer-than-24',enabled:true,allowAgentSend:true,allowedRecipients:['a@example.com'],smtpHost:'localhost',smtpPort:465,smtpSecure:true,smtpUser:'',smtpPassword:'private-password',from:'sender@example.com',maxPerDay:100,modelTimeoutMs:1000,maxContextChars:24000}
const taskInput={id:'workflow-task',name:'综合邮件',time:'09:00',conversationId:'conv',prompt:'搜索资料、选一首歌曲，必要时配图后写邮件',to:['a@example.com'],executionMode:'tools',tools:['search','lyrics'],workflowImages:true,enabled:false}
async function setup(){
 const ctx=new Context();ctx.plugin(require('@koishijs/plugin-database-memory').default);registerModels(ctx)
 ;(ctx.model as any).extend('medialuna_asset_cache',{contentHash:'string',cachedUrl:'string',backend:'string'},{primary:'contentHash'})
 await ctx.start()
 const repo=new Repository(ctx),dir=await mkdtemp(join(tmpdir(),'mail-070-')),assets=new Assets(join(dir,'assets'),repo)
 const cachePath=join(dir,'image.png');await writeFile(cachePath,png)
 const url='http://local.invalid/media-luna/cache/image.png'
 await (ctx.database as any).create('medialuna_asset_cache',{contentHash:'cache-id',cachedUrl:url,backend:'local'})
 const state:any={calls:[],generations:0,agents:0,mask:['search','lyrics'],authorized:true,selected:null,generate:null}
 const toolFn:Record<string,(args:any)=>Promise<string>>={search:async()=> '已核实的资料',lyrics:async()=> '歌曲：测试曲目；链接：https://example.com/song'}
 const entries:any=Object.fromEntries(['search','lyrics','send_mail_draft','draw'].map(name=>[name,{
  name,description:name,selector:()=>true,authorization:()=>state.authorized,
  createTool:()=>new DynamicStructuredTool({name,description:name,returnDirect:name==='search',schema:z.object({query:z.string().default('')}),
   func:async(args:any)=>{state.calls.push(name);return toolFn[name](args)}}),
 }]))
 Object.defineProperty(ctx,'chatluna',{configurable:true,value:{
  platform:{getToolRegistry:()=>Object.fromEntries(Object.keys(entries).map(name=>[name,{name,description:name}])),getTool:(name:string)=>entries[name],getFilteredTools:()=>state.mask},
  resolveToolMask:async()=>({mode:'allow',allow:state.mask,deny:[]}),
  conversation:{getConversation:async()=>({id:'conv',status:'active',preset:'main',model:'chosen/model',latestMessageId:'m1',bindingKey:'user:test:42'}),listMessages:async()=>[{id:'m1',role:'human',text:'今天有值得分享的新事项',createdAt:new Date()}]},
  preset:{getPreset:()=>({value:{}})},promptRenderer:{renderPresetTemplate:async()=>({messages:[['system','主插件预设']]})},
  createChatModel:async()=>({value:{invoke:async()=>{throw new Error('Context-only path must not be used')}}}),
  createAgent:async(options:any)=>{state.agents++;state.selected=options;return {generate:async(input:any)=>{
   const tools=Object.fromEntries(options.tools.map((def:any)=>[def.name,def.createTool({})]))
   return state.generate(tools,input,options)
  }}},
 }})
 const mediaTask:any={id:9,uid:7,status:'success',responseSnapshot:[{kind:'image',url}]}
 const cache:any={id:'cache-id',url,backend:'local',localPath:cachePath,size:png.length}
 Object.defineProperty(ctx,'mediaLuna',{configurable:true,value:{
  channels:{list:async()=>[{name:'art',enabled:true}]},tasks:{getById:async(id:number)=>id===9?mediaTask:null},cache:{get:async()=>cache},
  generateByName:async(args:any)=>{state.generationArgs=args;state.generations++;return {success:true,taskId:9}},
 }})
 const sent:any[]=[]
 const service=new MailService(ctx,config,repo,assets,async mail=>{sent.push(mail);return {accepted:mail.to,rejected:[]}})
 service.workflowPolicy.createSession=async()=>({user:{id:7},userId:'42',platform:'test',selfId:'bot'})
 const settings=workflowSettingsSchema.parse({enabled:true,allowedTools:['search','lyrics'],platform:'test',selfId:'bot',userId:'42',mediaImportEnabled:true,mediaOwnerId:7,mediaChannels:['art']})
 await service.workflowPolicy.save(settings,'')
 state.generate=async(tools:any)=>{
  await tools.search.invoke({query:'资料'});await tools.lyrics.invoke({query:'歌曲'})
  const image=JSON.parse(await tools.generate_mail_image.invoke({channelName:'art',prompt:'与资料相关的插画'}))
  return {output:JSON.stringify({shouldSend:true,reason:'有新事项',mail:{subject:'今日图文',paragraphs:['资料摘要与歌曲推荐'],images:[{assetId:image.assetId,alt:'配图',caption:'资料插画'}]}})}
 }
 return {ctx,repo,assets,service,state,sent,toolFn,settings,mediaTask,cache}
}
async function settings(s:Awaited<ReturnType<typeof setup>>,patch:any){const current=await s.service.workflowPolicy.settings();const {hash,...value}=current;return s.service.workflowPolicy.save({...value,...patch},hash)}
test('workflow defaults preserve old tasks, tools require explicit authorization and revisions',async()=>{
 const s=await setup()
 try{
  const old=taskSchema.parse({...taskInput,executionMode:undefined,tools:undefined,workflowImages:undefined})
  assert.equal(old.executionMode,'context');assert.deepEqual(old.tools,[]);assert.equal(old.workflowImages,false)
  assert.ok(blockedTool('draw'));assert.ok(blockedTool('send_mail_draft'));assert.ok(blockedTool('lyrics_merge'))
  await assert.rejects(()=>settings(s,{allowedTools:['send_mail_draft']}),/unavailable/)
  const current=await s.service.workflowPolicy.settings()
  const {hash,...value}=current
  const results=await Promise.allSettled([s.service.workflowPolicy.save({...value,maxSteps:5},hash),s.service.workflowPolicy.save({...value,maxSteps:4},hash)])
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1)
  await settings(s,{enabled:false})
  await assert.rejects(()=>s.service.saveTask({...taskInput,enabled:true}),/disabled/)
 }finally{await s.ctx.stop()}
})
test('search and lyrics then MediaLuna produce a real CID draft without dry-run sending',async()=>{
 const s=await setup()
 try{
  await s.service.saveTask(taskInput)
  const result:any=await s.service.evaluate(taskInput.id)
  assert.equal(result.status,'preview');assert.ok(result.draftId)
  assert.deepEqual(s.state.calls,['search','lyrics']);assert.equal(s.state.generations,1);assert.equal(s.state.agents,1);assert.equal(s.sent.length,0)
  assert.equal(s.state.selected.mode,'tool-calling');assert.equal(s.state.selected.maxSteps,10)
  assert.ok(s.state.selected.system.includes('本任务指定的工具'))
  assert.deepEqual(s.state.selected.toolMask.allow,['search','lyrics','generate_mail_image'])
  const preview=await s.service.preview(result.draftId)
  assert.equal(preview.mail.images.length,1);assert.ok(preview.html.includes('cid:image-0@chatluna-mail'))
  assert.equal((await s.assets.attachments(preview.mail))[0].content.toString('hex'),png.toString('hex'))
  assert.equal(result.source.workflow.toolCalls,3);assert.equal(result.source.workflow.generatedImages,1)
  assert.ok(!JSON.stringify(result.source.workflow).includes('已核实的资料'))
  assert.equal((await s.service.workflow.locks()).length,0)
 }finally{await s.ctx.stop()}
})
test('scheduled workflow sends once and SMTP retry never reruns tools or painting',async()=>{
 const s=await setup();let calls=0
 try{
  await s.service.saveTask({...taskInput,enabled:true})
  Object.defineProperty(s.service,'sender',{value:async(mail:any)=>{calls++;s.sent.push(mail);if(calls===1)throw Object.assign(new Error('network'),{code:'ECONNECTION'});return {accepted:mail.to,rejected:[]}}})
  const result:any=await s.service.evaluate(taskInput.id,'2026-10-20')
  assert.equal(result.status,'failed')
  assert.equal((await s.service.evaluate(taskInput.id,'2026-10-20')).status,'duplicate')
  assert.equal(s.state.agents,1);assert.equal(s.state.generations,1)
  const queued:any=await s.service.retries.queue(result.id)
  await s.service.retries.tick(new Date(queued.dueAt))
  assert.equal(calls,2);assert.equal(s.state.agents,1);assert.equal(s.state.generations,1)
  assert.equal(s.sent[0].html,s.sent[1].html)
 }finally{await s.ctx.stop()}
})
test('main tool mask, live authorization, revocation and tool budgets fail closed',async()=>{
 const s=await setup()
 try{
  await s.service.saveTask(taskInput)
  s.state.mask=['lyrics']
  assert.equal((await s.service.evaluate(taskInput.id) as any).errorCode,'WORKFLOW_TOOL_AUTHORIZATION')
  assert.equal(s.state.calls.length,0)
  s.state.mask=['search','lyrics'];s.state.authorized=false
  assert.equal((await s.service.evaluate(taskInput.id) as any).errorCode,'WORKFLOW_TOOL_AUTHORIZATION')
  s.state.authorized=true;await settings(s,{maxToolCalls:1})
  assert.equal((await s.service.evaluate(taskInput.id) as any).errorCode,'WORKFLOW_TOOL_LIMIT')
  assert.deepEqual(s.state.calls,['search']);assert.equal(s.state.generations,0)
  await settings(s,{maxToolCalls:16})
  s.toolFn.search=async()=>{s.service.stopped=true;return 'first'}
  assert.equal((await s.service.evaluate(taskInput.id) as any).errorCode,'WORKFLOW_REVOKED')
  assert.equal(s.state.generations,0);assert.equal(s.sent.length,0)
 }finally{await s.ctx.stop()}
})
test('explicit failure fallback can produce text while provider errors and oversized results stay bounded',async()=>{
 const s=await setup()
 try{
  await s.service.saveTask({...taskInput,workflowImages:false})
  s.toolFn.search=async()=>{throw new Error('private-provider-url-and-key')}
  s.state.generate=async(tools:any)=>{
   const result=await tools.search.invoke({query:'x'})
   assert.ok(!result.includes('private-provider'))
   return {output:JSON.stringify({shouldSend:true,reason:'可用资料足够',mail:{subject:'文字通知',paragraphs:['无配图'],images:[]}})}
  }
  assert.equal((await s.service.evaluate(taskInput.id) as any).errorCode,'WORKFLOW_TOOL_FAILED')
  await s.service.saveTask({...taskInput,workflowImages:false,toolFailurePolicy:'continue'})
  assert.equal((await s.service.evaluate(taskInput.id) as any).status,'preview')
  await settings(s,{maxToolResultChars:500})
  s.toolFn.search=async()=> 'x'.repeat(5000)
  s.state.generate=async(tools:any)=>{
   const result=await tools.search.invoke({query:'x'});assert.ok(result.length<=500)
   return {output:'{"shouldSend":false,"reason":"无需发送"}'}
  }
  const result:any=await s.service.evaluate(taskInput.id)
  assert.equal(result.status,'skipped');assert.equal(result.source.workflow.tools[0].status,'truncated')
 }finally{await s.ctx.stop()}
})
test('wrapped tools never return early and oversized tool arguments are rejected before execution',async()=>{
 const s=await setup()
 try{
  await s.service.saveTask(taskInput)
  let observed:any
  s.state.generate=async(tools:any)=>{
   observed=tools
   await assert.rejects(()=>tools.search.invoke({query:'x'.repeat(18000)}),(e:unknown)=>e instanceof WorkflowError&&e.code==='WORKFLOW_INPUT_LIMIT')
   return {output:'{"shouldSend":false,"reason":"无需发送"}'}
  }
  const result:any=await s.service.evaluate(taskInput.id)
  assert.equal(result.status,'skipped',JSON.stringify(result))
  assert.equal(observed.search.returnDirect,false)
  assert.equal(s.state.calls.length,0)
 }finally{await s.ctx.stop()}
})
test('image import enforces successful owned local PNG/JPEG output and deduplicates repeated requests',async()=>{
 const s=await setup()
 try{
  s.mediaTask.uid=8;await assert.rejects(()=>s.service.media.importImage(9),/another owner/)
  s.mediaTask.uid=7;s.mediaTask.status='processing';await assert.rejects(()=>s.service.media.importImage(9),/successfully/)
  s.mediaTask.status='success';s.cache.backend='s3';await assert.rejects(()=>s.service.media.importImage(9),/local cache/)
  s.cache.backend='local';s.cache.size=6*1024*1024;await assert.rejects(()=>s.service.media.importImage(9),/5 MiB/)
  s.cache.size=png.length
  const [a,b]=await Promise.all([s.service.media.importImage(9),s.service.media.importImage(9)])
  assert.equal(a.id,b.id);assert.equal((await s.assets.list()).length,1);assert.equal(a.pinned,false)
  await settings(s,{mediaImportEnabled:false})
  await assert.rejects(()=>s.service.media.importImage(9),/disabled/)
 }finally{await s.ctx.stop()}
})
test('cancelled pending external work blocks duplicate runs; restart locks require explicit review',async()=>{
 const s=await setup()
 try{
  let enter!:()=>void,finish!:()=>void
  const entered=new Promise<void>(r=>enter=r),pending=new Promise<void>(r=>finish=r)
  s.toolFn.search=async()=>{enter();await pending;return 'late'}
  s.state.generate=async(tools:any)=>{await tools.search.invoke({query:'x'});return {output:'{"shouldSend":false,"reason":"skip"}'}}
  const task=taskSchema.parse({...taskInput,workflowImages:false}),controller=new AbortController()
  const input={model:{value:{}},history:[],instructions:'task',data:{},remainingChars:20000}
  const running=s.service.workflow.run(task,input,controller.signal,async()=>{})
  await entered;controller.abort()
  await assert.rejects(()=>s.service.workflow.run(task,input,new AbortController().signal,async()=>{}),(e:unknown)=>e instanceof WorkflowError&&e.code==='WORKFLOW_PREVIOUS_UNRESOLVED')
  finish();await assert.rejects(()=>running,(e:unknown)=>e instanceof WorkflowError&&e.code==='WORKFLOW_TIMEOUT')
  assert.equal(s.state.calls.length,1);assert.equal(s.state.generations,0)
  await s.repo.put('workflow:'+task.id,'workflow-lock','running',{taskId:task.id})
  await s.service.workflow.recoverLocks()
  const lock=(await s.service.workflow.locks())[0];assert.equal(lock.status,'unknown')
  await assert.rejects(()=>s.service.workflow.resolveLock(task.id,'stale'),/changed/)
  await s.service.workflow.resolveLock(task.id,lock.hash)
  assert.equal((await s.service.workflow.locks()).length,0)
 }finally{await s.ctx.stop()}
})
test('native ChatLuna virtual session helper observes the configured identity',async()=>{
 const {buildVirtualSession}=require('koishi-plugin-chatluna/utils/virtual_session')
 let observed=false
 const session:any={observeUser:async(fields:Set<string>)=>{observed=fields.has('authority')&&fields.has('permissions')}}
 const bot:any={createDirectChannel:async(id:string)=>({id:'direct:'+id,type:1}),ctx:{emit:()=>{}},session:(event:any)=>{session.event=event;return session}}
 const result=await buildVirtualSession(bot,{platform:'test',selfId:'bot',userId:'42',isDirect:true},{message:'后台邮件'})
 assert.equal(result,session);assert.equal(session.event.user.id,'42');assert.equal(session.event.channel.id,'direct:42');assert.equal(observed,true)
})

test('native ChatLuna Agent runner executes search, lyrics and image tools with a local deterministic model',async()=>{
 const s=await setup()
 try{
  const {createAgent}=require('koishi-plugin-chatluna/llm-core/agent')
  const {computed}=peerRequire('@vue/reactivity')
  const {RunnableLambda}=peerRequire('@langchain/core/runnables')
  const {AIMessage,HumanMessage,SystemMessage}=peerRequire('@langchain/core/messages')
  const {ChatPromptValue}=peerRequire('@langchain/core/prompt_values')
  let rounds=0,nativeError:any
  const model=RunnableLambda.from(async(value:any)=>{
   rounds++
   if(rounds<=3){
    const name=['search','lyrics','generate_mail_image'][rounds-1]
    return new AIMessage({content:'',tool_calls:[{id:'call-'+rounds,type:'tool_call',name,args:rounds===3?{channelName:'art',prompt:'资料插画'}:{query:'资料'}}]})
   }
   const observations=value.messages.filter((m:any)=>m.getType()==='tool')
   assert.equal(observations.length,3)
   const image=JSON.parse(observations[2].content)
   return new AIMessage({content:JSON.stringify({shouldSend:true,reason:'原生工具执行完成',mail:{subject:'原生 Agent 验收',paragraphs:['经过搜索与曲库查询的内容'],images:[{assetId:image.assetId,alt:'插画',caption:''}]}})})
  })
  ;(s.ctx as any).chatluna.createChatModel=async()=>({value:model})
  ;(s.ctx as any).chatluna.createAgent=async(options:any)=>{
   const prompt=RunnableLambda.from(async(args:any)=>new ChatPromptValue([new SystemMessage(options.system),new HumanMessage('任务资料'),...(args.agent_scratchpad??[])]))
   prompt.preset={value:{config:{}}}
   const native=createAgent({id:options.id,name:options.name,llm:computed(()=>model),embeddings:undefined,tools:computed(()=>options.tools),prompt,mode:options.mode,maxSteps:options.maxSteps,toolMask:options.toolMask,returnIntermediateSteps:false})
   return {generate:async(input:any)=>{try{return await native.generate(input)}catch(error){nativeError=error;throw error}}}
  }
  await s.service.saveTask(taskInput)
  const result:any=await s.service.evaluate(taskInput.id)
  assert.equal(result.status,'preview',nativeError?.stack??JSON.stringify(result))
  assert.equal(rounds,4);assert.equal(result.source.workflow.modelRounds,4);assert.deepEqual(s.state.calls,['search','lyrics']);assert.equal(s.state.generations,1)
  assert.equal(result.source.workflow.toolCalls,3)
  assert.equal(s.sent.length,0)
 }finally{await s.ctx.stop()}
})


test('numeric Koishi ONLINE is accepted and every non-online state fails before session creation',async()=>{
 const {Universal}=require('koishi') as typeof import('koishi')
 let observed=0
 const bot:any={status:Universal.Status.ONLINE,createDirectChannel:async()=>({id:'direct',type:1}),ctx:{emit:()=>{}},session:()=>({observeUser:async()=>{observed++}})}
 const policy:any={ctx:{baseDir:process.cwd(),bots:{'test:bot':bot}}}
 const value=workflowSettingsSchema.parse({platform:'test',selfId:'bot',userId:'42'})
 for(const status of [Universal.Status.OFFLINE,Universal.Status.CONNECT,Universal.Status.DISCONNECT,Universal.Status.RECONNECT,undefined,'online']){
  bot.status=status
  await assert.rejects(()=>WorkflowPolicy.prototype.createSession.call(policy,value),(e:unknown)=>e instanceof WorkflowError&&e.code==='WORKFLOW_BOT_OFFLINE')
 }
 assert.equal(observed,0);bot.status=Universal.Status.ONLINE
 const session=await WorkflowPolicy.prototype.createSession.call(policy,value)
 assert.equal(observed,1);assert.deepEqual(await session.send('suppressed'),[])
})

test('owner normalization permits numeric/string zero, rejects missing and foreign IDs, and forwards image presets',async()=>{
 assert.equal(workflowSettingsSchema.parse({}).mediaOwnerId,null)
 for(const actual of [0,'0']) assert.equal(sameOwner(actual,0),true)
 for(const actual of [null,undefined,'',false,1,'1']) assert.equal(sameOwner(actual,0),false)
 assert.equal(sameOwner(undefined,null),false)
 const s=await setup()
 try{
  await assert.rejects(()=>settings(s,{mediaOwnerId:null}),/owner id is required/)
  await settings(s,{mediaOwnerId:0})
  s.mediaTask.uid='0'
  s.service.workflowPolicy.createSession=async()=>({user:{id:'0'}})
  s.state.generate=async(tools:any)=>{
   const image=JSON.parse(await tools.generate_mail_image.invoke({channelName:'art',prompt:'日记配图',presetName:'小洛'}))
   assert.ok(image.assetId)
   return {output:'{"shouldSend":false,"reason":"仅验证配图"}'}
  }
  await s.service.saveTask(taskInput)
  assert.equal((await s.service.evaluate(taskInput.id) as any).status,'skipped')
  assert.equal(s.state.generationArgs.presetName,'小洛');assert.equal(s.state.generationArgs.uid,0)
  for(const uid of [null,undefined,'1',1]){
   s.mediaTask.uid=uid
   await assert.rejects(()=>s.service.media.importImage(9),/another owner/)
   s.service.workflowPolicy.createSession=async()=>({user:{id:uid}})
   assert.equal((await s.service.evaluate(taskInput.id) as any).errorCode,'MEDIA_TASK_NOT_ALLOWED')
  }
  assert.equal(s.state.generations,1)
 }finally{await s.ctx.stop()}
})

test('tool authorization diagnostics identify each mismatched name',async()=>{
 const s=await setup()
 try{
  await assert.rejects(()=>settings(s,{allowedTools:['missing_search','wrong_lyrics']}),(e:unknown)=>e instanceof WorkflowError&&e.message.includes('missing_search')&&e.message.includes('wrong_lyrics'))
  await assert.rejects(()=>s.service.workflowPolicy.validateTask({...taskInput,tools:['missing_search','wrong_lyrics']}),(e:unknown)=>e instanceof WorkflowError&&e.message.includes('missing_search')&&e.message.includes('wrong_lyrics'))
  await s.service.saveTask(taskInput);s.state.mask=['lyrics']
  const result:any=await s.service.evaluate(taskInput.id)
  assert.equal(result.errorCode,'WORKFLOW_TOOL_AUTHORIZATION')
  assert.ok(result.detail.includes('search'))
 }finally{await s.ctx.stop()}
})
