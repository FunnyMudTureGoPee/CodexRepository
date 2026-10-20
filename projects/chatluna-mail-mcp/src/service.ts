import {WorkflowPolicy,WorkflowError} from './workflow-policy.js'
import {MediaBridge} from './media-bridge.js'
import {MailWorkflow} from './workflow.js'
import {ContextReadError} from './history.js'
import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import type { Context } from 'koishi'
import { mailSchema, address, taskSchema, type Config, type Mail, type Task } from './types.js'
import { Repository, digest } from './repository.js'
import { Assets } from './assets.js'
import { render, substitute, TemplateStore, type Template } from './templates.js'
import { nextOccurrence, localMinute, occurrence } from './schedule.js'
import { MailModels } from './models.js'
import { ContextDecision } from './context.js'
import { RetryQueue } from './retries.js'
import { Maintenance } from './maintenance.js'
import { failureInfo, type DeliveryOptions, type DeliveryOrigin } from './transport.js'
export type Sender=(mail:any)=>Promise<{accepted:unknown[];rejected:unknown[];messageId?:string}>
export class MailService {
  private tail:Promise<unknown>=Promise.resolve()
  private running=new Set<string>()
  private taskWrites:Promise<unknown>=Promise.resolve()
  stopped=false
  maintenanceRunning=false
  private activeDrafts=0
  private decisionClaims:Promise<unknown>=Promise.resolve()
  readonly retries:RetryQueue
  readonly maintenance:Maintenance
  invalidTaskIds:string[]=[]
  readonly workflowPolicy:WorkflowPolicy
  readonly media:MediaBridge
  readonly workflow:MailWorkflow
  readonly models:MailModels
  readonly decision:ContextDecision
  readonly templates:TemplateStore
  readonly sender:Sender
  constructor(readonly ctx:Context,readonly config:Config,readonly repo:Repository,readonly assets:Assets,sender?:Sender) {
    this.templates=new TemplateStore(repo)
    this.retries=new RetryQueue(this)
    this.maintenance=new Maintenance(this)
    this.models=new MailModels(ctx,repo)
    this.workflowPolicy=new WorkflowPolicy(ctx,repo)
    this.media=new MediaBridge(this.workflowPolicy,assets,repo)
    this.workflow=new MailWorkflow(this.workflowPolicy,this.media)
    this.decision=new ContextDecision(ctx,config,this.templates,this.models,this.workflow)
    const transport=nodemailer.createTransport({
      host:config.smtpHost,port:config.smtpPort,secure:config.smtpSecure,
      requireTLS:!config.smtpSecure,auth:config.smtpUser ? {user:config.smtpUser,pass:config.smtpPassword}:undefined,
      connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000,
      disableFileAccess:true,disableUrlAccess:true
    })
    this.sender=sender ?? (async mail=>transport.sendMail(mail))
  }
  private serial<T>(f:()=>Promise<T>):Promise<T> {
    const next=this.tail.then(f,f);this.tail=next.catch(()=>{});return next
  }
  validate(mail:unknown) {
    const parsed=mailSchema.parse(mail)
    const allowed=new Set(this.config.allowedRecipients.map(v=>address.parse(v)))
    if(parsed.to.some(a=>!allowed.has(a))) throw new Error('Recipient not authorized')
    return parsed
  }
  async draft(input:unknown,selectedTemplate?:Template) {
    if(this.maintenanceRunning) throw new Error('Maintenance is running')
    this.activeDrafts++
    try {return await this.makeDraft(input,selectedTemplate)} finally {this.activeDrafts--}
  }
  private async makeDraft(input:unknown,selectedTemplate?:Template) {
    const mail=this.validate(input);await this.assets.attachments(mail)
    const snapshot=selectedTemplate ?? await this.templates.get(mail.templateId)
    substitute(snapshot.prompt,snapshot,mail.variables)
    const id=randomUUID()
    await this.repo.put('draft:'+id,'draft','ready',{...mail,templateSnapshot:snapshot})
    return {draftId:id,...render(mail,snapshot),mail,templateVersion:snapshot.version}
  }
  async preview(id:string) {
    const row=await this.repo.get('draft:'+id)
    if(!row || row.status!=='ready') throw new Error('Draft not found or expired')
    const {templateSnapshot,...raw}=JSON.parse(row.payload)
    const mail=this.validate(raw);await this.assets.attachments(mail)
    const snapshot:Template=templateSnapshot ?? await this.templates.get(mail.templateId)
    return {draftId:id,mail,...render(mail,snapshot),templateVersion:snapshot.version}
  }
  async sendDraft(id:string,key:string,guard?:()=>Promise<void>,options:DeliveryOptions={}) {
    const row=await this.repo.get('draft:'+id)
    if(!row || row.status!=='ready') throw new Error('Draft not found or expired')
    const {templateSnapshot,...raw}=JSON.parse(row.payload)
    const check=async()=>{
      if((await this.repo.get('draft:'+id))?.status!=='ready') throw new Error('Draft not found or expired')
      if(guard) await guard()
    }
    return this.send(raw,key,check,templateSnapshot,options)
  }
  async checkOrigin(origin:DeliveryOrigin={kind:'admin'}) {
    if(this.stopped || !this.config.enabled) throw new Error('Sending paused')
    if(this.maintenanceRunning) throw new Error('Maintenance is running')
    if(origin.kind==='agent' && !this.config.allowAgentSend) throw new Error('Sending agent permission was revoked')
    if(origin.kind==='task') {
      const task=await this.task(origin.taskId)
      const row=await this.repo.get('task:'+task.id)
      // Old releases hash the same task without newly added default fields.
      if(!task.enabled || (digest(task)!==origin.taskHash && row?.hash!==origin.taskHash)) throw new Error('Task changed or sending paused')
    }
  }
  async withMaintenance<T>(operation:()=>Promise<T>) {
    return this.serial(async()=>{
      if(this.running.size || this.activeDrafts || this.maintenanceRunning) throw new Error('Maintenance requires idle decisions and drafts')
      this.maintenanceRunning=true
      try {return await operation()} finally {this.maintenanceRunning=false}
    })
  }
  async send(input:unknown,key:string,guard?:()=>Promise<void>,templateSnapshot?:Template,options:DeliveryOptions={}) {
    if(!/^[a-zA-Z0-9:_-]{1,110}$/.test(key)) throw new Error('Invalid idempotency key')
    const mail=this.validate(input),snapshot=templateSnapshot ?? await this.templates.get(mail.templateId)
    const rendered=render(mail,snapshot),hash=digest({mail,templateSnapshot:snapshot}),id='delivery:'+key
    const origin=options.origin ?? {kind:'admin' as const}
    return this.serial(async()=>{
      const prior=await this.repo.get(id)
      if(prior) {
        const data=JSON.parse(prior.payload)
        let legacyMatch=false
        if(!data.templateSnapshot && ['briefing','notice','plain'].includes(mail.templateId)) {
          legacyMatch=data.redacted ? data.legacy && data.normalizedMailHash===digest(mail) : digest(mailSchema.parse(data.mail))===digest(mail)
        }
        if(prior.hash!==hash && !legacyMatch) throw new Error('Idempotency key conflicts with another mail')
        return this.publicEntry(prior)
      }
      await this.checkOrigin(origin)
      this.validate(mail)
      address.parse(this.config.from)
      const today=new Date().toISOString().slice(0,10)
      if((await this.repo.list('delivery')).filter(e=>new Date(e.createdAt).toISOString().startsWith(today)).length>=this.config.maxPerDay)
        throw new Error('Daily sending limit reached')
      const attachments=await this.assets.attachments(mail)
      if(guard) await guard()
      await this.checkOrigin(origin)
      const payload={mail,templateSnapshot:snapshot,origin,rootDeliveryId:options.rootDeliveryId ?? id,attempt:options.attempt ?? 0}
      if(!await this.repo.claim(id,'delivery',payload,hash)) return this.publicEntry((await this.repo.get(id))!)
      await this.repo.put(id,'delivery','sending',payload,hash)
      let info
      try {
        info=await this.sender({from:this.config.from,to:mail.to,subject:mail.subject,...rendered,attachments,messageId:'<'+digest(key)+'@chatluna-mail.local>'})
      } catch(error) {
        const failure=failureInfo(error)
        const row=await this.repo.put(id,'delivery',failure.status,{...payload,...failure},hash)
        if(failure.status==='failed') {
          try {await this.retries.queue(id,'auto')} catch {/* Limits or policy can block automatic retry. */}
        }
        return this.publicEntry(row)
      }
      const status=info.accepted.length?(info.rejected.length?'partial':'accepted'):'failed'
      return this.publicEntry(await this.repo.put(id,'delivery',status,{...payload,accepted:info.accepted,rejected:info.rejected,messageId:info.messageId,transient:false},hash))
    })
  }

  publicEntry(e:{id:string;status:string;payload:string;createdAt:Date;updatedAt:Date}) {
    const p=JSON.parse(e.payload)
    return {id:e.id,status:e.status,createdAt:e.createdAt,updatedAt:e.updatedAt,accepted:p.accepted,rejected:p.rejected,errorCode:p.errorCode,redacted:!!p.redacted,attempt:p.attempt ?? 0,rootDeliveryId:p.rootDeliveryId ?? e.id,canRetry:!p.redacted && !!p.mail && ['failed','partial'].includes(e.status) && (p.attempt ?? 0)<(this.config.maxRetryAttempts ?? 2)}
  }
  async task(id:string):Promise<Task> {
    const row=await this.repo.get('task:'+id)
    if(!row || row.kind!=='task') throw new Error('Task not found')
    return taskSchema.parse(JSON.parse(row.payload))
  }
  async saveTask(input:unknown,expectedHash?:string) {
    const operation=()=>this.saveTaskNow(input,expectedHash)
    const next=this.taskWrites.then(operation,operation)
    this.taskWrites=next.catch(()=>{})
    return next
  }
  private async saveTaskNow(input:unknown,expectedHash?:string) {
    const task=taskSchema.parse(input)
    const prior=await this.repo.get('task:'+task.id)
    if(expectedHash!==undefined && (prior?.hash ?? '')!==expectedHash) throw new Error('Task version conflict; refresh before saving')
    if(!prior && (await this.repo.list('task')).length>=50) throw new Error('Task limit reached (50)')
    const template=await this.templates.get(task.templateId)
    if(task.enabled) {
      if(task.executionMode==='tools')await this.workflowPolicy.validateTask(task)
      substitute(task.prompt+'\n'+template.prompt+template.layout.footer,template,task.variables)
      if(task.useDefaultModel && !task.model) await this.models.resolve(task,'')
    }
    this.validate({to:task.to,subject:'validation',paragraphs:['validation'],images:[],templateId:task.templateId})
    await this.repo.put('task:'+task.id,'task',task.enabled?'enabled':'paused',task)
    return task
  }
  async tasks(now=new Date()) {
    const runs=await this.repo.list('run')
    const output=[]
    this.invalidTaskIds=[]
    for(const row of await this.repo.list('task')) {
      let task:Task
      try {task=taskSchema.parse(JSON.parse(row.payload))} catch {this.invalidTaskIds.push(row.id);continue}
      let nextRunAt=nextOccurrence(task,now)
      if(nextRunAt && task.scheduleType==='once' && runs.some(r=>r.id==='run:'+task.id+':'+occurrence(task,new Date(task.runAt)))) nextRunAt=null
      if(task.scheduleType!=='once') {
        for(let checked=0;nextRunAt && checked<16;checked++) {
          const key=localMinute(new Date(nextRunAt),task.timezone).day
          if(!runs.some(r=>r.id==='run:'+task.id+':'+key)) break
          nextRunAt=nextOccurrence(task,new Date(nextRunAt))
        }
      }
      output.push({task,hash:row.hash,nextRunAt,blockedBy:!this.config.enabled?'global-disabled':this.stopped?'paused':null})
    }
    return output
  }
  async archiveTask(id:string,expectedHash?:string) {
    const operation=()=>this.archiveTaskNow(id,expectedHash)
    const next=this.taskWrites.then(operation,operation)
    this.taskWrites=next.catch(()=>{})
    return next
  }
  private async archiveTaskNow(id:string,expectedHash?:string) {
    if(this.running.has(id)) throw new Error('Disable task and wait for current run before archiving')
    const task=await this.task(id)
    if(task.enabled) throw new Error('Disable task and wait for current run before archiving')
    if(expectedHash!==undefined && (await this.repo.get('task:'+id))?.hash!==expectedHash) throw new Error('Task version conflict; refresh before saving')
    await this.repo.put('task:'+id,'archived-task','archived',{...task,enabled:false})
    return {id,archived:true}
  }
  async toggle(id:string,enabled:boolean) {return this.saveTask({...await this.task(id),enabled})}
  async checkpoint(id:string) {
    const rows=(await this.repo.list('run')).filter(e=>['accepted','partial'].includes(e.status) && JSON.parse(e.payload).taskId===id)
      .sort((a,b)=>+new Date(b.updatedAt)-+new Date(a.updatedAt))
    return rows.length ? JSON.parse(rows[0].payload).source?.latestMessageId as string|undefined : undefined
  }
  async diagnose(id:string) {
    return this.decision.inspect(await this.task(id),await this.assets.list(),[],await this.checkpoint(id))
  }
  private async claimDecision(id:string,data:unknown) {
    const work=async()=>{
      if(await this.repo.get(id)) return false
      if((await this.repo.list('run')).filter(e=>Date.now()-+new Date(e.createdAt)<3600000).length >= (this.config.maxDecisionsPerHour ?? 60))
        throw new Error('Hourly decision limit reached')
      return this.repo.claim(id,'run',data)
    }
    const next=this.decisionClaims.then(work,work);this.decisionClaims=next.catch(()=>{});return next
  }
  async records(kind:'run'|'delivery',page=1,status='') {
    if(!Number.isInteger(page) || page<1) throw new Error('Invalid record page')
    const rows=(await this.repo.list(kind)).filter(e=>!status || e.status===status).sort((a,b)=>+new Date(b.createdAt)-+new Date(a.createdAt))
    return {page,total:rows.length,pageSize:20,items:rows.slice((page-1)*20,page*20).map(e=>kind==='delivery'?this.publicEntry(e):{id:e.id,status:e.status,at:e.createdAt,...JSON.parse(e.payload)})}
  }
  async evaluate(id:string,runKey?:string) {
    const task=await this.task(id), scheduled=!!runKey
    if(this.maintenanceRunning) return {status:'busy'}
    if(scheduled && (!task.enabled || !this.config.enabled || this.stopped)) return {status:'paused'}
    if(this.running.has(id)) return {status:'busy'}
    this.running.add(id)
    try {
      const runId='run:'+id+':'+(runKey ?? randomUUID())
      if(!await this.claimDecision(runId,{taskId:id,scheduled})) return {status:'duplicate'}
      try {
        const rows=(await this.repo.list('run')).filter(e=>e.id!==runId && JSON.parse(e.payload).taskId===id)
        const recent=rows.sort((a,b)=>+new Date(b.createdAt)-+new Date(a.createdAt)).slice(0,10)
          .map(e=>({at:e.createdAt,status:e.status,reason:JSON.parse(e.payload).decision?.reason}))
        const cutoff=Date.now()-task.cooldownMinutes*60000
        const cooling=scheduled && rows.some(e=>new Date(e.updatedAt).getTime()>cutoff && ['accepted','partial','unknown','sending'].includes(e.status))
        if(cooling) {await this.repo.put(runId,'run','cooldown',{taskId:id,scheduled});return {runId,status:'cooldown'}}
        const executionGuard=async()=>{
          if(digest(await this.task(id))!==digest(task) || this.stopped || scheduled && !this.config.enabled)throw new WorkflowError('WORKFLOW_REVOKED','Workflow task changed or execution was paused')
        }
        const result=await this.decision.evaluate(task,await this.assets.list(),recent,await this.checkpoint(id),executionGuard)
        if(!result.decision.shouldSend) {
          await this.repo.put(runId,'run','skipped',{taskId:id,scheduled,...result})
          return {runId,status:'skipped',...result}
        }
        const draft=await this.draft({...result.decision.mail,to:task.to,templateId:task.templateId,variables:task.variables},result.templateSnapshot)
        if(!scheduled) {
          await this.repo.put(runId,'run','preview',{taskId:id,scheduled,...result,draftId:draft.draftId})
          return {runId,status:'preview',...result,draftId:draft.draftId}
        }
        const guard=async()=>{
          if(digest(await this.task(id))!==digest(task) || !this.config.enabled || this.stopped) throw new Error('Task changed or sending paused')
        }
        await this.repo.put(runId,'run','sending',{taskId:id,scheduled,...result,draftId:draft.draftId})
        const sent=await this.sendDraft(draft.draftId,runId,guard,{origin:{kind:'task',taskId:id,taskHash:digest(task),autoRetry:task.retryOnFailure}})
        await this.repo.put(runId,'run',sent.status,{taskId:id,scheduled,...result,draftId:draft.draftId,deliveryId:sent.id})
        return {runId,...sent}
      } catch(error) {
        // Never expose raw provider errors (may include credential-bearing URLs).
        const existing=await this.repo.get(runId)
        const status=existing?.status==='sending'?'unknown':'error'
        const message=error instanceof Error ? error.message : ''
        const known=['Compatible ChatLuna conversation/preset APIs are unavailable','Conversation unavailable or not active','Preset and model are required','Preset unavailable','Conversation context is empty','No readable text in context','Context exceeds configured character budget; reduce historyLimit','Selected model unavailable','Model timeout','Model response too large','Task changed or sending paused','Recipient not authorized','Daily sending limit reached','Unknown image asset']
        const errorCode=error instanceof WorkflowError ? error.code : error instanceof ContextReadError ? error.code : error instanceof SyntaxError ? 'INVALID_MODEL_JSON' : (error as any)?.name==='ZodError' ? 'INVALID_OUTPUT_SCHEMA' : 'DECISION_OR_DELIVERY_FAILED'
        const detail=error instanceof WorkflowError ? message : known.includes(message) || /^(Missing template variable:|Undeclared template variable:|Template not found|Context)/.test(message) ? message : errorCode
        await this.repo.put(runId,'run',status,{...(existing ? JSON.parse(existing.payload):{}),taskId:id,scheduled,errorCode,detail,...(error instanceof WorkflowError?{workflow:error.trace}: {})})
        return {runId,status,errorCode,detail}
      }
    } finally {this.running.delete(id)}
  }
}
