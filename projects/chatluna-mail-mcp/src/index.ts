import { Context, Schema } from 'koishi'
import type {} from '@koishijs/plugin-server'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config as MailConfig } from './types.js'
import { Repository, registerModels } from './repository.js'
import { Assets } from './assets.js'
import { MailService } from './service.js'
import { Scheduler } from './scheduler.js'
import { registerMcp } from './mcp.js'
import { registerConsole } from './console.js'
export { registerModels }
export const name='chatluna-mail-mcp'
export const inject={required:['database','server'],optional:['chatluna','console','mediaLuna']}
export const Config:Schema<MailConfig>=Schema.object({
  endpoint:Schema.string().default('/mcp/mail').description('本机 MCP 路径'),
  token:Schema.string().role('secret').required().description('MCP Bearer Token，24-256 位可打印 ASCII 字符，不含空格或中文。共用此令牌的 Agent 共享权限。'),
  enabled:Schema.boolean().default(false).description('允许真实发信和定时任务；未配置邮箱时保持关闭'),
  allowAgentManage:Schema.boolean().default(false).description('允许共用 MCP 令牌的 Agent 创建、修改及启停任务和模板，可读取活跃会话目录；定时发信仍受总开关和白名单限制'),
  allowAgentSend:Schema.boolean().default(false).description('允许 MCP Agent 主动发送白名单内邮件'),
  allowedRecipients:Schema.array(Schema.string()).default([]).description('允许的收件地址，逐个精确匹配'),
  smtpHost:Schema.string().default(''),smtpPort:Schema.number().min(1).max(65535).default(465),
  smtpSecure:Schema.boolean().default(true).description('465 使用隐式 TLS；关闭时强制 STARTTLS'),
  smtpUser:Schema.string().default(''),smtpPassword:Schema.string().role('secret').default(''),
  from:Schema.string().default('').description('已获 SMTP 服务授权的发件邮箱'),
  maxPerDay:Schema.number().min(1).max(100).default(10).description('UTC 日发送尝试上限（含失败和未知）'),
  modelTimeoutMs:Schema.number().min(1000).max(300000).default(120000),
  maxContextChars:Schema.number().min(2000).max(200000).default(64000),
  maxDecisionsPerHour:Schema.number().min(1).max(1000).default(60).description('手动和定时判断共用的每小时调用次数上限'),
  autoRetryEnabled:Schema.boolean().default(false).description('允许任务对明确暂时性失败自动重试；未知结果不重发'),
  maxRetryAttempts:Schema.number().min(0).max(5).default(2).description('每封邮件重试上限，包含手动重试'),
  retryDelayMinutes:Schema.number().min(1).max(1440).default(5).description('自动重试基础等待分钟数，后续指数退避'),
  cleanupEnabled:Schema.boolean().default(false).description('按保留期自动精简旧内容；幂等标识保留，默认关闭'),
  retentionDays:Schema.number().min(1).max(3650).default(30).description('历史正文和草稿保留天数；仅未固定的孤立图片可移入回收区')
})
export function apply(ctx:Context,config:MailConfig) {
  if(!/^[\x21-\x7e]{24,256}$/.test(config.token)) throw new Error('Mail MCP token must contain 24-256 visible ASCII characters; no spaces or Chinese')
  if(!/^\/[a-zA-Z0-9/_-]+$/.test(config.endpoint)) throw new Error('Invalid endpoint')
  if(config.enabled && (!config.smtpHost || !config.from || !config.allowedRecipients.length)) throw new Error('Configure SMTP/from/recipients before enabling')
  registerModels(ctx)
  const repo=new Repository(ctx), assets=new Assets(join(ctx.baseDir,'data','chatluna-mail','assets'),repo)
  const service=new MailService(ctx,config,repo,assets),scheduler=new Scheduler(service)
  const logger=ctx.logger(name)
  const command=(name:string,description:string,fn:(...args:any[])=>Promise<unknown>)=>
    ctx.command(name,description,{authority:4}).action(async(_, ...args)=>{
      try{return JSON.stringify(await fn(...args),null,2)}
      catch(e){return '操作失败：'+(e instanceof Error ? e.message:'请检查配置')}
    })
  command('mail.status','邮件插件状态',async()=>({enabled:config.enabled,agentSend:config.allowAgentSend,endpoint:config.endpoint,taskCount:(await repo.list('task')).length,deliveryCount:(await repo.list('delivery')).length}))
  command('mail.tasks','查看邮件任务及下次执行时间',async()=>service.tasks())
  command('mail.task-import <path:text>','从本机 JSON 文件导入管理员授权的任务',async(path:string)=>{
    if(!path || (await stat(path)).size>65536) throw new Error('Task file missing or >64 KiB')
    return service.saveTask(JSON.parse(await readFile(path,'utf8')))
  })
  command('mail.enable <id:string>','启用指定邮件任务',async(id:string)=>service.toggle(id,true))
  command('mail.disable <id:string>','停用指定邮件任务',async(id:string)=>service.toggle(id,false))
  command('mail.evaluate <id:string>','试判断并生成草稿，不发信',async(id:string)=>service.evaluate(id))
  command('mail.asset-import <path:text>','管理员导入 PNG/JPEG 图片',async(path:string)=>assets.import(path))
  command('mail.assets','列出可用图片',async()=>assets.list())
  command('mail.preview <id:string>','预览草稿内容',async(id:string)=>service.preview(id))
  command('mail.send <id:string> <key:string>','显式发送草稿（需要全局发信开关）',async(id:string,key:string)=>service.sendDraft(id,'admin:'+key))
  command('mail.delivery <id:text>','查询投递状态',async(id:string)=>{const e=await repo.get(id);if(!e || e.kind!=='delivery') throw new Error('Delivery not found');return service.publicEntry(e)})
  command('mail.runs','最近 20 次判断结果',async()=>(await repo.list('run')).sort((a,b)=>+new Date(b.createdAt)-+new Date(a.createdAt)).slice(0,20).map(e=>({id:e.id,status:e.status,at:e.createdAt,...JSON.parse(e.payload)})))
  command('mail.pause','立即暂停本次插件实例发信；长期暂停请关闭配置开关',async()=>{service.stopped=true;return {paused:true}})
  command('mail.task-archive <id:string>','归档已停用任务并保留执行记录',async(id:string)=>service.archiveTask(id))
  command('mail.diagnose <id:string>','诊断预设、上下文和模型，不调用 LLM',async(id:string)=>service.diagnose(id))
  command('mail.retry <id:text>','为明确失败投递安排受控重试',async(id:string)=>service.retries.queue(id))
  command('mail.retry-cancel <id:text>','取消尚未执行的重试',async(id:string)=>service.retries.cancel(id))
  command('mail.cleanup-preview','预览按保留期清理的范围，不执行清理',async()=>service.maintenance.plan())
  command('mail.cleanup-apply <id:string>','确认执行指定清理预览，正文清理不可恢复',async(id:string)=>service.maintenance.apply(id,true))
  command('mail.asset-restore <id:string>','恢复回收区中的图片',async(id:string)=>service.withMaintenance(()=>assets.restore(id)))
  command('mail.resume','恢复当前实例；仍受配置总开关限制',async()=>{service.stopped=false;return {paused:false}})
  command('mail.templates','列出模板与版本',async()=>service.templates.list())
  command('mail.template-import <path:text>','从 JSON 导入自定义提示词和排版',async(path:string)=>{
    if(!path || (await stat(path)).size>65536) throw new Error('Template file missing or >64 KiB')
    return service.templates.save(JSON.parse(await readFile(path,'utf8')))
  })
  ctx.inject(['console'],consoleCtx=>registerConsole(consoleCtx,service))
  ctx.on('ready',async()=>{
    await repo.recover()
    await service.workflow.recoverLocks()
    registerMcp(ctx,service)
    ctx.setInterval(()=>{
      void scheduler.tick().catch(()=>logger.warn('Scheduler failed; inspect task configuration/database'))
      void service.retries.tick().catch(()=>logger.warn('Retry processing failed'))
    },15000)
    ctx.setInterval(()=>{void service.maintenance.tick().catch(()=>logger.warn('Maintenance failed'))},3600000)
    logger.info('Mail MCP ready: %s; sending=%s',config.endpoint,config.enabled)
  })
  ctx.on('dispose',()=>{service.stopped=true})
}
