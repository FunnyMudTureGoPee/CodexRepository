import type { MailService } from './service.js'
import { digest } from './repository.js'
import { address, mailSchema } from './types.js'
import type { DeliveryOrigin } from './transport.js'

export interface RetryJob {
  sourceId:string; rootId:string; attempt:number; dueAt:string; mode:'manual'|'auto';
  childKey:string; origin:DeliveryOrigin; outcome?:string; deliveryId?:string
}
export class RetryQueue {
  private tail:Promise<unknown> = Promise.resolve()
  private busy = false
  constructor(readonly service:MailService) {}
  private locked<T>(work:()=>Promise<T>) {
    const next=this.tail.then(work,work);this.tail=next.catch(()=>{});return next
  }
  async queue(sourceId:string, mode:'manual'|'auto'='manual', now=new Date()) {
    return this.locked(()=>this.queueNow(sourceId,mode,now))
  }
  private async queueNow(sourceId:string,mode:'manual'|'auto',now:Date) {
    if(this.service.maintenanceRunning) throw new Error('Maintenance is running')
    const source=await this.service.repo.get(sourceId)
    if(!source || source.kind!=='delivery' || !['failed','partial'].includes(source.status)) throw new Error('Retry requires a definite failed or partial delivery')
    const data=JSON.parse(source.payload)
    if(data.redacted || !data.mail) throw new Error('Retry content has expired')
    if(mode==='auto' && (!this.service.config.autoRetryEnabled || !data.transient || data.origin?.kind!=='task' || !data.origin.autoRetry))
      return {status:'disabled'}
    const rootId=data.rootDeliveryId ?? source.id
    const jobs=(await this.service.repo.list('retry')).filter(e=>JSON.parse(e.payload).rootId===rootId)
    const same=jobs.find(e=>JSON.parse(e.payload).sourceId===source.id)
    if(same) {
      const job=JSON.parse(same.payload) as RetryJob
      if(mode==='manual' && ['blocked','cancelled'].includes(same.status) && !await this.service.repo.get('delivery:'+job.childKey)) {
        if(job.attempt>(this.service.config.maxRetryAttempts ?? 2)) throw new Error('Retry attempt limit reached')
        if(this.service.maintenanceRunning) throw new Error('Maintenance is running')
        const restarted={...job,mode:'manual' as const,dueAt:now.toISOString(),outcome:undefined}
        await this.service.repo.put(same.id,'retry','scheduled',restarted,same.hash)
        return {id:same.id,status:'scheduled',...restarted}
      }
      return {id:same.id,status:same.status,...job}
    }
    if(jobs.some(e=>['scheduled','running'].includes(e.status))) throw new Error('Retry already pending for this delivery')
    const children=(await this.service.repo.list('delivery')).filter(e=>JSON.parse(e.payload).rootDeliveryId===rootId)
    if(children.some(e=>(JSON.parse(e.payload).attempt ?? 0)>(data.attempt ?? 0))) throw new Error('Retry must use the latest failed attempt')
    const attempt=(data.attempt ?? 0)+1
    if(attempt>(this.service.config.maxRetryAttempts ?? 2)) throw new Error('Retry attempt limit reached')
    // Validate rejected recipients before a partial retry is even enqueued.
    this.retryMail(source.status,data)
    const childKey='retry:'+digest(rootId).slice(0,40)+':'+attempt
    const dueAt=new Date(now.getTime()+(mode==='auto'?(this.service.config.retryDelayMinutes ?? 5)*60000*2**(attempt-1):0)).toISOString()
    const job:RetryJob={sourceId,rootId,attempt,dueAt,mode,childKey,origin:data.origin ?? {kind:'admin'}}
    if(this.service.maintenanceRunning) throw new Error('Maintenance is running')
    await this.service.repo.put(childKey,'retry','scheduled',job)
    return {id:childKey,status:'scheduled',...job}
  }
  private retryMail(status:string,data:any) {
    const mail=mailSchema.parse(data.mail)
    if(status==='partial') {
      const normalize=(items:unknown[])=>items.map(v=>address.parse(typeof v==='string'?v:(v as any)?.address))
      const rejected=normalize(data.rejected ?? []),accepted=new Set(normalize(data.accepted ?? []))
      const to=[...new Set(rejected)].filter(a=>mail.to.includes(a) && !accepted.has(a))
      if(!to.length || to.length!==new Set(rejected).size) throw new Error('Retry recipients cannot be identified safely')
      return {...mail,to}
    }
    return mail
  }
  async cancel(id:string) {
    return this.locked(async()=>{
      const row=await this.service.repo.get(id)
      if(!row || row.kind!=='retry' || row.status!=='scheduled') throw new Error('Retry is not cancellable')
      await this.service.repo.put(id,'retry','cancelled',JSON.parse(row.payload),row.hash)
      return {id,status:'cancelled'}
    })
  }
  async tick(now=new Date()) {
    if(this.busy || this.service.stopped || !this.service.config.enabled || this.service.maintenanceRunning) return
    this.busy=true
    try {
      for(const row of await this.service.repo.list('retry')) {
        if(row.status!=='scheduled') continue
        const job=JSON.parse(row.payload) as RetryJob
        if(new Date(job.dueAt)>now) continue
        if(job.mode==='auto' && !this.service.config.autoRetryEnabled) continue
        try {
          if(job.attempt>(this.service.config.maxRetryAttempts ?? 2)) throw new Error('Retry attempt limit reached')
          await this.service.checkOrigin(job.origin)
          const fresh=await this.service.repo.get(row.id)
          if(fresh?.status!=='scheduled') continue
          const source=await this.service.repo.get(job.sourceId)
          if(!source || !['failed','partial'].includes(source.status)) throw new Error('Retry source no longer failed')
          const data=JSON.parse(source.payload)
          if(data.redacted) throw new Error('Retry content has expired')
          const mail=this.retryMail(source.status,data)
          const claimed=await this.locked(async()=>{
            if((await this.service.repo.get(row.id))?.status!=='scheduled') return false
            await this.service.repo.put(row.id,'retry','running',job,row.hash)
            return true
          })
          if(!claimed) continue
          const guard=async()=>{
            if(job.attempt>(this.service.config.maxRetryAttempts ?? 2) || (job.mode==='auto' && !this.service.config.autoRetryEnabled)) throw new Error('Retry policy changed')
            if((await this.service.repo.get(row.id))?.status!=='running') throw new Error('Retry cancelled')
            await this.service.checkOrigin(job.origin)
          }
          const result=await this.service.send(mail,job.childKey,guard,data.templateSnapshot,{origin:job.origin,rootDeliveryId:job.rootId,attempt:job.attempt})
          await this.service.repo.put(row.id,'retry','completed',{...job,outcome:result.status,deliveryId:result.id},row.hash)
          if(['accepted','partial','unknown'].includes(result.status) && job.origin.kind==='task') {
            for(const run of await this.service.repo.list('run')) {
              const data=JSON.parse(run.payload)
              if(data.deliveryId===job.rootId || data.rootDeliveryId===job.rootId) {
                await this.service.repo.put(run.id,'run',result.status,{...data,rootDeliveryId:job.rootId,deliveryId:result.id,retried:true},run.hash)
              }
            }
          }
          if(result.status==='failed') await this.queue(result.id,'auto',now)
        } catch {
          const child=await this.service.repo.get('delivery:'+job.childKey)
          const status=child?'completed':'blocked'
          await this.service.repo.put(row.id,'retry',status,{...job,outcome:child?.status ?? 'AUTHORIZATION_OR_POLICY_BLOCKED',deliveryId:child?.id},row.hash)
        }
      }
    } finally {this.busy=false}
  }
}
