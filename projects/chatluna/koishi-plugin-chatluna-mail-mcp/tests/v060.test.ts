import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MailModels} from '../src/models.js'
import {Repository,registerModels} from '../src/repository.js'
import {Assets} from '../src/assets.js'
import {MailService} from '../src/service.js'
import {taskSchema,type Config} from '../src/types.js'
import {daysInMonth,scheduledInstant,variableDefinitions} from '../client/task-form.js'
import {adminHandlers} from '../src/console.js'
const require=createRequire(import.meta.url)
const {Context}=require('koishi') as typeof import('koishi')
const config:Config={endpoint:'/mcp/mail',token:'test-only-token-over-24-characters',enabled:false,allowAgentSend:false,allowedRecipients:['a@example.com'],smtpHost:'localhost',smtpPort:465,smtpSecure:true,smtpUser:'',smtpPassword:'private-smtp-secret',from:'sender@example.com',maxPerDay:10,modelTimeoutMs:500,maxContextChars:24000}
async function setup(){
 const ctx=new Context();ctx.plugin(require('@koishijs/plugin-database-memory').default)
 registerModels(ctx);await ctx.start()
 const repo=new Repository(ctx),models=new MailModels(ctx,repo),chosen:string[]=[],prompts:any[]=[]
 Object.defineProperty(ctx,'chatluna',{value:{
  platform:{listAllModels:(type:number)=>{assert.equal(type,1);return {value:[
   {type:1,name:'text',platform:'adapter',toModelName:()=> 'adapter/text',apiKey:'never-return-this'},
   {type:1,name:'text',platform:'adapter',toModelName:()=> 'adapter/text'},
   {type:2,name:'embedding',platform:'adapter'},
  ]}}},
  preset:{getAllPreset:()=>({value:['main']}),getPreset:()=>({value:{}})},
  conversation:{getConversation:async()=>({id:'conv',status:'active',preset:'main',model:'conversation/model',latestMessageId:'m1'}),listMessages:async()=>[{id:'m1',role:'human',text:'new information'}]},
  promptRenderer:{renderPresetTemplate:async()=>({messages:[['system','main preset']]})},
  createChatModel:async(name:string)=>{chosen.push(name);return {value:{invoke:async(messages:any)=>{prompts.push(messages);return {content:'{"shouldSend":false,"reason":"skip"}'}}}}},
 }})
 const service=new MailService(ctx,config,repo,new Assets(await mkdtemp(join(tmpdir(),'mail-060-')),repo))
 return {ctx,repo,models,chosen,prompts,service}
}
const base={id:'task',time:'09:00',conversationId:'conv',prompt:'告知 {{person}}',to:['a@example.com'],templateId:'custom',variables:{person:'小明'}}
test('model catalog filters chat models, deduplicates and exposes no credentials or generation',async()=>{
 const s=await setup()
 try{
  const catalog=await s.models.catalog()
  assert.deepEqual(catalog.models,[{id:'adapter/text',platform:'adapter',name:'text'}])
  assert.deepEqual(catalog.presets,['main'])
  assert.ok(!JSON.stringify(catalog).includes('never-return'))
  assert.equal(s.chosen.length,0);assert.equal(s.prompts.length,0)
  const snapshot=await adminHandlers(s.service)['mail-admin/snapshot']()
  assert.ok(!JSON.stringify(snapshot).includes(config.smtpPassword))
 }finally{await s.ctx.stop()}
})
test('mail default persists, rejects missing models and serializes concurrent stale saves',async()=>{
 const s=await setup()
 try{
  await assert.rejects(()=>s.models.save({defaultModel:'missing/model'},''),/所选模型/)
  const results=await Promise.allSettled([s.models.save({defaultModel:'adapter/text'},''),s.models.save({defaultModel:''},'')])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.equal((await new MailModels(s.ctx,s.repo).settings()).defaultModel,'adapter/text')
  assert.equal(await s.models.resolve({model:'',useDefaultModel:false},'conv/model'),'conv/model')
  assert.equal(await s.models.resolve({model:'custom/model',useDefaultModel:true},'conv/model'),'custom/model')
  assert.equal(await s.models.resolve({model:'',useDefaultModel:true},'conv/model'),'adapter/text')
  const saved=await s.models.settings();await s.models.save({defaultModel:''},saved.hash)
  await assert.rejects(()=>s.models.resolve({model:'',useDefaultModel:true},'conv/model'),/尚未配置/)
 }finally{await s.ctx.stop()}
})
test('decision uses selected default once and substitutes card values in task prompt',async()=>{
 const s=await setup()
 try{
  await s.service.templates.save({id:'custom',name:'custom',prompt:'写给 {{person}}',fields:{person:{required:true,default:''}}},0)
  await s.service.models.save({defaultModel:'adapter/text'},'')
  await s.service.decision.evaluate(taskSchema.parse({...base,useDefaultModel:true}),[],[])
  assert.deepEqual(s.chosen,['adapter/text']);assert.equal(s.prompts.length,1)
  const text=JSON.stringify(s.prompts[0])
  assert.ok(text.includes('告知 小明'));assert.ok(!text.includes('{{person}}'))
  await s.service.decision.inspect(taskSchema.parse(base),[],[])
  assert.equal(s.chosen[1],'conversation/model');assert.equal(s.prompts.length,1)
 }finally{await s.ctx.stop()}
})
test('date dropdown conversion honors zone, month length and rejects nonexistent DST time',()=>{
 assert.equal(daysInMonth(2028,2),29);assert.equal(daysInMonth(2026,2),28)
 assert.equal(scheduledInstant({year:'2026',month:'10',day:'20'},'09:05','Asia/Shanghai'),'2026-10-20T01:05:00.000Z')
 assert.equal(scheduledInstant({year:'2026',month:'10',day:'20'},'09:05','America/New_York'),'2026-10-20T13:05:00.000Z')
 assert.throws(()=>scheduledInstant({year:'2026',month:'02',day:'30'},'09:00','UTC'),/有效日期/)
 assert.throws(()=>scheduledInstant({year:'2026',month:'03',day:'08'},'02:30','America/New_York'),/不存在/)
})
test('variable cards reject duplicate or invalid names and preserve defaults',()=>{
 assert.deepEqual(variableDefinitions([{name:'person',required:true,default:'读者'}]),{person:{required:true,default:'读者'}})
 assert.throws(()=>variableDefinitions([{name:'person',required:false,default:''},{name:'person',required:true,default:''}]),/重复/)
 assert.throws(()=>variableDefinitions([{name:'中文名',required:false,default:''}]),/变量名称/)
 const old=taskSchema.parse({...base,prompt:'test'})
 assert.equal(old.name,'');assert.equal(old.useDefaultModel,false)
})

test('old stored task hash remains authorized until the task changes',async()=>{
 const s=await setup()
 try{
  s.service.config.enabled=true
  const parsed=taskSchema.parse({...base,templateId:'briefing',prompt:'test',enabled:true})
  const {name,useDefaultModel,...legacy}=parsed
  const old=await s.repo.put('task:task','task','enabled',legacy)
  await s.service.checkOrigin({kind:'task',taskId:'task',taskHash:old.hash,autoRetry:false})
  await s.service.saveTask({...legacy,prompt:'changed'},old.hash)
  await assert.rejects(()=>s.service.checkOrigin({kind:'task',taskId:'task',taskHash:old.hash,autoRetry:false}),/Task changed/)
 }finally{await s.ctx.stop()}
})
