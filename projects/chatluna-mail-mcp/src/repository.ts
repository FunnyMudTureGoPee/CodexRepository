import type { Context } from 'koishi'
import { createHash } from 'node:crypto'
import type { Entry } from './types.js'
export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
export function registerModels(ctx: Context) {
  ctx.model.extend('chatluna_mail', {
    id: {type:'string',length:128}, kind: {type:'string',length:20}, status: {type:'string',length:32},
    payload:'text', hash:{type:'string',length:64}, createdAt:'timestamp', updatedAt:'timestamp'
  }, {primary:'id'})
}
export class Repository {
  constructor(readonly ctx: Context) {}
  async get(id: string) { return (await this.ctx.database.get('chatluna_mail',{id}))[0] as Entry | undefined }
  async list(kind: string) { return this.ctx.database.get('chatluna_mail',{kind}) }
  async put(id:string, kind:string, status:string, data:unknown, hash = digest(data)) {
    const existing = await this.get(id)
    const entry = {id,kind,status,payload:JSON.stringify(data),hash,createdAt:existing?.createdAt ?? new Date(),updatedAt:new Date()}
    await this.ctx.database.upsert('chatluna_mail',[entry])
    return entry
  }
  async claim(id:string, kind:string, data:unknown, hash = digest(data)) {
    try {
      const now = new Date()
      await this.ctx.database.create('chatluna_mail',{id,kind,status:'running',payload:JSON.stringify(data),hash,createdAt:now,updatedAt:now})
      return true
    } catch(error) { if(await this.get(id)) return false; throw error }
  }
  async recover() {
    for (const kind of ['delivery','run','retry']) for(const e of await this.list(kind)) {
      if(e.status === 'sending' || e.status === 'running') await this.put(e.id,e.kind,e.kind === 'delivery' ? 'unknown' : e.kind === 'retry' ? 'scheduled' : 'interrupted',JSON.parse(e.payload),e.hash)
    }
  }
}
