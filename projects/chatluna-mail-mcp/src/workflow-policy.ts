import {Universal,type Context} from 'koishi'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {z} from 'zod'
import {type Repository} from './repository.js'
export const workflowSettingsSchema=z.object({
 enabled:z.boolean().default(false),allowedTools:z.array(z.string().min(1).max(128)).max(12).default([]),
 maxSteps:z.number().int().min(1).max(24).default(10),maxToolCalls:z.number().int().min(1).max(40).default(16),
 timeoutSeconds:z.number().int().min(10).max(900).default(300),maxToolResultChars:z.number().int().min(500).max(60000).default(16000),
 platform:z.string().max(80).default(''),selfId:z.string().max(128).default(''),userId:z.string().max(128).default(''),
 channelId:z.string().max(128).default(''),guildId:z.string().max(128).default(''),isDirect:z.boolean().default(true),
 mediaImportEnabled:z.boolean().default(false),mediaOwnerId:z.number().int().safe().min(0).nullable().default(null),
 mediaChannels:z.array(z.string().min(1).max(100)).max(10).default([]),
}).strict()
export type WorkflowSettings=z.infer<typeof workflowSettingsSchema>
export class WorkflowError extends Error {
 constructor(readonly code:string,message:string,readonly trace?:unknown){super(message);this.name='WorkflowError'}
}
// Database user IDs can be strings or numbers. Missing identities never authorize one another.
export const sameOwner=(actual:unknown,expected:number|null)=>expected!=null && (typeof actual==='string'||typeof actual==='number') && String(actual)===String(expected)
export const toolNames=(names:string[])=>JSON.stringify([...new Set(names)])
export const blockedTool=(name:string)=>/mail|media.?luna|(^|[_:-])draw($|[_:-])|generat.*image|image.*generat|sub.?agent|handoff|delegate|execute|shell|command|schedule|trigger|delete|remove|merge|replace|upload|import|write|update|create|save|send|publish|purchase|payment/i.test(name)
export class WorkflowPolicy {
 private tail:Promise<unknown>=Promise.resolve()
 constructor(readonly ctx:Context,readonly repo:Repository) {}
 cl():any{return (this.ctx as any).chatluna}
 media():any{return (this.ctx as any).mediaLuna}
 async settings(){const row=await this.repo.get('settings:workflow');return {...workflowSettingsSchema.parse(row?JSON.parse(row.payload):{}),hash:row?.hash??''}}
 catalog(){
  const registry=this.cl()?.platform?.getToolRegistry?.()??{}
  return Object.entries(registry).filter(([name])=>!blockedTool(name)).map(([name,value]:[string,any])=>({name,description:String(value.description??'').slice(0,300),source:value.meta?.source??'extension'})).sort((a,b)=>a.name.localeCompare(b.name))
 }
 async channels(){try{return (await this.media()?.channels?.list?.()??[]).filter((c:any)=>c.enabled).map((c:any)=>({name:String(c.name)}))}catch{return []}}
 async save(input:unknown,expectedHash:string){
  const work=async()=>{
   const settings=workflowSettingsSchema.parse(input),current=await this.settings()
   if(current.hash!==expectedHash) throw new WorkflowError('WORKFLOW_CONFLICT','Workflow settings changed; refresh before saving')
   const names=new Set(this.catalog().map(t=>t.name))
   const unavailable=settings.allowedTools.filter(n=>!names.has(n))
   if(unavailable.length) throw new WorkflowError('WORKFLOW_TOOL_UNAVAILABLE','Workflow tool is unavailable or excluded: '+toolNames(unavailable))
   if(settings.enabled && (!settings.platform || !settings.selfId || !settings.userId)) throw new WorkflowError('WORKFLOW_IDENTITY_REQUIRED','Workflow execution identity is required')
   if(settings.mediaImportEnabled && settings.mediaOwnerId==null) throw new WorkflowError('WORKFLOW_MEDIA_OWNER_REQUIRED','Workflow MediaLuna owner id is required')
   await this.repo.put('settings:workflow','settings','active',settings);return this.settings()
  }
  const next=this.tail.then(work,work);this.tail=next.catch(()=>{});return next
 }
 async validateTask(task:{executionMode:string;tools:string[];workflowImages:boolean}){
  const settings=await this.settings()
  if(task.executionMode!=='tools') return settings
  if(!settings.enabled) throw new WorkflowError('WORKFLOW_DISABLED','Workflow execution is disabled')
  if(!this.cl()?.createAgent || !this.cl()?.resolveToolMask || !this.cl()?.platform?.getFilteredTools) throw new WorkflowError('WORKFLOW_API_UNAVAILABLE','Workflow ChatLuna Agent API is unavailable')
  const catalog=new Set(this.catalog().map(c=>c.name))
  const denied=task.tools.filter(t=>blockedTool(t)||!settings.allowedTools.includes(t)||!catalog.has(t))
  if(denied.length) throw new WorkflowError('WORKFLOW_TOOL_NOT_ALLOWED','Workflow tool is not authorized: '+toolNames(denied))
  if(task.workflowImages && (!settings.mediaImportEnabled || !settings.mediaChannels.length || !this.media()?.generateByName)) throw new WorkflowError('WORKFLOW_MEDIA_UNAVAILABLE','Workflow image generation is not configured')
  return settings
 }
 async createSession(settings:WorkflowSettings):Promise<any>{
  const bot=(this.ctx.bots as any)[settings.platform+':'+settings.selfId]
  if(!bot) throw new WorkflowError('WORKFLOW_BOT_NOT_FOUND','Workflow bot was not found; configure a real connected bot')
  if(bot.status!==Universal.Status.ONLINE) throw new WorkflowError('WORKFLOW_BOT_OFFLINE','Workflow bot is offline')
  const require=createRequire(join(this.ctx.baseDir,'package.json'))
  const helper=require('koishi-plugin-chatluna/utils/virtual_session')
  const session=await helper.buildVirtualSession(bot,settings,{message:'邮件任务后台执行',messageName:'mail-workflow'})
  // Background mail work must not emit a separate chat reply or wait for interactive input.
  session.send=async()=>[];session.sendQueued=async()=>[]
  session.prompt=async()=>{throw new WorkflowError('WORKFLOW_INTERACTION_UNSUPPORTED','Workflow cannot wait for interactive chat input')}
  return session
 }
 async checkRevision(settings:WorkflowSettings & {hash:string}){if((await this.settings()).hash!==settings.hash)throw new WorkflowError('WORKFLOW_POLICY_CHANGED','Workflow policy changed during execution')}
 publicSettings(settings:WorkflowSettings){return {enabled:settings.enabled,allowedTools:settings.allowedTools,maxSteps:settings.maxSteps,maxToolCalls:settings.maxToolCalls,timeoutSeconds:settings.timeoutSeconds,mediaImportEnabled:settings.mediaImportEnabled,mediaChannels:settings.mediaChannels}}
}
