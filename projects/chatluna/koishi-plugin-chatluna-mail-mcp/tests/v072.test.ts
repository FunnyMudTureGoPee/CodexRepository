import test from 'node:test'
import assert from 'node:assert/strict'
import {gzipSync} from 'node:zlib'
import {randomBytes} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {selectHistory,auditHistoryStorage} from '../src/history-selection.js'
import {ContextReadError,MAX_MESSAGE_BYTES,type HistoryRecord} from '../src/history.js'
import {Repository,registerModels} from '../src/repository.js'
import {MailService} from '../src/service.js'
import {Assets} from '../src/assets.js'
import {taskSchema,type Config} from '../src/types.js'
const require=createRequire(import.meta.url),{Context}=require('koishi') as typeof import('koishi')
const zip=(v:unknown)=>gzipSync(JSON.stringify(v))
const policy={contextMode:'recent' as const,historyLimit:2,minNewMessages:0}
const oversized=zip(randomBytes(1100000).toString('base64'))
const row=(id:string,text:string):HistoryRecord=>({id,role:'human',text,createdAt:new Date()})

test('old oversized or corrupt rows are never decoded once the newest readable window is full',async()=>{
 const old:any={id:'old',role:'human',get content(){throw new Error('Out-of-range content must not be touched')}}
 const selected=await selectHistory([old,row('one','one'),row('two','two')],policy)
 assert.deepEqual(selected.selected.map(r=>r.id),['one','two'])
 assert.equal(selected.selection.uninspectedRows,1);assert.equal(selected.selection.countsAreLowerBounds,true)
 assert.equal(selected.selection.availableTextMessagesExact,false)
})

test('historyLimit counts readable messages through image-only, blank and multimodal rows',async()=>{
 const rows:HistoryRecord[]=[{id:'old',role:'human',content:oversized},row('one','first'),{id:'image',role:'ai',content:zip([{type:'image_url',image_url:{url:'private-image'}}])},row('empty','  '),{id:'two',role:'ai',content:zip([{type:'text',text:'second'},{type:'image_url',image_url:{url:'private-image'}}])}]
 const result=await selectHistory(rows,policy)
 assert.deepEqual(result.selected.map(r=>r.text),['first','second'])
 assert.equal(result.selection.inspectedRows,4);assert.equal(result.contextStorage.nonTextMessages,2)
})

test('since-last-send excludes the checkpoint and every earlier row before decoding',async()=>{
 const result=await selectHistory([{id:'old',role:'human',content:oversized},{id:'cp',role:'ai',content:oversized},row('new','new')],{...policy,contextMode:'since-last-send'},'cp')
 assert.deepEqual(result.selected.map(r=>r.id),['new']);assert.equal(result.newMessages,1)
 assert.equal(result.selection.excludedByCheckpointRows,2);assert.equal(result.selection.newMessagesExact,true)
 const initial=await selectHistory([{id:'old',role:'human',content:oversized},row('one','one'),row('two','two')],{...policy,contextMode:'since-last-send'})
 assert.equal(initial.selected.length,2)
})

test('checkpoint membership errors precede decoding and recent mode still tolerates an unused missing checkpoint',async()=>{
 const rows=[{id:'old',role:'human',content:oversized},row('one','one'),row('two','two')]
 for(const extra of [{contextMode:'since-last-send' as const},{minNewMessages:1}])
  await assert.rejects(()=>selectHistory(rows,{...policy,...extra},'missing'),/checkpoint/)
 const result=await selectHistory(rows,policy,'missing')
 assert.equal(result.newMessages,null);assert.equal(result.selected.length,2)
})

test('minNewMessages can require more readable messages than historyLimit without counting raw rows',async()=>{
 const rows=[{id:'old',role:'human',content:oversized},row('cp','cp'),row('one','one'),{id:'image',role:'ai',content:zip([{type:'image_url'}])},row('two','two'),row('three','three')]
 const result=await selectHistory(rows,{contextMode:'since-last-send',historyLimit:1,minNewMessages:3},'cp')
 assert.equal(result.newMessages,3);assert.deepEqual(result.selected.map(r=>r.id),['three']);assert.equal(result.selection.inspectedRows,4)
 const insufficient=await selectHistory(rows.slice(0,-1),{contextMode:'since-last-send',historyLimit:1,minNewMessages:3},'cp')
 assert.equal(insufficient.newMessages,2);assert.equal(insufficient.selection.newMessagesExact,true)
})

test('selected compressed and decompressed limits stay strict and expose metadata without body data',async()=>{
 assert.ok(oversized.length>MAX_MESSAGE_BYTES)
 for(const content of [oversized,oversized.toString('base64'),'A'.repeat(MAX_MESSAGE_BYTES*2+1),zip('private-body'.repeat(120000))]){
  await assert.rejects(()=>selectHistory([{id:'bad-message',role:'ai',content}],policy),(error:unknown)=>{
   assert.ok(error instanceof ContextReadError);assert.equal(error.code,'CONTEXT_STORAGE_LIMIT')
   assert.equal(error.details?.messageId,'bad-message');assert.equal(error.details?.role,'ai')
   assert.ok(!JSON.stringify(error.details).includes('private-body'));return true
  })
 }
})

test('cumulative 8 MiB protection applies across the inspected window and excludes untouched old history',async()=>{
 const rows=Array.from({length:10},(_,i)=>({...row(String(i),''),content:zip('x'.repeat(900000))}))
 await assert.rejects(()=>selectHistory(rows,{...policy,historyLimit:10}),(e:unknown)=>e instanceof ContextReadError&&e.code==='CONTEXT_STORAGE_LIMIT'&&e.message.includes('decoded history'))
 const result=await selectHistory(rows,policy)
 assert.equal(result.selected.length,2);assert.equal(result.contextStorage.decodedBytes,1800004)
})

async function fixture(rows:HistoryRecord[]){
 const ctx=new Context();ctx.plugin(require('@koishijs/plugin-database-memory').default);registerModels(ctx);await ctx.start()
 const state={modelCalls:0,sends:0,workflowCalls:0,presetCalls:0,captured:''}
 Object.defineProperty(ctx,'chatluna',{value:{
  conversation:{getConversation:async()=>({id:'conv',status:'active',preset:'main',model:'chosen/model',latestMessageId:rows.at(-1)?.id}),listMessages:async()=>rows},
  preset:{getPreset:()=>{state.presetCalls++;return {value:{}}}},promptRenderer:{renderPresetTemplate:async()=>({messages:[]})},
  createChatModel:async()=>({value:{invoke:async(input:any)=>{state.modelCalls++;state.captured=JSON.stringify(input);return {content:'{"shouldSend":true,"reason":"新事项","mail":{"subject":"测试","paragraphs":["正文"],"images":[]}}'}}}}),
 }})
 for(let i=0;i<rows.length;i++)rows[i].parentId=i?rows[i-1].id:null
 const config:Config={endpoint:'/mcp/mail',token:'test-only-token-at-least-24',enabled:true,allowAgentSend:false,allowedRecipients:['test@example.com'],smtpHost:'localhost',smtpPort:465,smtpSecure:true,smtpUser:'',smtpPassword:'',from:'sender@example.com',maxPerDay:10,modelTimeoutMs:1000,maxContextChars:24000}
 const repo=new Repository(ctx),service=new MailService(ctx,config,repo,new Assets(await mkdtemp(join(tmpdir(),'mail-072-')),repo),async()=>{state.sends++;return {accepted:['test@example.com'],rejected:[]}})
 const task=taskSchema.parse({id:'task',time:'09:00',conversationId:'conv',prompt:'判断新事项',to:['test@example.com'],historyLimit:2})
 await service.saveTask(task)
 return {ctx,state,repo,service,task}
}

test('diagnose succeeds and dry-run invokes one model without sending after excluding an oversized old row',async()=>{
 const s=await fixture([{id:'old',role:'human',content:oversized},row('one','first-new'),row('two','second-new')])
 try{
  const info=await s.service.diagnose('task');assert.equal(info.historyCount,2);assert.equal(s.state.modelCalls,0)
  const result:any=await s.service.evaluate('task');assert.equal(result.status,'preview');assert.equal(result.decision.shouldSend,true)
  assert.equal(s.state.modelCalls,1);assert.equal(s.state.sends,0);assert.ok(s.state.captured.includes('first-new'))
 }finally{await s.ctx.stop()}
})

test('selected oversized context is an execution error, never shouldSend=false or a model 503',async()=>{
 const s=await fixture([{id:'selected-bad',role:'human',content:oversized}])
 try{
  await assert.rejects(()=>s.service.diagnose('task'),(e:unknown)=>e instanceof ContextReadError&&e.details?.messageId==='selected-bad')
  const result:any=await s.service.evaluate('task')
  assert.equal(result.status,'error');assert.equal(result.errorCode,'CONTEXT_STORAGE_LIMIT');assert.equal(result.decision,undefined)
  assert.equal(result.contextError.messageId,'selected-bad');assert.equal(s.state.modelCalls,0);assert.equal(s.state.sends,0)
  const records=await s.repo.list('run');assert.equal(records.at(-1)?.status,'error')
 }finally{await s.ctx.stop()}
})

test('unchanged since-last-send skips without decoding an oversized checkpoint or executing paid tools',async()=>{
 const s=await fixture([{id:'cp',role:'human',content:oversized}])
 try{
  await s.service.saveTask({...s.task,contextMode:'since-last-send',contextMaxAgeHours:24,executionMode:'tools',workflowImages:true})
  await s.repo.put('run:previous','run','accepted',{taskId:'task',source:{latestMessageId:'cp'}})
  s.service.workflow.inspect=async()=>({configured:true}) as any
  s.service.workflow.run=async()=>{s.state.workflowCalls++;throw new Error('Must not call tools')}
  const info=await s.service.diagnose('task');assert.equal(info.eligible,false)
  const result:any=await s.service.evaluate('task');assert.equal(result.status,'skipped');assert.equal(result.source.modelInvoked,false)
  assert.equal(s.state.modelCalls,0);assert.equal(s.state.workflowCalls,0);assert.equal(s.state.sends,0)
 }finally{await s.ctx.stop()}
})

test('freshness uses the newest selected readable message and does not filter earlier candidates by date',async()=>{
 const s=await fixture([{...row('old-readable','keep-old'),createdAt:new Date(Date.now()-72*3600000)},row('new-readable','new')])
 try{
  await s.service.saveTask({...s.task,contextMaxAgeHours:24})
  const info=await s.service.diagnose('task');assert.equal(info.historyCount,2)
  await s.service.evaluate('task');assert.ok(s.state.captured.includes('keep-old'))
 }finally{await s.ctx.stop()}
})

test('storage-only audit locates oversized active messages without decoding, model lookup or exposing bodies',async()=>{
 const s=await fixture([{id:'old',role:'human',content:oversized},row('cp','cp'),row('new','private-text')])
 try{
  await s.service.saveTask({...s.task,contextMode:'since-last-send'})
  await s.repo.put('run:previous','run','accepted',{taskId:'task',source:{latestMessageId:'cp'}})
  const result=await s.service.auditContextStorage('task')
  assert.equal(result.oversizedCount,1);assert.equal(result.oversizedMessages[0].messageId,'old')
  assert.equal(result.oversizedMessages[0].compressedBytes,oversized.length);assert.equal(result.oversizedMessages[0].excludedByCheckpoint,true)
  assert.equal(result.decoded,false);assert.equal(s.state.presetCalls,0);assert.equal(s.state.modelCalls,0)
  assert.ok(!JSON.stringify(result).includes('private-text'))
  const capped=auditHistoryStorage(Array.from({length:105},(_,i)=>({id:String(i),role:'ai',content:oversized})),policy)
  assert.equal(capped.oversizedMessages.length,100);assert.equal(capped.truncated,true)
 }finally{await s.ctx.stop()}
})


test('best-effort mode rescues a selected oversized compressed message, keeps excerpts and completes a dry-run',async()=>{
 const s=await fixture([{id:'large-selected',role:'human',content:oversized},row('new','new facts')])
 try{
  await s.service.saveTask({...s.task,contextOverflow:'trim-oldest'})
  const info=await s.service.diagnose('task')
  assert.equal(info.contextStorage.rescuedMessages,1);assert.equal(info.historyCount,2)
  assert.ok(info.contextStorage.compactions[0].originalChars>MAX_MESSAGE_BYTES)
  assert.equal(s.state.modelCalls,0)
  const result:any=await s.service.evaluate('task')
  assert.equal(result.status,'preview');assert.equal(s.state.modelCalls,1);assert.equal(s.state.sends,0)
  assert.ok(s.state.captured.includes('有损摘录'));assert.ok(s.state.captured.includes('new facts'))
  assert.ok(result.source.contextChars<=s.service.config.maxContextChars)
 }finally{await s.ctx.stop()}
})

test('best-effort legacy text compacts across head, middle and tail rather than refusing or taking only the prefix',async()=>{
 const text='HEAD FACT\n'+'a'.repeat(1100000)+'\nTAIL FACT'
 const s=await fixture([row('large-legacy',text)])
 try{
  await s.service.saveTask({...s.task,contextOverflow:'trim-oldest'})
  const result:any=await s.service.evaluate('task')
  assert.equal(result.status,'preview');assert.ok(s.state.captured.includes('HEAD FACT'));assert.ok(s.state.captured.includes('TAIL FACT'))
  assert.ok(result.source.contextStorage.compactions.length>0);assert.equal(s.state.sends,0)
 }finally{await s.ctx.stop()}
})

test('hard rescue limits degrade with an explicit warning when other readable facts exist; no facts still errors',async()=>{
 const hard=zip([{type:'image_url',image_url:{url:'x'.repeat(17*1024*1024)}}])
 const s=await fixture([{id:'hard',role:'human',content:hard},row('good','actual readable facts')])
 try{
  await s.service.saveTask({...s.task,contextOverflow:'trim-oldest'})
  const result:any=await s.service.evaluate('task')
  assert.equal(result.status,'preview');assert.equal(result.source.contextStorage.unreadableMessages[0].messageId,'hard')
  assert.equal(result.source.historySelection.countsAreLowerBounds,true);assert.ok(s.state.captured.includes('读取失败'))
  assert.equal(s.state.modelCalls,1);assert.equal(s.state.sends,0)
  await s.service.saveTask({...s.task,contextOverflow:'trim-oldest',minNewMessages:2})
  const insufficient:any=await s.service.evaluate('task')
  assert.equal(insufficient.status,'error');assert.equal(insufficient.decision,undefined);assert.equal(s.state.modelCalls,1)
 }finally{await s.ctx.stop()}
 const empty=await fixture([{id:'hard-only',role:'human',content:hard}])
 try{
  await empty.service.saveTask({...empty.task,contextOverflow:'trim-oldest'})
  assert.equal((await empty.service.evaluate('task') as any).status,'error');assert.equal(empty.state.modelCalls,0)
 }finally{await empty.ctx.stop()}
})


test('multimodal rescue extracts text after a large image block and reserves workflow budget',async()=>{
 const s=await fixture([{id:'large-image',role:'human',content:zip([{type:'image_url',image_url:{url:'x'.repeat(2*1024*1024)}},{type:'text',text:'TEXT AFTER IMAGE'}])}])
 try{
  await s.service.saveTask({...s.task,contextOverflow:'trim-oldest'})
  const info=await s.service.diagnose('task');assert.equal(info.contextStorage.rescuedMessages,1)
  const result:any=await s.service.evaluate('task');assert.equal(result.status,'preview');assert.ok(s.state.captured.includes('TEXT AFTER IMAGE'))
  const task={...s.task,executionMode:'tools' as const,tools:['search'],contextOverflow:'trim-oldest' as const}
  s.service.workflow.inspect=async()=>({configured:true}) as any
  const diagnostic=await s.service.decision.inspect(task,[],[])
  assert.equal(diagnostic.reservedWorkflowChars,8000);assert.ok(diagnostic.contextChars<=diagnostic.historyCharacterBudget)
 }finally{await s.ctx.stop()}
})


test('failed best-effort inflation also consumes the shared rescue work budget',async()=>{
 const hard=zip('x'.repeat(17*1024*1024))
 const rows=[...Array.from({length:5},(_,i)=>({id:'hard-'+i,role:'human',content:hard})),row('good','real facts')]
 const result=await selectHistory(rows,{...policy,contextOverflow:'trim-oldest'})
 assert.equal(result.selected.length,1);assert.equal(result.contextStorage.unreadableMessages.length,5)
 assert.equal(result.contextStorage.decodeBudgetBytes,32*1024*1024)
})


test('missing multimodal checkpoint recovers only later same-conversation rows and warns without sending',async()=>{
 const cutoff=new Date(Date.now()-60000).toISOString()
 const s=await fixture([{...row('old','already mailed'),createdAt:new Date(Date.now()-120000)},{id:'summary',role:'system',name:'infinite_context',text:'already mailed summary',createdAt:new Date()},
  {id:'image-new',role:'human',content:zip([{type:'image_url',image_url:{url:'private-image'}}]),createdAt:new Date()},row('new','NEW FACTS')])
 try{
  await s.service.saveTask({...s.task,contextMode:'since-last-send'})
  await s.repo.put('run:previous','run','accepted',{taskId:'task',source:{conversationId:'conv',latestMessageId:'deleted-image',latestMessageAt:cutoff}})
  const info=await s.service.diagnose('task')
  assert.equal(info.historySelection.checkpointRecovery.mode,'timestamp-recovered');assert.equal(info.historyCount,1)
  assert.equal(s.state.modelCalls,0);assert.ok(info.contextWarnings.length)
  const result:any=await s.service.evaluate('task')
  assert.equal(result.status,'preview');assert.equal(s.state.modelCalls,1);assert.equal(s.state.sends,0)
  assert.ok(s.state.captured.includes('NEW FACTS'));assert.ok(!s.state.captured.includes('already mailed'));assert.ok(!s.state.captured.includes('private-image'))
  assert.ok(result.source.latestMessageAt)
 }finally{await s.ctx.stop()}
})

test('removed checkpoint with only old text and newer image-only content skips without generation',async()=>{
 const cutoff=new Date(Date.now()-60000).toISOString()
 const s=await fixture([{...row('old','already mailed'),createdAt:new Date(Date.now()-120000)},
  {id:'image-new',role:'human',content:zip([{type:'image_url'}]),createdAt:new Date()}])
 try{
  await s.service.saveTask({...s.task,contextMode:'since-last-send'})
  await s.repo.put('run:previous','run','accepted',{taskId:'task',source:{conversationId:'conv',latestMessageId:'deleted-image',latestMessageAt:cutoff}})
  const result:any=await s.service.evaluate('task')
  assert.equal(result.status,'skipped');assert.equal(s.state.modelCalls,0);assert.equal(s.state.sends,0)
  assert.equal(result.source.newMessages,0)
 }finally{await s.ctx.stop()}
})

test('0.7.2 accepted-run metadata provides an explicit legacy recovery boundary',async()=>{
 const s=await fixture([row('new','new facts')])
 try{
  await s.service.saveTask({...s.task,contextMode:'since-last-send',minNewMessages:1})
  await s.repo.put('run:old','run','accepted',{taskId:'task',source:{conversationId:'conv',latestMessageId:'removed'}})
  await s.ctx.database.set('chatluna_mail',{id:'run:old'},{createdAt:new Date(Date.now()-60000)})
  const info=await s.service.diagnose('task')
  assert.equal(info.eligible,true);assert.equal(info.historySelection.checkpointRecovery.timeBasis,'run-start')
  assert.ok(info.contextWarnings[0].includes('重叠'))
 }finally{await s.ctx.stop()}
})

test('a task rebound to another conversation does not inherit its previous conversation checkpoint',async()=>{
 const s=await fixture([row('new','new-conversation facts')])
 try{
  await s.service.saveTask({...s.task,contextMode:'since-last-send'})
  await s.repo.put('run:old','run','accepted',{taskId:'task',source:{conversationId:'another-conversation',latestMessageId:'missing'}})
  const info=await s.service.diagnose('task')
  assert.equal(info.checkpoint,null);assert.equal(info.historyCount,1);assert.equal(info.historySelection.checkpointRecovery.mode,'initial')
 }finally{await s.ctx.stop()}
})

test('a late retry cannot move the checkpoint behind a newer completed run',async()=>{
 const s=await fixture([row('new','new facts')])
 try{
  const previous=new Date(Date.now()-120000),latest=new Date(Date.now()-60000)
  await s.repo.put('run:old','run','accepted',{taskId:'task',source:{conversationId:'conv',latestMessageId:'old-removed'}})
  await s.ctx.database.set('chatluna_mail',{id:'run:old'},{createdAt:previous,updatedAt:new Date()})
  await s.repo.put('run:new','run','accepted',{taskId:'task',source:{conversationId:'conv',latestMessageId:'new'}})
  await s.ctx.database.set('chatluna_mail',{id:'run:new'},{createdAt:latest,updatedAt:latest})
  assert.equal(await s.service.checkpoint('task'),'new')
 }finally{await s.ctx.stop()}
})

test('timestamp recovery refuses unknown dates instead of treating old history as new',async()=>{
 await assert.rejects(()=>selectHistory([{id:'unknown',role:'human',text:'unknown date'}],{...policy,contextMode:'since-last-send'},
  {messageId:'missing',conversationId:'conv',at:new Date().toISOString(),timeBasis:'message-created-at'}),(e:unknown)=>e instanceof ContextReadError&&e.code==='CONTEXT_CHECKPOINT_UNRESOLVED')
})
