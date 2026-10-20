import {WorkflowError} from './workflow-policy.js'
import {ContextReadError} from './history.js'
import { timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Context } from 'koishi'
import type {} from '@koishijs/plugin-server'
import { z } from 'zod'
import { templateSchema } from './templates.js'
import { mailSchema, taskSchema, key } from './types.js'
import { VERSION } from './version.js'
import type { MailService } from './service.js'
const json=(v:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(v)}]})
export const loopback=(s:string)=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(s)
export function authenticated(got:string|undefined,token:string) {
  const a=Buffer.from(got ?? ''),b=Buffer.from('Bearer '+token)
  return token.length>=24 && a.length===b.length && timingSafeEqual(a,b)
}
export function createMcp(service:MailService) {
  const server=new McpServer({name:'chatluna-mail',version:VERSION})
  const wrap=(fn:()=>Promise<unknown>)=>fn().then(json).catch((error:unknown)=>{
    const message=error instanceof Error?error.message:''
    const code=error instanceof WorkflowError?error.code:error instanceof ContextReadError ? error.code : /version conflict/.test(message)?'VERSION_CONFLICT':/management disabled/.test(message)?'AGENT_MANAGEMENT_DISABLED':/Recipient not authorized/.test(message)?'RECIPIENT_NOT_ALLOWED':/Missing template variable|Undeclared template variable/.test(message)?'INVALID_VARIABLES':'OPERATION_REJECTED'
    return {isError:true,content:[{type:'text' as const,text:JSON.stringify({errorCode:code,message:error instanceof WorkflowError||error instanceof ContextReadError?error.message:code==='VERSION_CONFLICT'?'Read the latest task/template version before updating.':code==='AGENT_MANAGEMENT_DISABLED'?'Administrator must enable allowAgentManage in plugin configuration.':code==='RECIPIENT_NOT_ALLOWED'?'Use only administrator-allowed recipients.':code==='INVALID_VARIABLES'?'Declare prompt variables in the template and provide required values.':'Check authorization, input, task configuration, or administrator status.'})}]}
  })
  const manage=()=>{if(!service.config.allowAgentManage) throw new Error('Agent task/template management disabled')}
  server.registerTool('get_mail_configuration',{description:'Get models, presets, active conversation metadata, allowed recipients and limits for configuring mail tasks. Requires administrator allowAgentManage. No keys or chat text.',inputSchema:{}},async()=>wrap(async()=>{manage();return {workflow:service.workflowPolicy.publicSettings(await service.workflowPolicy.settings()),workflowTools:service.workflowPolicy.catalog(),catalog:await service.models.catalog(),modelSettings:await service.models.settings(),allowedRecipients:service.config.allowedRecipients,enabled:service.config.enabled,maxPerDay:service.config.maxPerDay}}))
  server.registerTool('get_mail_task',{description:'Read a full task definition and revision hash before editing. Requires allowAgentManage.',inputSchema:{taskId:key}},async({taskId})=>wrap(async()=>{manage();const row=(await service.tasks()).find(r=>r.task.id===taskId);if(!row) throw new Error('Task not found');return row}))
  server.registerTool('save_mail_task',{description:'Create or replace a task. Requires allowAgentManage. expectedHash empty for creation; for update first get_mail_task and pass its hash. Default enabled=false. Enabling permits scheduled SMTP sends within global switch and whitelist; this call itself never sends. One selected model decides at execution time.',inputSchema:{task:taskSchema,expectedHash:z.string().default('')}},async({task,expectedHash})=>wrap(async()=>{manage();await service.saveTask(task,expectedHash);return (await service.tasks()).find(r=>r.task.id===task.id)}))
  server.registerTool('save_mail_template',{description:'Create or version a custom writing/layout template including declared variables. Requires allowAgentManage. expectedVersion=0 creates; use list_mail_templates current version for update. Builtin IDs cannot be overwritten.',inputSchema:{template:templateSchema,expectedVersion:z.number().int().min(0).default(0)}},async({template,expectedVersion})=>wrap(async()=>{manage();return service.templates.save(template,expectedVersion)}))
  server.registerTool('list_mail_templates',{description:'List writing prompts and supported layouts.',inputSchema:{}},async()=>json(await service.templates.list()))
  server.registerTool('import_mail_image',{description:'Import an image from a successful MediaLuna task owned by the administrator-configured user. Local PNG/JPEG cache only; no URL download or filesystem path input. Returns assetId for create_mail_draft. Requires mediaImportEnabled in workflow settings.',inputSchema:{taskId:z.number().int().min(1),imageIndex:z.number().int().min(0).max(4).default(0)}},async({taskId,imageIndex})=>wrap(()=>service.media.importImage(taskId,imageIndex)))
  server.registerTool('list_mail_assets',{description:'List administrator-imported image IDs. No local file access.',inputSchema:{}},async()=>json(await service.assets.list()))
  server.registerTool('create_mail_draft',{description:'Create an immutable, validated draft. Does not send.',inputSchema:mailSchema.shape},async input=>wrap(()=>service.draft(input)))
  server.registerTool('preview_mail_draft',{description:'Preview immutable draft HTML/text and recipients.',inputSchema:{draftId:z.string().uuid()}},async({draftId})=>wrap(()=>service.preview(draftId)))
  server.registerTool('send_mail_draft',{description:'Send an authorized draft through SMTP. External side effect. Same idempotencyKey is never sent again.',inputSchema:{draftId:z.string().uuid(),idempotencyKey:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)}},async({draftId,idempotencyKey})=>wrap(async()=>{
    if(!service.config.allowAgentSend) throw new Error('Agent sending disabled')
    return service.sendDraft(draftId,'agent:'+idempotencyKey,undefined,{origin:{kind:'agent'}})
  }))
  server.registerTool('get_mail_delivery_status',{description:'Get SMTP submission status; accepted does not prove delivery/read.',inputSchema:{id:z.string().regex(/^delivery:[a-zA-Z0-9:_-]{1,110}$/)}},async({id})=>wrap(async()=>{
    const row=await service.repo.get(id);if(!row || row.kind!=='delivery') throw new Error('Not found');return service.publicEntry(row)
  }))
  server.registerTool('list_mail_tasks',{description:'List configured tasks and schedules. Use get_mail_task and save_mail_task for authorized changes.',inputSchema:{}},async()=>json((await service.tasks()).map(({task,nextRunAt,blockedBy})=>({id:task.id,name:task.name,enabled:task.enabled,scheduleType:task.scheduleType,time:task.time,timezone:task.timezone,nextRunAt,blockedBy}))))
  server.registerTool('get_mail_task_diagnostics',{description:'Inspect a configured task preset, model, context range and budget without LLM generation. No raw conversation text.',inputSchema:{taskId:key}},async({taskId})=>wrap(()=>service.diagnose(taskId)))
  server.registerTool('evaluate_mail_task',{description:'Dry-run a configured task using ChatLuna preset/context and selected model. May cost model tokens; tools-mode also invokes administrator-authorized tools and may incur image generation charges. NEVER sends mail.',inputSchema:{taskId:key}},async({taskId})=>wrap(()=>service.evaluate(taskId)))
  server.registerPrompt('compose_mail',{description:'How to compose a structured illustrated mail.',argsSchema:{purpose:z.string().max(2000)}},async({purpose})=>({
    messages:[{role:'user',content:{type:'text',text:'用途：'+purpose+'\n先调用 list_mail_templates 和 list_mail_assets。若需要定时任务且管理员已开启 allowAgentManage，先调用 get_mail_configuration 选择会话和模型，用 save_mail_template 创建所需模板，再用 save_mail_task 创建任务；使用固定 ID 避免重复创建。更新前读取版本。启用任务会在计划时自动判断并可能发信，按用户意图设置 enabled。按模板生成 subject、paragraphs、images（仅使用已提供 assetId），通过 create_mail_draft 创建并预览草稿。只有获得发送授权才调用 send_mail_draft；不要虚构收件人。'}}]
  }))
  return server
}
export function registerMcp(ctx:Context,service:MailService) {
  // All mail state lives in the repository. A per-request transport prevents stale
  // idle session IDs and survives plugin reloads without replaying tool calls.
  const active=new Set<McpServer>()
  let disposed=false
  ctx.server.all(service.config.endpoint,async web=>{
    if(!loopback(web.req.socket.remoteAddress ?? '')) {web.status=403;return}
    if(web.headers.origin) {web.status=403;return}
    let host=''
    try {host=new URL('http://'+web.headers.host).hostname} catch {web.status=403;return}
    if(!['localhost','127.0.0.1','[::1]'].includes(host)) {web.status=403;return}
    if(!authenticated(web.headers.authorization,service.config.token)) {web.status=401;return}
    if(web.method==='GET') {web.status=405;web.set('Allow','POST, DELETE');return}
    if(web.method==='DELETE') {web.status=204;return}
    if(web.method!=='POST') {web.status=405;web.set('Allow','POST, DELETE');return}
    if(disposed) {web.status=503;return}
    if(active.size>=32) {web.status=429;return}
    const server=createMcp(service)
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true})
    active.add(server)
    const close=()=>{if(active.delete(server)) void server.close().catch(()=>{})}
    web.res.once('close',close)
    web.res.once('finish',close)
    try {
      await server.connect(transport)
      web.respond=false
      await transport.handleRequest(web.req,web.res,web.request.body)
    } catch(error) {close();throw error}
  })
  ctx.on('dispose',async()=>{disposed=true;await Promise.all([...active].map(s=>s.close()));active.clear()})
}
