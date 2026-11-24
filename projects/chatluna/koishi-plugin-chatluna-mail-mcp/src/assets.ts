import { mkdir, readFile, realpath, stat, writeFile, rename, access } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Repository } from './repository.js'
import type { Asset, Mail } from './types.js'
export class Assets {
  constructor(readonly dir:string,readonly repo:Repository) {}
  async import(path:string) {
    const info = await stat(path)
    if(info.size > 5*1024*1024 || !info.isFile()) throw new Error('Image must be a file <= 5 MiB')
    return this.importBytes(await readFile(path))
  }
  async importBytes(bytes:Buffer,pinned=true) {
    if(bytes.length<1 || bytes.length>5*1024*1024) throw new Error('Image must be <= 5 MiB')
    let mime:string, ext:string
    if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {mime='image/png';ext='png'}
    else if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255) {mime='image/jpeg';ext='jpg'}
    else throw new Error('Only PNG and JPEG images are supported')
    const id=randomUUID(), asset:Asset={id,name:id+'.'+ext,mime,bytes:bytes.length,pinned}
    await mkdir(this.dir,{recursive:true}); await writeFile(join(this.dir,asset.name),bytes,{flag:'wx'})
    await this.repo.put('asset:'+id,'asset','ready',asset)
    return asset
  }
  async setPinned(id:string,pinned:boolean) {
    const row=await this.repo.get('asset:'+id)
    if(!row || row.status!=='ready') throw new Error('Asset is not ready')
    const data={...JSON.parse(row.payload),pinned}
    await this.repo.put(row.id,'asset','ready',data)
    return data
  }
  async list() { return (await this.repo.list('asset')).filter(e=>e.status==='ready').map(e=>JSON.parse(e.payload) as Asset) }
  private async location(name:string,trash=false) {
    if(!/^[a-f0-9-]+\.(png|jpg)$/.test(name)) throw new Error('Invalid asset filename')
    await mkdir(this.dir,{recursive:true})
    const base=await realpath(this.dir)
    let folder=base
    if(trash) {
      await mkdir(join(base,'.trash'),{recursive:true})
      folder=await realpath(join(base,'.trash'))
      const rel=relative(base,folder)
      if(rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid asset trash path')
    }
    return join(folder,name)
  }
  async trash(id:string) {
    const row=await this.repo.get('asset:'+id)
    if(!row || row.status!=='ready') throw new Error('Asset is not ready')
    const data=JSON.parse(row.payload),source=await realpath(await this.location(data.name)),target=await this.location(data.name,true)
    const rel=relative(await realpath(this.dir),source)
    if(rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid asset path')
    try {await access(target);throw new Error('Asset trash already exists')} catch(e:any) {if(e?.code!=='ENOENT') throw e}
    await rename(source,target)
    await this.repo.put(row.id,'asset','trashed',{...data,trashedAt:new Date().toISOString()},row.hash)
    return {id,status:'trashed'}
  }
  async restore(id:string) {
    const row=await this.repo.get('asset:'+id)
    if(!row) throw new Error('Asset not found')
    const data=JSON.parse(row.payload),source=await realpath(await this.location(data.name,true)),target=await this.location(data.name)
    const rel=relative(await realpath(this.dir),source)
    if(rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid asset path')
    try {await access(target);throw new Error('Asset destination already exists')} catch(e:any) {if(e?.code!=='ENOENT') throw e}
    await rename(source,target)
    await this.repo.put(row.id,'asset','ready',{id:data.id,name:data.name,mime:data.mime,bytes:data.bytes,pinned:true},row.hash)
    return {id,status:'ready'}
  }
  async attachments(mail:Mail) {
    const out=[]
    for(const [n,image] of mail.images.entries()) {
      const row=await this.repo.get('asset:'+image.assetId)
      if(!row || row.status!=='ready') throw new Error('Unknown image asset')
      const a=JSON.parse(row.payload) as Asset
      const base=await realpath(this.dir), path=await realpath(join(base,a.name)), rel=relative(base,path)
      if(rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid asset path')
      if((await stat(path)).size > 5*1024*1024) throw new Error('Image too large')
      const content=await readFile(path)
      out.push({filename:a.name,content,contentType:a.mime,cid:'image-'+n+'@chatluna-mail'})
    }
    if(out.reduce((n,a)=>n+a.content.length,0)>10*1024*1024) throw new Error('Total images exceed 10 MiB')
    return out
  }
}
