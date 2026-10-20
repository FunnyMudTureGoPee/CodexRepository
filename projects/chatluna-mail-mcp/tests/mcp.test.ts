import test from 'node:test'
import {gzipSync} from 'node:zlib'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { registerModels, Repository } from '../src/repository.js'
import { Assets } from '../src/assets.js'
import { MailService } from '../src/service.js'
import { registerMcp } from '../src/mcp.js'
const require=createRequire(import.meta.url)
const {Context}=require('koishi') as typeof import('koishi')
const memory=require('@koishijs/plugin-database-memory').default
const server=require('@koishijs/plugin-server')
async function freePort(){return new Promise<number>(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const port=(s.address() as any).port;s.close(()=>resolve(port))})})}
test('real HTTP MCP: authentication, tools, prompts, send, duplicate, forbidden recipient, GET 405',async()=>{
 const ctx=new Context(),port=await freePort()
 ctx.plugin(memory);const serverFork=ctx.plugin(server.default ?? server,{host:'127.0.0.1',port})
 registerModels(ctx);await ctx.start()
 const repo=new Repository(ctx),assets=new Assets(await mkdtemp(join(tmpdir(),'mail-mcp-')),repo)
 let calls=0
 const service=new MailService(ctx,{endpoint:'/mcp/mail',token:'test-token-with-more-than-24-characters',enabled:true,allowAgentSend:true,allowedRecipients:['test@example.com'],smtpHost:'localhost',smtpPort:465,smtpSecure:true,smtpUser:'',smtpPassword:'',from:'sender@example.com',maxPerDay:10,modelTimeoutMs:1000,maxContextChars:24000},repo,assets,async()=>{calls++;return {accepted:['test@example.com'],rejected:[]}})
 const endpointPlugin={name:'mail-mcp-test-endpoint',inject:['server'],apply:(child:typeof ctx)=>registerMcp(child,service)}
 let mcpFork=ctx.plugin(endpointPlugin)
 const url=new URL('http://127.0.0.1:'+port+'/mcp/mail')
 const client=new Client({name:'mail-test',version:'1'})
 const transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{authorization:'Bearer '+service.config.token}}})
 try {
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401)
  assert.equal((await fetch(url,{headers:{authorization:'Bearer '+service.config.token,origin:'https://evil.example'}})).status,403)
  await client.connect(transport)
  assert.equal(transport.sessionId,undefined,'Stateless endpoint must not issue an expiring session ID')
  const exposed=(await client.listTools()).tools
  assert.equal(exposed.length,14)
  function assertNoEmptyEnum(value:unknown):void {
   if(!value || typeof value!=='object') return
   const object=value as Record<string,unknown>
   if(Array.isArray(object.enum)) assert.ok(!object.enum.includes(''),'Gemini rejects empty string enum values')
   for(const child of Object.values(object)) {
    if(Array.isArray(child)) child.forEach(assertNoEmptyEnum)
    else assertNoEmptyEnum(child)
   }
  }
  for(const tool of exposed) assertNoEmptyEnum(tool.inputSchema)
  const runAt=(exposed.find(t=>t.name==='save_mail_task')!.inputSchema as any).properties.task.properties.runAt
  assert.equal(runAt.type,'string');assert.equal(runAt.anyOf,undefined);assert.equal(runAt.enum,undefined)
  assert.equal((await client.listPrompts()).prompts[0].name,'compose_mail')
  const deniedManagement:any=await client.callTool({name:'save_mail_template',arguments:{template:{id:'agent-template',name:'Agent 模板',prompt:'写给 {{person}}',fields:{person:{required:true,default:''}}}}})
  assert.equal(deniedManagement.isError,true)
  assert.equal(JSON.parse(deniedManagement.content[0].text).errorCode,'AGENT_MANAGEMENT_DISABLED')
  service.config.allowAgentManage=true
  const createdTemplate:any=await client.callTool({name:'save_mail_template',arguments:{template:{id:'agent-template',name:'Agent 模板',prompt:'写给 {{person}}',fields:{person:{required:true,default:''}}}}})
  assert.equal(JSON.parse(createdTemplate.content[0].text).version,1)
  const args={id:'agent-task',name:'Agent 每日通知',time:'09:30',conversationId:'conv',prompt:'告知 {{person}}',to:['test@example.com'],templateId:'agent-template',variables:{person:'读者'}}
  const createdTask:any=await client.callTool({name:'save_mail_task',arguments:{task:args}})
  const stored=JSON.parse(createdTask.content[0].text)
  assert.equal(stored.task.enabled,false);assert.ok(stored.hash)
  const updated:any=await client.callTool({name:'save_mail_task',arguments:{task:{...args,enabled:true},expectedHash:stored.hash}})
  assert.equal(JSON.parse(updated.content[0].text).task.enabled,true)
  assert.ok(JSON.parse(updated.content[0].text).nextRunAt)
  const stale:any=await client.callTool({name:'save_mail_task',arguments:{task:args,expectedHash:stored.hash}})
  assert.equal(JSON.parse(stale.content[0].text).errorCode,'VERSION_CONFLICT')
  const unauthorizedTask:any=await client.callTool({name:'save_mail_task',arguments:{task:{...args,id:'bad-agent-task',to:['denied@example.com']}}})
  assert.equal(JSON.parse(unauthorizedTask.content[0].text).errorCode,'RECIPIENT_NOT_ALLOWED')
  assert.equal((await repo.list('task')).length,1);assert.equal(calls,0)
  const readTask:any=await client.callTool({name:'get_mail_task',arguments:{taskId:'agent-task'}})
  const latest=JSON.parse(readTask.content[0].text)
  assert.equal(latest.task.enabled,true)
  Object.defineProperty(ctx,'chatluna',{value:{
   conversation:{getConversation:async()=>({id:'conv',status:'active',preset:'main',model:'test/model',latestMessageId:'empty-text'}),listMessages:async()=>[{id:'empty-text',role:'human',text:null,content:gzipSync(JSON.stringify([{type:'image_url',image_url:{url:'private-image'}}]))}]},
   preset:{getPreset:()=>({value:{}})},promptRenderer:{renderPresetTemplate:async()=>({messages:[]})},
   createChatModel:async()=>{throw new Error('Must not invoke model')},
  }})
  const diagnostic:any=await client.callTool({name:'get_mail_task_diagnostics',arguments:{taskId:'agent-task'}})
  assert.equal(diagnostic.isError,true)
  const contextError=JSON.parse(diagnostic.content[0].text)
  assert.equal(contextError.errorCode,'CONTEXT_TEXT_UNAVAILABLE');assert.ok(!contextError.message.includes('private-image'))
  service.config.allowAgentManage=false
  const revoked:any=await client.callTool({name:'save_mail_task',arguments:{task:args,expectedHash:latest.hash}})
  assert.equal(JSON.parse(revoked.content[0].text).errorCode,'AGENT_MANAGEMENT_DISABLED')
  const result:any=await client.callTool({name:'create_mail_draft',arguments:{to:['test@example.com'],subject:'测试',paragraphs:['正文']}})
  const draft=JSON.parse(result.content[0].text)
  assert.ok(draft.draftId)
  for(let n=0;n<2;n++) {
   const sent:any=await client.callTool({name:'send_mail_draft',arguments:{draftId:draft.draftId,idempotencyKey:'once'}})
   assert.equal(JSON.parse(sent.content[0].text).status,'accepted')
  }
  assert.equal(calls,1)
  const bad:any=await client.callTool({name:'create_mail_draft',arguments:{to:['denied@example.com'],subject:'测试',paragraphs:['正文']}})
  assert.equal(bad.isError,true)
  service.config.allowAgentSend=false
  const disabled:any=await client.callTool({name:'send_mail_draft',arguments:{draftId:draft.draftId,idempotencyKey:'twice'}})
  assert.equal(disabled.isError,true);assert.equal(calls,1)
  assert.equal((await fetch(url,{headers:{authorization:'Bearer '+service.config.token}})).status,405)
  // Old clients may still send a previously issued session ID during upgrades.
  const staleSession=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+service.config.token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','mcp-session-id':'expired-old-session','mcp-protocol-version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',id:900,method:'tools/list',params:{}})})
  assert.equal(staleSession.status,200);assert.equal((await staleSession.json() as any).result.tools.length,14)
  const now=Date.now
  try {Date.now=()=>now()+31*60*1000;assert.equal((await client.listTools()).tools.length,14)}finally{Date.now=now}
  await mcpFork!.dispose()
  mcpFork=ctx.plugin(endpointPlugin)
  assert.equal((await client.listTools()).tools.length,14,'Same HTTP client survives endpoint reload')
  service.config.allowAgentSend=true
  const replay:any=await client.callTool({name:'send_mail_draft',arguments:{draftId:draft.draftId,idempotencyKey:'once'}})
  assert.equal(JSON.parse(replay.content[0].text).status,'accepted');assert.equal(calls,1)
  assert.equal((await fetch(url,{method:'DELETE',headers:{authorization:'Bearer '+service.config.token,'mcp-session-id':'expired-old-session'}})).status,204)

 } finally {await client.close();await serverFork?.dispose();await ctx.stop()}
})

