import test from 'node:test'
import assert from 'node:assert/strict'
import {gzipSync} from 'node:zlib'
import {createRequire} from 'node:module'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {decodeHistory,ContextReadError} from '../src/history.js'
import {activeHistory} from '../src/context.js'
import {Repository,registerModels} from '../src/repository.js'
import {Assets} from '../src/assets.js'
import {MailService} from '../src/service.js'
import {taskSchema,type Config} from '../src/types.js'
const require=createRequire(import.meta.url)
const {Context}=require('koishi') as typeof import('koishi')
const zipped=(v:unknown)=>gzipSync(JSON.stringify(v))
test('ChatLuna gzip JSON content works with Buffer, ArrayBuffer, offset views and base64',async()=>{
 const bytes=zipped('正式消息'),padded=Buffer.concat([Buffer.from('padding'),bytes,Buffer.from('padding')])
 const inputs=[bytes,Uint8Array.from(bytes).buffer,new DataView(padded.buffer,padded.byteOffset+7,bytes.length),bytes.toString('base64')]
 for(const content of inputs){
  const decoded=await decodeHistory([{id:'1',role:'human',text:null,content}])
  assert.equal(decoded.messages[0].text,'正式消息');assert.equal(decoded.stats.compressedMessages,1)
 }
 const preferred=await decodeHistory([{id:'1',role:'human',text:'old',content:zipped('new')}])
 assert.equal(preferred.messages[0].text,'new')
})
test('only text blocks are extracted; legacy text and safe legacy fallback are compatible',async()=>{
 const result=await decodeHistory([
  {id:'1',role:'human',content:zipped([{type:'text',text:'第一段'},{type:'image_url',image_url:{url:'private-image'}},{type:'reasoning',text:'private-reasoning'},{type:'text',text:'第二段'}])},
  {id:'2',role:'human',text:'旧版正文'},
  {id:'3',role:'ai',text:'兼容正文',content:Buffer.from('broken')},
  {id:'4',role:'human',content:zipped([{type:'image_url',image_url:{url:'not-text'}}])},
 ])
 assert.equal(result.messages[0].text,'第一段\n第二段')
 assert.equal(result.messages[1].text,'旧版正文');assert.equal(result.messages[2].text,'兼容正文');assert.equal(result.messages[3].text,'')
 assert.equal(result.stats.legacyTextMessages,1);assert.equal(result.stats.legacyFallbackMessages,1);assert.equal(result.stats.nonTextMessages,1)
 assert.ok(!result.messages[0].text?.includes('private'))
})
test('corrupt content and oversized decompression fail closed with context-specific errors',async()=>{
 await assert.rejects(()=>decodeHistory([{id:'1',role:'human',content:Buffer.from('corrupt')}]),(e:unknown)=>e instanceof ContextReadError && e.code==='CONTEXT_DECODE_FAILED')
 await assert.rejects(()=>decodeHistory([{id:'1',role:'human',content:zipped('x'.repeat(2*1024*1024))}]),(e:unknown)=>e instanceof ContextReadError && e.code==='CONTEXT_STORAGE_LIMIT')
 await assert.rejects(()=>decodeHistory(Array.from({length:10},(_,i)=>({id:String(i),role:'human',text:'x'.repeat(900000)}))),(e:unknown)=>e instanceof ContextReadError && e.code==='CONTEXT_STORAGE_LIMIT')
})
test('compressed active branch reaches one model invocation; sibling corruption is excluded',async()=>{
 const ctx=new Context();ctx.plugin(require('@koishijs/plugin-database-memory').default);registerModels(ctx);await ctx.start()
 const config:Config={endpoint:'/mcp/mail',token:'test-token-at-least-24-characters',enabled:false,allowAgentSend:false,allowedRecipients:['a@example.com'],smtpHost:'localhost',smtpPort:465,smtpSecure:true,smtpUser:'',smtpPassword:'',from:'sender@example.com',maxPerDay:10,modelTimeoutMs:1000,maxContextChars:24000}
 let calls=0,captured=''
 const rows=[{id:'1',role:'human',parentId:null,text:null,content:zipped('正式存储的用户消息')},{id:'2',role:'ai',parentId:'1',text:null,content:zipped([{type:'text',text:'正式存储的回复'}])},{id:'sibling',role:'human',parentId:'1',content:Buffer.from('corrupt')}]
 Object.defineProperty(ctx,'chatluna',{value:{
  conversation:{getConversation:async()=>({id:'conv',status:'active',preset:'main',model:'platform/model',latestMessageId:'2'}),listMessages:async()=>rows},
  preset:{getPreset:()=>({value:{}})},promptRenderer:{renderPresetTemplate:async()=>({messages:[['system','主插件预设']]})},
  createChatModel:async()=>({value:{invoke:async(messages:unknown)=>{calls++;captured=JSON.stringify(messages);return {content:'{"shouldSend":false,"reason":"无需发送"}'}}}}),
 }})
 try{
  assert.equal(activeHistory(rows,'2').length,2)
  const repo=new Repository(ctx),service=new MailService(ctx,config,repo,new Assets(await mkdtemp(join(tmpdir(),'mail-062-')),repo),async()=>{throw new Error('Must not send')})
  const task=taskSchema.parse({id:'task',time:'09:00',conversationId:'conv',prompt:'有新事项才发送',to:['a@example.com']})
  const diagnostic=await service.decision.inspect(task,[],[])
  assert.equal(diagnostic.historyCount,2);assert.equal(diagnostic.contextStorage.compressedMessages,2);assert.equal(calls,0)
  const result=await service.decision.evaluate(task,[],[])
  assert.equal(result.decision.shouldSend,false);assert.equal(calls,1)
  assert.ok(captured.includes('正式存储的用户消息'));assert.ok(captured.includes('正式存储的回复'));assert.ok(!captured.includes('corrupt'))
 }finally{await ctx.stop()}
})
