import {open} from 'node:fs/promises'
import type {Assets} from './assets.js'
import type {Repository} from './repository.js'
import {WorkflowError,sameOwner,type WorkflowPolicy} from './workflow-policy.js'
import {digest} from './repository.js'
export class MediaBridge {
 private tail:Promise<unknown>=Promise.resolve()
 constructor(readonly policy:WorkflowPolicy,readonly assets:Assets,readonly repo:Repository){}
 async importImage(taskId:number,index=0,guard:()=>Promise<void>=async()=>{}){
  const work=async()=>{
   const settings=await this.policy.settings(),media=this.policy.media()
   if(!settings.mediaImportEnabled || settings.mediaOwnerId==null) throw new WorkflowError('MEDIA_IMPORT_DISABLED','Media image import is disabled')
   if(!Number.isSafeInteger(taskId)||taskId<1||!Number.isInteger(index)||index<0||index>4)throw new WorkflowError('MEDIA_INVALID_SELECTION','Media task id or image index is invalid')
   if(!media?.tasks?.getById || !media?.cache?.get)throw new WorkflowError('MEDIA_API_UNAVAILABLE','MediaLuna task/cache API is unavailable')
   await guard()
   const task=await media.tasks.getById(taskId)
   if(!task || !sameOwner(task.uid,settings.mediaOwnerId))throw new WorkflowError('MEDIA_TASK_NOT_ALLOWED','Media task is unavailable or belongs to another owner')
   if(task.status!=='success')throw new WorkflowError('MEDIA_TASK_NOT_READY','Media task has not completed successfully')
   const output=task.responseSnapshot?.[index]
   if(output?.kind!=='image'||typeof output.url!=='string')throw new WorkflowError('MEDIA_IMAGE_UNAVAILABLE','Media task output is not a cached image')
   // Resolve only URLs already recorded by MediaLuna. Never fetch a URL or accept a caller-supplied filesystem path.
   const rows=await (this.policy.ctx.database as any).get('medialuna_asset_cache',{cachedUrl:output.url,backend:'local'},['contentHash'])
   const cached=rows[0]?.contentHash ? await media.cache.get(rows[0].contentHash):null
   if(!cached || cached.url!==output.url || cached.backend && cached.backend!=='local' || !cached.localPath || cached.size>5*1024*1024)
    throw new WorkflowError('MEDIA_LOCAL_CACHE_REQUIRED','Media image requires an available local cache file no larger than 5 MiB')
   const mapping='media-image:'+taskId+':'+index
   const prior=await this.repo.get(mapping)
   const referenceHash=digest({owner:task.uid,url:output.url,cacheId:cached.id})
   if(prior && prior.hash===referenceHash){
    const assetId=JSON.parse(prior.payload).assetId,row=await this.repo.get('asset:'+assetId)
    if(row?.status==='ready') {await guard();await this.policy.checkRevision(settings);return JSON.parse(row.payload)}
   }
   const handle=await open(cached.localPath,'r')
   let bytes:Buffer
   try{
    const stat=await handle.stat()
    if(!stat.isFile()||stat.size<1||stat.size>5*1024*1024)throw new WorkflowError('MEDIA_IMAGE_SIZE','Media image size is invalid')
    const buffer=Buffer.alloc(stat.size+1),result=await handle.read(buffer,0,buffer.length,0)
    if(result.bytesRead!==stat.size)throw new WorkflowError('MEDIA_IMAGE_CHANGED','Media image changed while being imported')
    bytes=buffer.subarray(0,result.bytesRead)
   }finally{await handle.close()}
   await guard();await this.policy.checkRevision(settings)
   const asset=await this.assets.importBytes(bytes,false)
   await this.repo.put(mapping,'asset-link','ready',{assetId:asset.id,taskId,index},referenceHash)
   return asset
  }
  const next=this.tail.then(work,work);this.tail=next.catch(()=>{});return next
 }
}
