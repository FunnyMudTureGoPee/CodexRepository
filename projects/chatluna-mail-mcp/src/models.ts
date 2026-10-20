import type { Context } from 'koishi'
import { z } from 'zod'
import type { Repository } from './repository.js'

export const modelSettingsSchema=z.object({defaultModel:z.string().trim().max(200).default('')}).strict()
export class MailModels {
  private writes:Promise<unknown>=Promise.resolve()
  constructor(readonly ctx:Context,readonly repo:Repository) {}
  async settings() {
    const row=await this.repo.get('settings:models')
    return {...modelSettingsSchema.parse(row?JSON.parse(row.payload):{}),hash:row?.hash ?? ''}
  }
  async catalog() {
    const cl=(this.ctx as unknown as {chatluna?:any}).chatluna
    const result:{models:Array<{id:string;platform:string;name:string}>;presets:string[];conversations:Array<{id:string;title:string;model:string;preset:string}>;warnings:string[]}={models:[],presets:[],conversations:[],warnings:[]}
    if(!cl) {result.warnings.push('ChatLuna 尚未启用，请先启用主插件及模型适配器。');return result}
    try {
      // ChatLuna ModelType.llm = 1; use its public registry without creating a model or requesting generation.
      const rows=cl.platform.listAllModels(1).value
      result.models=Array.from(new Map<string,{id:string;platform:string;name:string}>(rows.filter((m:any)=>m.type===1).map((m:any)=>{
        const id=typeof m.toModelName==='function'?m.toModelName():m.platform+'/'+m.name
        return [id,{id,platform:String(m.platform),name:String(m.name)}]
      })).values()).sort((a,b)=>a.id.localeCompare(b.id))
      if(!result.models.length) result.warnings.push('未发现聊天模型，请在 ChatLuna 模型适配器中配置并启用模型后刷新。')
    } catch {result.warnings.push('当前 ChatLuna 模型目录不可用，请检查主插件及适配器状态。')}
    try {result.presets=cl.preset.getAllPreset().value.filter((v:unknown)=>typeof v==='string').sort()} catch {result.warnings.push('预设列表暂不可用，可继续跟随会话预设。')}
    try {
      // Console authority 4 administrators may select active conversations; never expose history, creator or credentials here.
      result.conversations=await (this.ctx.database as any).get('chatluna_conversation',{status:'active'},{
        fields:['id','title','model','preset'],sort:{updatedAt:'desc'},limit:100,
      })
    } catch {result.warnings.push('会话列表暂不可用，可在高级设置中填写会话 ID。')}
    return result
  }
  async save(input:unknown,expectedHash:string) {
    const operation=async()=>{
      const value=modelSettingsSchema.parse(input)
      if((await this.settings()).hash!==expectedHash) throw new Error('模型设置已被修改，请刷新后重试')
      if(value.defaultModel && !(await this.catalog()).models.some(m=>m.id===value.defaultModel)) throw new Error('所选模型不在 ChatLuna 聊天模型目录中，请刷新后选择')
      await this.repo.put('settings:models','settings','active',value)
      return this.settings()
    }
    const next=this.writes.then(operation,operation);this.writes=next.catch(()=>{});return next
  }
  async resolve(task:{model:string;useDefaultModel:boolean},conversationModel:string) {
    if(task.model) return task.model
    if(!task.useDefaultModel) return conversationModel
    const model=(await this.settings()).defaultModel
    if(!model) throw new Error('邮件默认模型尚未配置，请到模型设置中选择')
    return model
  }
}
