import type { Context } from 'koishi'
import type {} from '@koishijs/plugin-console'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MailService } from './service.js'
import { key, mailSchema } from './types.js'
import { render, templateSchema, type Template } from './templates.js'
import { VERSION } from './version.js'
import { safeError } from './transport.js'

declare module '@koishijs/plugin-console' {
  interface Events {
    'mail-admin/snapshot'(): Promise<unknown>
    'mail-admin/model-save'(input:unknown): Promise<unknown>
    'mail-admin/workflow-save'(input:unknown): Promise<unknown>
    'mail-admin/workflow-resolve'(input:unknown): Promise<unknown>
    'mail-admin/task-save'(input: unknown): Promise<unknown>
    'mail-admin/task-toggle'(input: unknown): Promise<unknown>
    'mail-admin/task-archive'(input: unknown): Promise<unknown>
    'mail-admin/template-save'(input: unknown): Promise<unknown>
    'mail-admin/template-preview'(input: unknown): Promise<unknown>
    'mail-admin/evaluate'(input: unknown): Promise<unknown>
    'mail-admin/preview'(input: unknown): Promise<unknown>
    'mail-admin/evaluation-result'(input: unknown): Promise<unknown>
    'mail-admin/send'(input: unknown): Promise<unknown>
    'mail-admin/pause'(): Promise<unknown>
    'mail-admin/resume'(): Promise<unknown>
    'mail-admin/diagnose'(input:unknown): Promise<unknown>
    'mail-admin/records'(input:unknown): Promise<unknown>
    'mail-admin/retry-create'(input:unknown): Promise<unknown>
    'mail-admin/retry-cancel'(input:unknown): Promise<unknown>
    'mail-admin/cleanup-preview'(): Promise<unknown>
    'mail-admin/cleanup-apply'(input:unknown): Promise<unknown>
    'mail-admin/asset-pin'(input:unknown): Promise<unknown>
    'mail-admin/asset-restore'(input:unknown): Promise<unknown>
  }
}
export function adminHandlers(service: MailService) {
  const jobs=new Map<string,{at:number;done:boolean;result?:unknown}>()
  return {
    'mail-admin/snapshot': async () => ({
      version: VERSION,
      workflowLocks:await service.workflow.locks(),workflowBots:Array.from(service.ctx.bots??[]).map((b:any)=>({platform:b.platform,selfId:b.selfId,status:b.status??'unknown'})),workflowSettings:await service.workflowPolicy.settings(),workflowTools:service.workflowPolicy.catalog(),mediaChannels:await service.workflowPolicy.channels(),
      modelSettings:await service.models.settings(),catalog:await service.models.catalog(),
      enabled: service.config.enabled, paused: service.stopped,
      allowAgentManage:!!service.config.allowAgentManage,allowAgentSend: service.config.allowAgentSend, allowedRecipients: service.config.allowedRecipients,
      tasks: await service.tasks(), invalidTaskIds:service.invalidTaskIds,templates: await service.templates.list(), assets: await service.assets.list(),
      policy:{autoRetryEnabled:!!service.config.autoRetryEnabled,maxRetryAttempts:service.config.maxRetryAttempts ?? 2,retryDelayMinutes:service.config.retryDelayMinutes ?? 5,
        cleanupEnabled:!!service.config.cleanupEnabled,retentionDays:service.config.retentionDays ?? 30,maxDecisionsPerHour:service.config.maxDecisionsPerHour ?? 60},
      retryJobs:(await service.repo.list('retry')).sort((a,b)=>+new Date(b.createdAt)-+new Date(a.createdAt)).slice(0,50).map(e=>({id:e.id,status:e.status,...JSON.parse(e.payload)})),
      trashedAssets:(await service.repo.list('asset')).filter(e=>e.status==='trashed').map(e=>JSON.parse(e.payload)),
      runs: (await service.repo.list('run')).sort((a,b) => +new Date(b.createdAt)-+new Date(a.createdAt)).slice(0,30).map(e => ({ id:e.id, status:e.status, at:e.createdAt, ...JSON.parse(e.payload) })),
      deliveries: (await service.repo.list('delivery')).sort((a,b) => +new Date(b.createdAt)-+new Date(a.createdAt)).slice(0,30).map(e => service.publicEntry(e)),
    }),
    'mail-admin/workflow-resolve':async(input:unknown)=>{
      const p=z.object({taskId:key,expectedHash:z.string(),confirm:z.literal(true)}).strict().parse(input)
      return service.workflow.resolveLock(p.taskId,p.expectedHash)
    },
    'mail-admin/workflow-save': async (input:unknown)=>{
      const p=z.object({settings:z.unknown(),expectedHash:z.string()}).strict().parse(input)
      return service.workflowPolicy.save(p.settings,p.expectedHash)
    },
    'mail-admin/model-save': async (input:unknown) => {
      const p=z.object({settings:z.unknown(),expectedHash:z.string()}).strict().parse(input)
      return service.models.save(p.settings,p.expectedHash)
    },
    'mail-admin/task-save': async (input:unknown) => {
      const p=z.object({task:z.unknown(),expectedHash:z.string()}).strict().parse(input)
      return service.saveTask(p.task,p.expectedHash)
    },
    'mail-admin/task-toggle': async (input:unknown) => {
      const p=z.object({id:key,enabled:z.boolean(),expectedHash:z.string()}).strict().parse(input)
      return service.saveTask({...await service.task(p.id),enabled:p.enabled},p.expectedHash)
    },
    'mail-admin/task-archive': async (input:unknown) => {
      const p=z.object({id:key,expectedHash:z.string()}).strict().parse(input)
      return service.archiveTask(p.id,p.expectedHash)
    },
    'mail-admin/template-save': async (input:unknown) => {
      const p=z.object({template:z.unknown(),expectedVersion:z.number().int().min(0)}).strict().parse(input)
      return service.templates.save(p.template,p.expectedVersion)
    },
    'mail-admin/template-preview': async (input:unknown) => {
      const p=z.object({template:templateSchema,mail:mailSchema}).strict().parse(input)
      const template:Template={...p.template,version:0}
      return render(p.mail,template)
    },
    'mail-admin/evaluate': async (input:unknown) => {
      const id=z.object({id:key}).strict().parse(input).id
      for(const [jobId,job] of jobs) if(Date.now()-job.at>10*60000) jobs.delete(jobId)
      if(jobs.size>=50) throw new Error('Task limit reached for pending previews')
      const jobId=randomUUID(), job:{at:number;done:boolean;result?:unknown}={at:Date.now(),done:false}
      jobs.set(jobId,job)
      void service.evaluate(id).then(result=>{job.done=true;job.result=result},()=>{job.done=true;job.result={status:'error',errorCode:'EVALUATION_FAILED'}})
      return {jobId}
    },
    'mail-admin/evaluation-result': async (input:unknown) => {
      const {jobId}=z.object({jobId:z.string().uuid()}).strict().parse(input)
      const job=jobs.get(jobId)
      if(!job) throw new Error('Task not found: preview job expired')
      return {done:job.done,result:job.result}
    },
    'mail-admin/preview': async (input:unknown) => {
      const preview=await service.preview(z.object({id:z.string().uuid()}).strict().parse(input).id)
      for(const asset of await service.assets.attachments(preview.mail)) {
        preview.html=preview.html.replace('src="cid:'+asset.cid+'"','src="data:'+asset.contentType+';base64,'+asset.content.toString('base64')+'"')
      }
      return preview
    },
    'mail-admin/send': async (input:unknown) => {
      const p=z.object({id:z.string().uuid()}).strict().parse(input)
      return service.sendDraft(p.id,'console:'+p.id)
    },
    'mail-admin/pause': async () => {service.stopped=true;return {paused:true}},
    'mail-admin/resume': async () => {service.stopped=false;return {paused:false}},
    'mail-admin/diagnose': async (input:unknown) => service.diagnose(z.object({id:key}).strict().parse(input).id),
    'mail-admin/records': async (input:unknown) => {
      const p=z.object({kind:z.enum(['run','delivery']),page:z.number().int().min(1).max(100000),status:z.string().max(32).default('')}).strict().parse(input)
      return service.records(p.kind,p.page,p.status)
    },
    'mail-admin/retry-create': async (input:unknown) => service.retries.queue(z.object({id:z.string().max(128)}).strict().parse(input).id),
    'mail-admin/retry-cancel': async (input:unknown) => service.retries.cancel(z.object({id:z.string().max(128)}).strict().parse(input).id),
    'mail-admin/cleanup-preview': async () => service.maintenance.plan(),
    'mail-admin/cleanup-apply': async (input:unknown) => {
      const p=z.object({planId:z.string().uuid(),confirm:z.literal(true)}).strict().parse(input)
      return service.maintenance.apply(p.planId,p.confirm)
    },
    'mail-admin/asset-pin': async (input:unknown) => {
      const p=z.object({id:key,pinned:z.boolean()}).strict().parse(input)
      return service.withMaintenance(()=>service.assets.setPinned(p.id,p.pinned))
    },
    'mail-admin/asset-restore': async (input:unknown) => service.withMaintenance(()=>service.assets.restore(z.object({id:key}).strict().parse(input).id)),

  }
}
export function registerConsole(ctx:Context,service:MailService,entryDir=__dirname) {
  ctx.console.addEntry({dev:resolve(entryDir,'../client/index.ts'),prod:resolve(entryDir,'../console')})
  const handlers=adminHandlers(service)
  for(const event of Object.keys(handlers) as Array<keyof typeof handlers>) {
    // Koishi Console authentication/authority uses the same mechanism as its package manager.
    ctx.console.addListener(event,(async (input?:unknown) => {
      try { return await (handlers[event] as (input?:unknown)=>Promise<unknown>)(input) }
      catch(error) {
        if(error instanceof z.ZodError) throw new Error('输入格式不正确：'+error.issues.map(i=>i.path.join('.')+': '+i.message).slice(0,5).join('; '))
        const message=error instanceof Error ? error.message : ''
        if(/^(模型设置|所选模型|邮件默认模型|Task version conflict|Template version conflict|Copy builtin|Missing template variable|Undeclared template variable|Template not found|Task not found|Draft not found|Disable task|Sending paused|Recipient not authorized|Task limit reached|Hourly decision limit|Daily sending limit)/.test(message)) throw new Error(message)
        throw new Error(safeError(error)==='OPERATION_FAILED'?'操作失败，请检查任务、模板或数据库配置':safeError(error))
      }
    }) as never,{authority:4})
  }
}
