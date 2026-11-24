import { randomUUID } from 'node:crypto'
import type { MailService } from './service.js'
import { digest } from './repository.js'
import { mailSchema, type Entry } from './types.js'

type Candidate={id:string;hash:string;status:string;updatedAt:string;action:'compact'|'expire'|'trash'}
export class Maintenance {
  constructor(readonly service:MailService) {}
  private async candidates(days:number,at:Date) {
    const cutoff=at.getTime()-days*86400000, candidates:Candidate[]=[]
    const drafts=await this.service.repo.list('draft'),deliveries=await this.service.repo.list('delivery'),runs=await this.service.repo.list('run')
    const protectedIds=new Set<string>()
    for(const row of await this.service.repo.list('retry')) if(['scheduled','running'].includes(row.status)) {
      const job=JSON.parse(row.payload);protectedIds.add(job.sourceId)
      protectedIds.add('delivery:'+job.childKey)
    }
    const add=(row:Entry,action:Candidate['action'])=>candidates.push({id:row.id,hash:row.hash,status:row.status,updatedAt:new Date(row.updatedAt).toISOString(),action})
    for(const row of deliveries) if(+new Date(row.updatedAt)<cutoff && !protectedIds.has(row.id) && ['accepted','partial','failed','unknown'].includes(row.status) && !JSON.parse(row.payload).redacted) add(row,'compact')
    for(const row of runs) if(+new Date(row.updatedAt)<cutoff && !['running','sending'].includes(row.status) && !JSON.parse(row.payload).redacted) add(row,'compact')
    const referencedDrafts=new Set<string>()
    for(const row of runs) if(['running','sending'].includes(row.status)) {const p=JSON.parse(row.payload);if(p.draftId) referencedDrafts.add('draft:'+p.draftId)}
    for(const row of drafts) if(+new Date(row.updatedAt)<cutoff && row.status==='ready' && !referencedDrafts.has(row.id)) add(row,'expire')
    const changing=new Set(candidates.map(c=>c.id)),used=new Set<string>()
    for(const row of [...drafts,...deliveries]) if(!changing.has(row.id)) {
      const p=JSON.parse(row.payload),mail=p.mail ?? p
      for(const image of mail.images ?? []) if(typeof image.assetId==='string') used.add(image.assetId)
    }
    for(const row of await this.service.repo.list('asset')) {
      const asset=JSON.parse(row.payload)
      if(row.status==='ready' && asset.pinned===false && +new Date(row.updatedAt)<cutoff && !used.has(asset.id)) add(row,'trash')
    }
    return candidates.sort((a,b)=>a.id.localeCompare(b.id))
  }
  async plan(days=this.service.config.retentionDays ?? 30,now=new Date()) {
    if(!Number.isInteger(days) || days<1 || days>3650) throw new Error('Cleanup days must be between 1 and 3650')
    const items=await this.candidates(days,now),planId=randomUUID()
    const plan={planId,days,policyHash:digest({retentionDays:this.service.config.retentionDays ?? 30}),at:now.toISOString(),items,fingerprint:digest(items),counts:{
      compact:items.filter(i=>i.action==='compact').length,
      expiredDrafts:items.filter(i=>i.action==='expire').length,trashedAssets:items.filter(i=>i.action==='trash').length,
    }}
    await this.service.repo.put('cleanup:'+planId,'cleanup-plan','preview',plan)
    return plan
  }
  async apply(planId:string,confirmed:boolean) {
    if(!confirmed) throw new Error('Cleanup confirmation is required')
    return this.service.withMaintenance(async()=>{
      const row=await this.service.repo.get('cleanup:'+planId)
      if(!row || row.kind!=='cleanup-plan' || row.status!=='preview') throw new Error('Cleanup preview is missing or already applied')
      const plan=JSON.parse(row.payload)
      if(Date.now()-new Date(row.createdAt).getTime()>10*60000) throw new Error('Cleanup preview expired')
      if(plan.policyHash!==digest({retentionDays:this.service.config.retentionDays ?? 30})) throw new Error('Cleanup policy changed; preview again')
      if(digest(await this.candidates(plan.days,new Date(plan.at)))!==plan.fingerprint) throw new Error('Cleanup data changed; preview again')
      const completed:string[]=[],failed:string[]=[]
      for(const item of plan.items as Candidate[]) {
        try {
          const entry=await this.service.repo.get(item.id)
          if(!entry || entry.hash!==item.hash || entry.status!==item.status) throw new Error('Cleanup conflict')
          const data=JSON.parse(entry.payload)
          if(item.action==='trash') await this.service.assets.trash(data.id)
          else if(item.action==='expire') await this.service.repo.put(entry.id,'draft','expired',{expired:true,expiredAt:new Date().toISOString()},entry.hash)
          else {
            let normalizedMailHash: string|undefined
            try { if(data.mail) normalizedMailHash=digest(mailSchema.parse(data.mail)) } catch {}
            const kept={redacted:true,redactedAt:new Date().toISOString(),normalizedMailHash,legacy:!data.templateSnapshot,
              taskId:data.taskId,scheduled:data.scheduled,source:data.source,draftId:data.draftId,deliveryId:data.deliveryId,
              rootDeliveryId:data.rootDeliveryId,attempt:data.attempt,origin:data.origin,errorCode:data.errorCode}
            await this.service.repo.put(entry.id,entry.kind,entry.status,kept,entry.hash)
          }
          completed.push(item.id)
        } catch {failed.push(item.id)}
      }
      const result={planId,completed,failed}
      await this.service.repo.put(row.id,'cleanup-plan',failed.length?'partial':'applied',result,row.hash)
      return result
    })
  }
  async tick(now=new Date()) {
    if(!this.service.config.cleanupEnabled) return
    const last=await this.service.repo.get('maintenance:last')
    if(last && now.getTime()-+new Date(last.updatedAt)<86400000) return
    try {
      const plan=await this.plan(this.service.config.retentionDays ?? 30,now)
      const result=await this.apply(plan.planId,true)
      await this.service.repo.put('maintenance:last','maintenance','completed',{completed:result.completed.length,failed:result.failed.length})
    } catch {
      // Busy services retry later; no unsafe cleanup is performed.
    }
  }
}
