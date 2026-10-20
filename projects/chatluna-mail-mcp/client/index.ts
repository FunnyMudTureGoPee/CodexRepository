import { defineComponent, h, onMounted, nextTick, reactive, ref, resolveComponent } from 'vue'
import { daysInMonth, localParts, scheduledInstant, splitTime, variableDefinitions } from './task-form'
import { icons, send, type Context } from '@koishijs/client'

export const freshTask = () => ({
  id: '', name: '', useDefaultModel:false, enabled: false, scheduleType: 'daily', time: '09:00', timezone: 'Asia/Shanghai',
  weekdays: [1], runAt: '', conversationId: '', preset: '', model: '',
  prompt: '根据主插件预设和当前聊天上下文，判断是否有值得主动通知的新事项。没有必要时不发送；有必要时生成简洁邮件。',
  to: [] as string[], templateId: 'briefing', variables: {}, historyLimit: 60, cooldownMinutes: 60,
  executionMode:'context',tools:[] as string[],workflowImages:false,toolFailurePolicy:'stop',
  retryOnFailure:false,contextMode:'recent',contextMaxAgeHours:0,minNewMessages:0,contextOverflow:'reject',
})
export const freshTemplate = () => ({
  id: '', name: '', prompt: '根据当前上下文生成简洁的图文通知，不虚构事实或图片。',
  fields: {}, layout: { accent: '#2563eb', background: '#ffffff', textColor: '#1f2937', width: 640, heading: true, footer: '' },
})

const css = `
.mail-viewport{height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;overscroll-behavior-y:contain;background:var(--k-page-bg,#f5f7fb);color:var(--k-text-normal,var(--fg1,#334155));--mail-panel:var(--k-card-bg,#fff);--mail-border:var(--k-color-divider,#e2e8f0);--mail-muted:var(--k-text-light,#64748b);--mail-strong:var(--k-text-dark,var(--fg1,#0f172a));--mail-accent:var(--k-color-primary,#5268eb);--mail-tint:var(--k-color-primary-fade,rgba(82,104,235,.09));--mail-hover:var(--k-hover-bg,#f1f5f9)}
.mail-viewport:focus-visible{outline:2px solid var(--mail-accent);outline-offset:-2px}
.mail-viewport::-webkit-scrollbar,.mail-admin .scroll::-webkit-scrollbar,.mail-admin pre::-webkit-scrollbar{width:10px;height:9px}
.mail-viewport::-webkit-scrollbar-thumb,.mail-admin .scroll::-webkit-scrollbar-thumb,.mail-admin pre::-webkit-scrollbar-thumb{background:var(--k-color-border,#94a3b8);border:2px solid var(--k-page-bg,#f5f7fb);border-radius:10px}
.mail-viewport::-webkit-scrollbar-thumb:hover{background:var(--mail-muted)}
.mail-admin{padding:28px 30px 36px;max-width:1320px;margin:0 auto;box-sizing:border-box;font-size:14px;line-height:1.55}
.mail-admin *{box-sizing:border-box}.mail-admin h2{margin:0;font-size:26px;font-weight:700;letter-spacing:.02em;color:var(--mail-strong)}.mail-admin h3{margin:26px 0 14px;font-size:17px;font-weight:650;color:var(--mail-strong)}.mail-admin p{line-height:1.75;margin:10px 0}.mail-admin .hero{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}.mail-admin .hero-title{display:flex;align-items:center;gap:15px}.mail-admin .hero-icon{display:flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:16px;background:var(--mail-tint);color:var(--mail-accent);flex-shrink:0}.mail-admin .hero-icon svg{width:28px;height:28px}.mail-admin .hero p{margin:4px 0 0}.mail-admin .version{border:1px solid var(--mail-border);border-radius:20px;padding:5px 12px;font-size:12px;color:var(--mail-muted);white-space:nowrap}
.mail-admin .stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:16px}.mail-admin .stat{background:var(--mail-panel);border:1px solid var(--mail-border);border-radius:14px;padding:16px 19px;display:flex;justify-content:space-between;align-items:center;gap:12px}.mail-admin .stat-label{font-size:12px;color:var(--mail-muted)}.mail-admin .stat-value{font-size:19px;font-weight:650;color:var(--mail-strong);margin-top:4px;overflow-wrap:anywhere}.mail-admin .stat-symbol{color:var(--mail-accent);width:28px;height:28px;flex-shrink:0}.mail-admin .recipient-info{color:var(--mail-muted);font-size:12px;overflow-wrap:anywhere;margin-bottom:18px}
.mail-admin .navigation{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:8px;justify-content:space-between;padding:10px;margin-bottom:22px;border:1px solid var(--mail-border);border-radius:12px;background:var(--mail-panel);box-shadow:0 4px 16px #00000008}.mail-admin .tabs,.mail-admin .nav-tools{display:flex;gap:5px;align-items:center;flex-wrap:wrap}.mail-admin .navigation .tab{border-color:transparent;background:transparent;color:var(--mail-muted);padding:9px 15px;white-space:nowrap}.mail-admin .navigation .tab.active{background:var(--mail-tint);color:var(--mail-accent);font-weight:650}.mail-admin .nav-tools button{font-size:12px;padding:8px 10px}.mail-admin .bar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:14px 0}
.mail-admin button{padding:8px 14px;min-height:36px;border-radius:8px;border:1px solid var(--mail-border);background:var(--mail-panel);color:var(--mail-strong);cursor:pointer;font:inherit;line-height:1.4;transition:background .15s,border-color .15s,box-shadow .15s}.mail-admin button:hover:not(:disabled){background:var(--mail-hover);border-color:var(--mail-accent)}.mail-admin button:focus-visible,.mail-admin summary:focus-visible{outline:2px solid var(--mail-accent);outline-offset:3px}.mail-admin button:disabled{opacity:.5;cursor:wait}.mail-admin .primary{background:var(--mail-accent);color:#fff;border-color:var(--mail-accent);box-shadow:0 2px 5px #00000010}.mail-admin .primary:hover:not(:disabled){background:var(--mail-accent);filter:brightness(1.08)}.mail-admin .danger{color:var(--k-color-danger,#dc5151)}
.mail-admin .card{padding:24px;border:1px solid var(--mail-border);border-radius:14px;margin-bottom:22px;background:var(--mail-panel);box-shadow:0 2px 10px #00000003;min-width:0}.mail-admin .card>h3:first-child{margin-top:0}.mail-admin .card>h3:not(:first-child){padding-top:22px;border-top:1px solid var(--mail-border)}.mail-admin .editor-heading{scroll-margin-top:90px;outline:none}
.mail-admin details{margin:20px 0;border-top:1px solid var(--mail-border);padding-top:8px}.mail-admin details.card{border:1px solid var(--mail-border);padding:12px 20px}.mail-admin summary{cursor:pointer;font-weight:600;padding:12px 0;color:var(--mail-strong)}.mail-admin details[open]>summary{margin-bottom:14px}.mail-admin .variable-card{border:1px solid var(--mail-border);border-radius:12px;padding:18px;display:grid;gap:12px;background:var(--mail-tint);min-width:0}.mail-admin .chip{font-family:var(--font-family-code,monospace);color:var(--mail-accent);background:var(--mail-panel);padding:6px 10px;font-size:12px}.mail-admin .inline{display:flex;gap:10px;align-items:end;min-width:0}.mail-admin .inline>*{flex:1;min-width:0}.mail-admin .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:20px}
.mail-admin label{display:flex;flex-direction:column;gap:8px;font-size:13px;min-width:0}.mail-admin label>span{font-weight:500;color:var(--mail-strong)}.mail-admin input,.mail-admin select,.mail-admin textarea{padding:10px 12px;border:1px solid var(--mail-border);border-radius:8px;background:var(--k-page-bg,var(--mail-panel));color:inherit;font:inherit;box-sizing:border-box;width:100%;min-width:0;transition:border-color .15s,box-shadow .15s}.mail-admin input:focus,.mail-admin select:focus,.mail-admin textarea:focus{outline:none;border-color:var(--mail-accent);box-shadow:0 0 0 3px var(--mail-tint)}.mail-admin input::placeholder,.mail-admin textarea::placeholder{color:var(--mail-muted);opacity:.8}.mail-admin input:disabled{opacity:.6}.mail-admin input[type=checkbox]{width:16px;height:16px;accent-color:var(--mail-accent);flex-shrink:0}.mail-admin input[type=color]{height:42px;padding:5px}.mail-admin textarea{min-height:120px;resize:vertical;line-height:1.7}.mail-admin select{min-height:42px}
.mail-admin table{width:100%;min-width:620px;border-collapse:separate;border-spacing:0;font-size:13px;background:var(--mail-panel)}.mail-admin td,.mail-admin th{padding:15px 16px;border-bottom:1px solid var(--mail-border);text-align:left;vertical-align:middle;overflow-wrap:anywhere}.mail-admin th{font-size:12px;font-weight:600;color:var(--mail-muted);background:var(--mail-hover)}.mail-admin tr{border:none}.mail-admin tbody tr:last-child td{border-bottom:none}.mail-admin tbody tr:hover{background:var(--mail-hover)}.mail-admin td .bar{margin:0;gap:6px}.mail-admin td button{padding:6px 9px;font-size:12px;min-height:31px}.mail-admin .scroll{max-width:100%;overflow-x:auto;overflow-y:hidden;border:1px solid var(--mail-border);border-radius:12px;margin-bottom:20px}.mail-admin .muted{color:var(--mail-muted);font-size:12px}
.mail-admin .notice{padding:13px 16px;border:1px solid transparent;border-radius:10px;background:var(--mail-tint);color:var(--mail-accent);white-space:pre-wrap;font-size:13px;line-height:1.7}.mail-admin .error{background:var(--k-color-danger-fade,rgba(220,81,81,.09));color:var(--k-color-danger,#dc5151)}.mail-admin pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--font-family-code,monospace);font-size:12px;max-height:300px;overflow:auto;line-height:1.7}.mail-admin iframe{width:100%;height:420px;border:1px solid var(--mail-border);border-radius:10px;background:#fff}.mail-admin .wide{grid-column:1/-1}.mail-admin .footer{margin-top:26px;padding-top:16px;border-top:1px solid var(--mail-border)}
@media(max-width:1000px){.mail-admin .navigation{align-items:flex-start;flex-direction:column}.mail-admin .nav-tools{justify-content:flex-end;width:100%}.mail-admin .editor-heading{scroll-margin-top:135px}}
@media(max-width:600px){.mail-admin{padding:18px 14px 28px}.mail-admin .hero{align-items:flex-start}.mail-admin h2{font-size:22px}.mail-admin .hero-icon{width:42px;height:42px;border-radius:12px}.mail-admin .hero p{max-width:240px}.mail-admin .stats{gap:8px}.mail-admin .stat{padding:12px;display:block}.mail-admin .stat-value{font-size:16px}.mail-admin .stat-symbol{display:none}.mail-admin .card{padding:18px 15px}.mail-admin .navigation{gap:6px;padding:7px}.mail-admin .tabs{display:flex;flex-wrap:nowrap;overflow-x:auto;width:100%;padding-bottom:3px}.mail-admin .navigation .tab{padding:8px 10px;font-size:12px;flex-shrink:0}.mail-admin .grid{gap:16px}.mail-admin .version{padding:4px 8px}.mail-admin td,.mail-admin th{padding:12px}}
@media(prefers-reduced-motion:reduce){.mail-admin *{transition:none!important;scroll-behavior:auto!important}}
`
const MailIcon=defineComponent({name:'MailEnvelopeIcon',setup:()=>()=>h('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.7,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'},[
  h('rect',{x:3,y:5,width:18,height:14,rx:3}),h('path',{d:'m4 7 8 6 8-6'}),
])})

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const dateText = (s: string | null | undefined) => s ? new Date(s).toLocaleString() : '—'
const weekdays = ['周一','周二','周三','周四','周五','周六','周日']

export const MailPage = defineComponent({
  setup() {
    const viewport=ref<HTMLElement|null>(null),taskEditor=ref<HTMLElement|null>(null),templateEditor=ref<HTMLElement|null>(null)
    const focusEditor=(target:typeof taskEditor)=>{void nextTick(()=>{target.value?.scrollIntoView({block:'start'});target.value?.focus({preventScroll:true})})}
    const switchTab=(value:string)=>{tab.value=value;notice.value='';resultDetails.value=null;viewport.value?.scrollTo({top:0})}
    const data = ref<any>({ tasks: [], templates: [], assets: [], runs: [], deliveries: [], allowedRecipients: [] })
    const tab = ref('tasks'), busy = ref(false), notice = ref(''), error = ref(false), resultDetails=ref<any>(null)
    const task = reactive(freshTask()), expectedHash = ref(''), taskExisting = ref(false)
    const toText = ref(''), variableText = ref('{}')
    const defaultModel=ref(''), modelHash=ref('')
    const workflowSettings=ref<any>({}),workflowHash=ref('')
    const date=reactive(localParts(new Date(Date.now()+86400000).toISOString(),'Asia/Shanghai'))
    const variableRows=ref<Array<{name:string;required:boolean;default:string}>>([])
    const selections:Record<string,[number,number]>={}
    const previewValues=ref<Record<string,string>>({})
    const template = reactive(freshTemplate()), expectedVersion = ref(0), templateExisting = ref(false)
    const preview = ref<any>(null), previewDraft = ref('')
    const recordKind=ref('run'),recordStatus=ref(''),recordPage=ref(1),recordData=ref<any>(null),cleanupPlan=ref<any>(null)
    const formatError = (e: unknown) => typeof e === 'string' ? e.split('\n')[0].replace(/^Error:\s*/,'') : e instanceof Error ? e.message : '操作失败'
    async function refresh() { data.value = await send('mail-admin/snapshot');defaultModel.value=data.value.modelSettings.defaultModel;modelHash.value=data.value.modelSettings.hash;const {hash,...settings}=data.value.workflowSettings;workflowSettings.value=settings;workflowHash.value=hash }
    async function action(fn: () => Promise<void>) {
      if (busy.value) return
      busy.value = true; notice.value = ''; error.value = false; resultDetails.value=null
      try { await fn(); if (!notice.value) notice.value = '操作完成' }
      catch (e) { error.value = true; notice.value = formatError(e) }
      finally { busy.value = false }
    }
    onMounted(()=>{busy.value=true;void refresh().catch(e=>{error.value=true;notice.value=formatError(e)}).finally(()=>busy.value=false)})
    const button = (label: string, fn: () => Promise<void> | void, cls = '', urgent = false) =>
      h('button', { type:'button',class:cls,disabled:busy.value && !urgent,onClick:()=>{
        if(urgent) void Promise.resolve().then(fn).catch(e=>{error.value=true;notice.value=formatError(e)})
        else void action(async()=>{await fn()})
      } },label)
    function input(label: string, value: any, update: (v: string) => void, type = 'text', attrs: Record<string,unknown> = {}) {
      return h('label', [h('span', label), h('input', { type, value, 'aria-label':label, ...attrs, onInput: (e: Event) => update((e.target as HTMLInputElement).value) })])
    }
    const area = (label:string,value:string,update:(v:string)=>void) =>
      h('label',{class:'wide'},[h('span',label),h('textarea',{'aria-label':label,value,onSelect:(e:Event)=>{const el=e.target as HTMLTextAreaElement;selections[label]=[el.selectionStart,el.selectionEnd]},onInput:(e:Event)=>update((e.target as HTMLTextAreaElement).value)})])
    const select = (label:string,value:string,items:Array<[string,string]>,update:(v:string)=>void) =>
      h('label',[h('span',label),h('select',{'aria-label':label,value,onChange:(e:Event)=>update((e.target as HTMLSelectElement).value)},items.map(([id,name])=>h('option',{value:id},name)))])
    const check = (label:string,value:boolean,update:(v:boolean)=>void) =>
      h('label',{style:'display:flex;flex-direction:row;align-items:center;gap:8px'},[h('input',{type:'checkbox',checked:value,onChange:(e:Event)=>update((e.target as HTMLInputElement).checked)}),label])
    function editTask(row?:any) {
      Object.assign(task, freshTask(), row ? clone(row.task) : {})
      taskExisting.value = !!row; expectedHash.value = row?.hash ?? ''
      Object.assign(date,localParts(task.runAt || new Date(Date.now()+86400000).toISOString(),task.timezone))
      if(task.scheduleType==='once' && task.runAt) task.time=date.hour+':'+date.minute
      toText.value = task.to.join(', '); variableText.value = JSON.stringify(task.variables,null,2)
    }
    function editTemplate(value?:any, copy=false) {
      const loaded = value ? clone(value) : freshTemplate()
      const {version,...definition} = loaded
      Object.assign(template,freshTemplate(),definition)
      if(copy) {template.id='';template.name+='（副本）'}
      templateExisting.value=!!value && !copy
      expectedVersion.value=copy ? 0 : version ?? 0
      variableRows.value=Object.entries(template.fields).map(([name,v]:[string,any])=>({name,required:v.required,default:v.default}))
      previewValues.value={}
    }
    async function saveTask() {
      const value={...clone(task),id:task.id || 'mail-'+crypto.randomUUID().slice(0,12),to:toText.value.split(/[,;，；\n]/).map(s=>s.trim()).filter(Boolean),variables:JSON.parse(variableText.value)}
      if(!value.name.trim()) throw new Error('请填写任务名称')
      if(!value.conversationId) throw new Error('请选择上下文会话，或在高级设置中填写会话 ID')
      if(value.scheduleType==='once') value.runAt=scheduledInstant(date,value.time,value.timezone)
      await send('mail-admin/task-save',{task:value,expectedHash:expectedHash.value})
      await refresh();editTask(data.value.tasks.find((r:any)=>r.task.id===value.id))
      notice.value='任务已保存。发送仍受插件总开关和收件人白名单限制。'
    }
    async function saveTemplate() {
      const value={...clone(template),fields:variableDefinitions(variableRows.value)}
      const saved=await send('mail-admin/template-save',{template:value,expectedVersion:expectedVersion.value})
      await refresh();editTemplate(saved);notice.value='模板已保存为版本 '+saved.version+'，已有草稿保持原版本。'
    }
    async function evaluate(id:string) {
      const {jobId}=await send('mail-admin/evaluate',{id})
      let result:any
      const until=Date.now()+Math.max(150000,(data.value.workflowSettings?.timeoutSeconds??300)*1000+30000)
      while(Date.now()<until) {
        const job=await send('mail-admin/evaluation-result',{jobId})
        if(job.done) {result=job.result;break}
        await new Promise(resolve=>setTimeout(resolve,700))
      }
      if(!result) throw new Error('判断仍在后台运行，请稍后在执行记录查看结果')
      if(result.draftId) {preview.value=await send('mail-admin/preview',{id:result.draftId});previewDraft.value=result.draftId}
      resultDetails.value=result
      notice.value='判断结果：'+(result.decision?.shouldSend?'建议发送，已生成草稿':result.status==='skipped'?'本次不发送':result.status)+'\n'+(result.decision?.reason??result.detail??result.errorCode??'')+(result.source?.model?'\n使用模型：'+result.source.model:'')
      await refresh()
    }
    async function loadPreview(id:string) {preview.value=await send('mail-admin/preview',{id});previewDraft.value=id;switchTab('templates')}
    const table = (headers:string[],rows:any[][]) => h('div',{class:'scroll'},[
      h('table',[h('thead',[h('tr',headers.map(v=>h('th',v)))]),h('tbody',rows.length?rows.map(row=>h('tr',row.map(v=>h('td',v)))):[h('tr',[h('td',{colspan:headers.length},'暂无记录')])])])
    ])
    function insertVariable(label:string,value:string,update:(v:string)=>void,name:string) {
      if(!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('请先填写有效的变量名称')
      const [start,end]=selections[label]??[value.length,value.length], token='{{'+name+'}}'
      update(value.slice(0,start)+token+value.slice(end));selections[label]=[start+token.length,start+token.length]
    }
    function modelOptions(current=''):Array<[string,string]> {
      const models=(data.value.catalog?.models??[]).map((m:any)=>[m.id,m.platform+' / '+m.name] as [string,string])
      if(current && !models.some(([id]:[string,string])=>id===current)) models.unshift([current,current+'（当前未注册）'])
      return models
    }
    function modelPanel() {
      return [
        h('h3','邮件判断模型'),h('div',{class:'card'},[
          h('p','选择已在 ChatLuna 中配置的聊天模型，作为邮件任务的默认判断模型。每次任务只调用所选的一个模型。'),
          select('邮件默认模型',defaultModel.value,[['','尚未设置'],...modelOptions(defaultModel.value)],v=>defaultModel.value=v),
          h('div',{class:'bar'},[button('保存模型设置',async()=>{await send('mail-admin/model-save',{settings:{defaultModel:defaultModel.value},expectedHash:modelHash.value});await refresh();notice.value='邮件默认模型已保存；选择“邮件默认模型”的任务会在下次判断时使用。'},'primary'),button('刷新模型目录',refresh)]),
          h('p',{class:'notice'},'Agent 自主配置：'+(data.value.allowAgentManage?'已开启':'未开启')+'。请在本插件配置中设置 allowAgentManage；开启后 Agent 可创建模板、配置并启停任务。'),
          h('p',{class:'muted'},'模型接口地址、API Key 及供应商参数在 ChatLuna 对应模型适配器中配置。本页复用现有配置，不保存第二份密钥。跟随会话或指定模型的任务不受默认模型变更影响。'),
          ...(data.value.catalog?.warnings??[]).map((w:string)=>h('p',{class:'notice'},w)),
          table(['平台','聊天模型'],(data.value.catalog?.models??[]).map((m:any)=>[m.platform,m.name])),
        ]),
      ]
    }
    function workflowPanel() {
      const settings=workflowSettings.value
      return [
        h('h3','受控工具工作流'),
        ...(data.value.workflowLocks?.length?[h('div',{class:'card'},[
          h('h3','尚未确认完成的执行'),h('p',{class:'muted'},'超时后外部绘图可能仍在运行，当前任务会阻止再次执行。重启后留下的未知状态需先去 MediaLuna 检查结果，再确认释放；释放不会取消外部绘图。'),
          table(['任务','状态','操作'],data.value.workflowLocks.map((lock:any)=>[lock.id,lock.active?'外部步骤尚未结束':lock.status,lock.status==='unknown'&&!lock.active?button('确认已核对外部结果',async()=>{if(!window.confirm('已核对 MediaLuna 或其他外部工具结果？确认后允许下一次重新执行，可能再次产生费用。'))return;await send('mail-admin/workflow-resolve',{taskId:lock.id,expectedHash:lock.hash,confirm:true});await refresh()}):'等待外部步骤结束'])),
        ])]:[]),
        h('div',{class:'card'},[
          h('p','工具模式复用 ChatLuna Agent。先在这里授权工具与执行身份，再在任务中选择具体工具。一次任务由一个模型编排；发信仍统一经过邮件白名单和幂等检查。'),
          check('允许工具工作流',!!settings.enabled,v=>settings.enabled=v),
          h('h3','执行身份'),
          h('p',{class:'muted'},'必须使用真实存在且在线的机器人，以及有权使用相应工具的用户。此身份用于工具授权与 MediaLuna 计费，不会单独发送聊天回复。'),
          h('div',{class:'grid'},[
            select('执行机器人',settings.platform&&settings.selfId?settings.platform+':'+settings.selfId:'',[['','请选择在线机器人'],...(data.value.workflowBots??[]).map((b:any)=>[b.platform+':'+b.selfId,b.platform+' / '+b.selfId+' · '+b.status] as [string,string])],v=>{const bot=(data.value.workflowBots??[]).find((b:any)=>b.platform+':'+b.selfId===v);settings.platform=bot?.platform??'';settings.selfId=bot?.selfId??''}),
            input('执行用户的平台账号',settings.userId??'',v=>settings.userId=v,'text',{placeholder:'例如 QQ 用户号，非机器人账号'}),
            check('以私聊身份执行',settings.isDirect!==false,v=>settings.isDirect=v),
            ...(!settings.isDirect?[input('频道 ID',settings.channelId??'',v=>settings.channelId=v),input('群组 ID',settings.guildId??'',v=>settings.guildId=v)]:[]),
          ]),
          h('h3','允许的外部工具'),
          h('p',{class:'muted'},'只选择读取资料、搜索、歌曲库等所需工具。邮件发送、任务调度和委派类工具不会列出；绘图使用下方专用桥接。工具本身的 ChatLuna 授权仍生效。'),
          !(data.value.workflowTools??[]).length?h('p',{class:'notice'},'未发现可用工具，请先连接搜索或歌曲库 MCP，再刷新本页。'):null,
          h('div',{class:'grid'},(data.value.workflowTools??[]).map((tool:any)=>h('div',{class:'variable-card'},[
            check(tool.name,(settings.allowedTools??[]).includes(tool.name),v=>settings.allowedTools=v?[...settings.allowedTools,tool.name]:settings.allowedTools.filter((n:string)=>n!==tool.name)),
            h('p',{class:'muted'},tool.description||'无描述'),
          ]))),
          h('h3','MediaLuna 图片交接'),
          h('p',{class:'muted'},'开启后，主 Agent 可通过 import_mail_image 导入已完成的绘图任务。定时任务还可开启自动配图，每次执行最多提交一次绘图请求，可能产生绘图费用。绘图提示词由模型根据邮件内容自动生成，管理员只限定可用渠道。目前仅接本地 PNG/JPEG 缓存。'),
          h('div',{class:'grid'},[
            check('允许导入 MediaLuna 图片',!!settings.mediaImportEnabled,v=>settings.mediaImportEnabled=v),
            input('图片所属用户编号（Koishi user.id）',settings.mediaOwnerId??'',v=>settings.mediaOwnerId=v.trim()===''?null:Number(v),'number',{min:0}),
          ]),
          h('p',{class:'muted'},'此编号是 Koishi 用户表中的内部数字 ID，不是 QQ 号；0 是合法值，留空表示未配置。自动绘图时必须与上方执行用户对应。模型可使用 presetName 指定已有 MediaLuna 预设。'),
          h('div',{class:'bar'},(data.value.mediaChannels??[]).map((c:any)=>check('允许绘图渠道 '+c.name,(settings.mediaChannels??[]).includes(c.name),v=>settings.mediaChannels=v?[...settings.mediaChannels,c.name]:settings.mediaChannels.filter((n:string)=>n!==c.name)))),
          !(data.value.mediaChannels??[]).length?h('p',{class:'muted'},'未发现已启用的 MediaLuna 渠道，当前不能自动配图。'):null,
          h('details',[h('summary','执行预算'),h('div',{class:'grid'},[
            input('最多 Agent 步数',settings.maxSteps??10,v=>settings.maxSteps=Number(v),'number',{min:1,max:24}),
            input('最多工具调用',settings.maxToolCalls??16,v=>settings.maxToolCalls=Number(v),'number',{min:1,max:40}),
            input('工具工作流总超时（秒）',settings.timeoutSeconds??300,v=>settings.timeoutSeconds=Number(v),'number',{min:10,max:900}),
            input('单次工具结果字符上限',settings.maxToolResultChars??16000,v=>settings.maxToolResultChars=Number(v),'number',{min:500,max:60000}),
          ])]),
          h('div',{class:'bar'},[button('保存工作流设置',async()=>{await send('mail-admin/workflow-save',{settings:clone(settings),expectedHash:workflowHash.value});await refresh();notice.value='工作流设置已保存；策略变动会阻止尚未完成的旧执行继续调用工具。'},'primary')]),
        ]),
      ]
    }
    function timePicker() {
      const p=splitTime(task.time),options=(n:number)=>Array.from({length:n},(_,i)=>[String(i).padStart(2,'0'),String(i).padStart(2,'0')] as [string,string])
      return h('div',{class:'inline'},[
        select('小时',p.hour,options(24),v=>task.time=v+':'+p.minute),
        select('分钟',p.minute,options(60),v=>task.time=p.hour+':'+v),
      ])
    }
    function taskPanel() {
      const catalog=data.value.catalog??{conversations:[],presets:[],warnings:[]}
      const convOptions:Array<[string,string]>=catalog.conversations.map((c:any)=>[c.id,(c.title||'未命名会话')+' · '+c.id])
      if(task.conversationId && !convOptions.some(([id])=>id===task.conversationId)) convOptions.unshift([task.conversationId,task.conversationId+'（不在最近列表中）'])
      const templateFields=Object.entries(data.value.templates.find((t:any)=>t.id===task.templateId)?.fields??{}) as Array<[string,{required:boolean;default:string}]>
      const vars=()=>{try{return JSON.parse(variableText.value)}catch{return {}}}
      const modelValue=task.model || (task.useDefaultModel?'__default':'__conversation')
      const presets:Array<[string,string]>=[['','跟随会话预设'],...catalog.presets.map((p:string)=>[p,p] as [string,string])]
      if(task.preset && !presets.some(([id])=>id===task.preset)) presets.push([task.preset,task.preset+'（当前未注册）'])
      return [
        h('div',{class:'bar'},[button('＋ 新建任务',()=>{editTask();focusEditor(taskEditor)},'primary')]),
        table(['任务','计划','下次执行（本机显示时区）','状态','操作'],data.value.tasks.map((r:any)=>[
          r.task.name||r.task.id,r.task.scheduleType==='once'?dateText(r.task.runAt):r.task.time+' / '+r.task.timezone+(r.task.scheduleType==='weekly'?' / '+r.task.weekdays.map((n:number)=>weekdays[n-1]).join('、'):''),
          r.nextRunAt?dateText(r.nextRunAt):'无后续计划',!r.task.enabled?'任务停用':r.blockedBy?'受全局开关阻止':'已启用',
          h('div',{class:'bar'},[
            button('编辑',()=>{editTask(r);focusEditor(taskEditor)}),button(r.task.enabled?'停用':'启用',async()=>{await send('mail-admin/task-toggle',{id:r.task.id,enabled:!r.task.enabled,expectedHash:r.hash});await refresh()}),
            button(r.task.executionMode==='tools'?'试运行工具':'试判断',()=>evaluate(r.task.id)),button('上下文诊断',async()=>{const report=await send('mail-admin/diagnose',{id:r.task.id});resultDetails.value=report;notice.value='上下文检查完成：'+report.historyCount+' 条消息 · 模型 '+report.model+'\n'+(report.skipReason??'可以进行模型判断，本次检查未调用模型。')}),
            button('归档',async()=>{if(!window.confirm('归档任务 '+(r.task.name||r.task.id)+'？执行记录仍保留。')) return;await send('mail-admin/task-archive',{id:r.task.id,expectedHash:r.hash});await refresh()},'danger'),
          ]),
        ])),
        h('h3',{class:'editor-heading',ref:taskEditor,tabindex:-1},taskExisting.value?'编辑任务':'新建任务'),
        h('div',{class:'card'},[
          h('h3','1. 发给谁'),h('div',{class:'grid'},[
            input('任务名称',task.name,v=>task.name=v,'text',{placeholder:'例如 每日事项提醒'}),
            input('收件人',toText.value,v=>toText.value=v,'text',{placeholder:'可填写多个邮箱，用逗号分隔'}),
            select('邮件模板',task.templateId,data.value.templates.map((t:any)=>[t.id,t.name]),v=>task.templateId=v),
          ]),
          h('h3','2. 判断依据'),h('div',{class:'grid'},[
            select('上下文会话',task.conversationId,[['','请选择会话（最近 100 个活跃会话）'],...convOptions],v=>task.conversationId=v),
            select('判断模型',modelValue,[['__conversation','跟随会话模型'],['__default','邮件默认模型'+(data.value.modelSettings?.defaultModel?' · '+data.value.modelSettings.defaultModel:'（尚未设置）')],...modelOptions(task.model)],v=>{task.useDefaultModel=v==='__default';task.model=['__default','__conversation'].includes(v)?'':v}),
          ]),
          h('div',{class:'grid'},[
            select('执行方式',task.executionMode,[['context','只读上下文判断'],['tools','工具工作流（搜索／歌曲库／配图）']],v=>task.executionMode=v),
          ]),
          ...(task.executionMode==='tools'?[
            h('p',{class:'notice'},'试运行会真实调用所选工具，可能产生模型或绘图费用，但不会自动发送邮件。最多 '+(data.value.workflowSettings?.maxSteps??10)+' 步／'+(data.value.workflowSettings?.maxToolCalls??16)+' 次工具／'+(data.value.workflowSettings?.timeoutSeconds??300)+' 秒。'),
            !data.value.workflowSettings?.enabled?h('p',{class:'error'},'请先在“工作流”页配置执行身份并开启工具工作流。'):null,
            h('div',{class:'grid'},(data.value.workflowSettings?.allowedTools??[]).map((name:string)=>check(name,task.tools.includes(name),v=>task.tools=v?[...task.tools,name]:task.tools.filter(n=>n!==name)))),
            h('div',{class:'grid'},[
              check('允许自动配图（每次最多一次绘图请求）',task.workflowImages,v=>task.workflowImages=v),
              select('工具或绘图失败时',task.toolFailurePolicy,[['stop','停止本次任务（默认）'],['continue','允许跳过失败资料或配图继续判断']],v=>task.toolFailurePolicy=v),
            ]),
          ]:[]),
          !catalog.conversations.length?h('p',{class:'muted'},'暂未取得会话列表，可刷新或展开高级设置填写会话 ID。'):null,
          task.useDefaultModel&&!data.value.modelSettings?.defaultModel?h('p',{class:'error'},'请先到“模型设置”选择邮件默认模型。'):null,
          h('h3','3. 何时判断'),h('div',{class:'grid'},[
            select('执行频率',task.scheduleType,[['daily','每天'],['weekly','每周'],['once','仅一次']],v=>task.scheduleType=v),
            select('执行时区',task.timezone,[['Asia/Shanghai','北京时间（UTC+8）'],['Asia/Hong_Kong','香港时间（UTC+8）'],['Asia/Tokyo','东京时间（UTC+9）'],['UTC','世界协调时（UTC）'],['America/New_York','纽约时间（自动夏令时）'],...(!['Asia/Shanghai','Asia/Hong_Kong','Asia/Tokyo','UTC','America/New_York'].includes(task.timezone)?[[task.timezone,task.timezone] as [string,string]]:[])],v=>task.timezone=v),
            ...(task.scheduleType==='once'?[h('div',{class:'inline wide'},[
              select('年',date.year,Array.from(new Set([Number(date.year),...Array.from({length:11},(_,i)=>new Date().getFullYear()+i)])).sort().map(y=>[String(y),String(y)+'年']),v=>{date.year=v;date.day=String(Math.min(Number(date.day),daysInMonth(Number(v),Number(date.month)))).padStart(2,'0')}),
              select('月',date.month,Array.from({length:12},(_,i)=>[String(i+1).padStart(2,'0'),(i+1)+'月']),v=>{date.month=v;date.day=String(Math.min(Number(date.day),daysInMonth(Number(date.year),Number(v)))).padStart(2,'0')}),
              select('日',date.day,Array.from({length:daysInMonth(Number(date.year),Number(date.month))},(_,i)=>[String(i+1).padStart(2,'0'),(i+1)+'日']),v=>date.day=v),
            ])]:[]),
            timePicker(),
            ...(task.scheduleType==='weekly'?[h('div',{class:'bar wide'},weekdays.map((name,i)=>check(name,task.weekdays.includes(i+1),checked=>{task.weekdays=checked?[...task.weekdays,i+1].sort():task.weekdays.filter(n=>n!==i+1)})))]:[]),
          ]),
          h('p',{class:'notice'},(task.scheduleType==='once'?date.year+'年'+date.month+'月'+date.day+'日':task.scheduleType==='weekly'?'每周 '+task.weekdays.map(n=>weekdays[n-1]).join('、'):'每天')+' '+task.time+'（'+task.timezone+'）读取会话，再由所选模型决定是否发送。'),
          h('h3','4. 判断与写作要求'),
          area('判断与写作要求',task.prompt,v=>task.prompt=v),
          h('p',{class:'muted'},'说明什么情况下值得发邮件、需要包含什么内容；无必要时模型会跳过。默认沿用会话预设。'),
          ...(templateFields.length?[h('h3','模板变量'),h('div',{class:'grid'},templateFields.map(([name,field])=>h('div',{class:'variable-card'},[
            h('strong',name+(field.required?' · 必填':' · 可选')),
            input('变量值 '+name,vars()[name]??'',v=>{variableText.value=JSON.stringify({...vars(),[name]:v},null,2)},'text',{placeholder:field.default?'默认：'+field.default:'请输入变量值'}),
            button('插入 {{'+name+'}}',()=>insertVariable('判断与写作要求',task.prompt,v=>task.prompt=v,name),'chip'),
          ])))]:[]),
          h('details',[h('summary','高级设置（通常无需修改）'),h('div',{class:'grid'},[
            input('任务 ID（自动生成）',task.id,v=>task.id=v,'text',{disabled:taskExisting.value,placeholder:'留空自动生成'}),
            input('手动填写会话 ID',task.conversationId,v=>task.conversationId=v),
            select('预设覆盖',task.preset,presets,v=>task.preset=v),
            input('自定义 IANA 时区',task.timezone,v=>task.timezone=v),
            input('手动填写模型 ID',task.model,v=>{task.model=v;task.useDefaultModel=false}),
            input('历史消息上限',task.historyLimit,v=>task.historyLimit=Number(v),'number',{min:1,max:200}),
            input('发送冷却分钟',task.cooldownMinutes,v=>task.cooldownMinutes=Number(v),'number',{min:1,max:10080}),
            select('上下文范围',task.contextMode,[['recent','当前分支最近消息'],['since-last-send','自上次发信后的新增消息']],v=>task.contextMode=v),
            input('上下文最大年龄（小时，0 不限制）',task.contextMaxAgeHours,v=>task.contextMaxAgeHours=Number(v),'number',{min:0,max:8760}),
            input('最低新增消息数（0 不限制）',task.minNewMessages,v=>task.minNewMessages=Number(v),'number',{min:0,max:100}),
            select('上下文超预算时',task.contextOverflow,[['reject','停止并报告超限'],['trim-oldest','移除最旧消息']],v=>task.contextOverflow=v),
            check('允许对明确暂时性失败自动重试',task.retryOnFailure,v=>task.retryOnFailure=v),
            area('其他预设变量（JSON 对象）',variableText.value,v=>variableText.value=v),
          ])]),
          h('div',{class:'bar'},[check('保存后启用定时任务',task.enabled,v=>task.enabled=v),button('保存任务',saveTask,'primary')]),
          h('p',{class:'muted'},'新任务默认停用。保存后可用“试判断”检查结果，不会自动发送邮件。'),
        ]),
      ]
    }
    function templatePanel() {
      return [
        h('div',{class:'bar'},[button('＋ 新建模板',()=>{editTemplate();focusEditor(templateEditor)},'primary')]),
        table(['模板','版本','操作'],data.value.templates.map((t:any)=>[
          t.name+' / '+t.id,'v'+t.version,
          h('div',{class:'bar'},[...(!['briefing','notice','plain'].includes(t.id)?[button('编辑',()=>{editTemplate(t);focusEditor(templateEditor)})]:[]),button('复制',()=>{editTemplate(t,true);focusEditor(templateEditor)})]),
        ])),
        h('h3',{class:'editor-heading',ref:templateEditor,tabindex:-1},templateExisting.value?'编辑模板':'新建模板'),
        h('div',{class:'card grid'},[
          input('模板 ID',template.id,v=>template.id=v,'text',{disabled:templateExisting.value}),
          input('模板名称',template.name,v=>template.name=v),
          input('强调色',template.layout.accent,v=>template.layout.accent=v,'color'),
          input('背景色',template.layout.background,v=>template.layout.background=v,'color'),
          input('文字颜色',template.layout.textColor,v=>template.layout.textColor=v,'color'),
          input('内容宽度',template.layout.width,v=>template.layout.width=Number(v),'number',{min:320,max:800}),
          check('显示邮件标题',template.layout.heading,v=>template.layout.heading=v),
          area('写作提示词（变量使用 {{name}}）',template.prompt,v=>template.prompt=v),
          area('邮件页脚（变量使用 {{name}}）',template.layout.footer,v=>template.layout.footer=v),
          h('div',{class:'wide'},[
            h('h3','变量卡片'),h('p',{class:'muted'},'每张卡片声明一个变量。点击变量按钮可插入提示词或页脚；预览值只用于排版预览。'),
            button('添加变量',()=>{variableRows.value.push({name:'',required:false,default:''})}),
            h('div',{class:'grid'},variableRows.value.map((row,i)=>h('div',{class:'variable-card'},[
              input('变量名称 '+(i+1),row.name,v=>row.name=v,'text',{placeholder:'例如 recipient_name'}),
              check('必填变量 '+(i+1),row.required,v=>row.required=v),
              input('默认值 '+(i+1),row.default,v=>row.default=v),
              input('预览值 '+(i+1),previewValues.value[row.name]??'',v=>previewValues.value[row.name]=v),
              h('div',{class:'bar'},[
                button('插入提示词 {{'+(row.name||'变量名')+'}}',()=>insertVariable('写作提示词（变量使用 {{name}}）',template.prompt,v=>template.prompt=v,row.name),'chip'),
                button('插入页脚',()=>insertVariable('邮件页脚（变量使用 {{name}}）',template.layout.footer,v=>template.layout.footer=v,row.name),'chip'),
                button('移除变量 '+(i+1),()=>{variableRows.value.splice(i,1)},'danger'),
              ]),
            ]))),
          ]),
          h('div',{class:'bar wide'},[
            button('保存新版本',saveTemplate,'primary'),
            button('预览排版',async()=>{
              const value={...clone(template),fields:variableDefinitions(variableRows.value)}
              preview.value=await send('mail-admin/template-preview',{template:value,mail:{to:['preview@example.com'],subject:'图文邮件排版预览',paragraphs:['这里展示第一段正文。','所有变量和正文都经过 HTML 转义。'],images:[],templateId:template.id,variables:previewValues.value}})
              previewDraft.value=''
            }),
          ]),
        ]),
      ]
    }
    async function fetchRecords() {
      recordData.value=await send('mail-admin/records',{kind:recordKind.value,page:recordPage.value,status:recordStatus.value})
    }
    function runsPanel() {
      return [
        h('h3','历史查询'),
        h('div',{class:'card'},[
          h('div',{class:'grid'},[
            select('记录类型',recordKind.value,[['run','模型判断'],['delivery','邮件投递']],v=>{recordKind.value=v;recordPage.value=1}),
            select('状态筛选',recordStatus.value,[['','全部'],...['accepted','partial','failed','unknown','error','skipped','preview','interrupted','cooldown'].map(s=>[s,s] as [string,string])],v=>{recordStatus.value=v;recordPage.value=1}),
          ]),
          h('div',{class:'bar'},[
            button('查询',fetchRecords),
            button('上一页',async()=>{recordPage.value=Math.max(1,recordPage.value-1);await fetchRecords()}),
            h('span','第 '+recordPage.value+' 页 / 共 '+(recordData.value?.total??'—')+' 条'),
            button('下一页',async()=>{if(recordData.value && recordPage.value*20<recordData.value.total) recordPage.value++;await fetchRecords()}),
          ]),
          recordData.value?table(['时间','记录','状态','说明'],recordData.value.items.map((r:any)=>[dateText(r.at??r.createdAt),r.id,r.status,r.redacted?'正文已按保留期清理':r.decision?.reason??r.detail??r.errorCode??'—'])):null,
        ]),
        h('h3','最近判断'),
        table(['时间','任务 / 状态','理由或故障','操作'],data.value.runs.map((r:any)=>[
          dateText(r.at),r.taskId+' / '+r.status,r.redacted?'正文已清理':r.decision?.reason ?? r.detail ?? r.errorCode ?? '—',
          r.draftId && !r.redacted?button('预览草稿',()=>loadPreview(r.draftId)):'—',
        ])),
        h('h3','最近投递'),
        table(['时间','记录 ID','状态','操作'],data.value.deliveries.map((d:any)=>[
          dateText(d.createdAt),d.id,d.status,
          d.canRetry?button('安排重试',async()=>{
            if(!window.confirm('只重试确定未投递的收件人，复用原邮件内容。是否加入重试队列？')) return
            const result=await send('mail-admin/retry-create',{id:d.id});notice.value=JSON.stringify(result,null,2);await refresh()
          }):d.redacted?'内容已清理':'—',
        ])),
        h('h3','重试队列'),
        table(['计划时间','原记录','次数 / 状态','操作'],(data.value.retryJobs??[]).map((j:any)=>[
          dateText(j.dueAt),j.sourceId,j.attempt+' / '+j.status+(j.outcome?' / '+j.outcome:''),
          j.status==='scheduled'?button('取消重试',async()=>{await send('mail-admin/retry-cancel',{id:j.id});await refresh()}):'—',
        ])),
      ]
    }
    function maintenancePanel() {
      const policy=data.value.policy??{}
      return [
        h('h3','运行策略'),
        h('div',{class:'card'},[
          h('p','自动重试：'+(policy.autoRetryEnabled?'开启':'关闭')+'；最多 '+(policy.maxRetryAttempts??2)+' 次；基础退避 '+(policy.retryDelayMinutes??5)+' 分钟。'),
          h('p','自动清理：'+(policy.cleanupEnabled?'开启':'关闭')+'；历史内容保留 '+(policy.retentionDays??30)+' 天；每小时判断上限 '+(policy.maxDecisionsPerHour??60)+' 次。'),
          h('p',{class:'muted'},'策略在插件配置中修改。未知投递结果不重试；已接受的收件人不会加入部分失败重试。'),
          data.value.invalidTaskIds?.length?h('p',{class:'error'},'存在无效任务记录：'+data.value.invalidTaskIds.join(', ')):null,
        ]),
        h('h3','保留期清理'),
        h('div',{class:'card'},[
          h('p','精简过期邮件正文与判断详情、使过期草稿失效，保留投递及调度的防重复标识。未固定且无引用的旧图片移入可恢复回收区。'),
          button('预览清理范围',async()=>{cleanupPlan.value=await send('mail-admin/cleanup-preview');notice.value='仅生成预览，尚未清理任何内容。'}),
          cleanupPlan.value?h('div',[
            h('pre',JSON.stringify({counts:cleanupPlan.value.counts,retentionDays:cleanupPlan.value.days,items:cleanupPlan.value.items},null,2)),
            button('执行此清理计划',async()=>{
              if(!window.confirm('确认清理？旧正文和过期草稿内容将不可恢复；防重复标识保留，图片进入可恢复回收区。')) return
              notice.value=JSON.stringify(await send('mail-admin/cleanup-apply',{planId:cleanupPlan.value.planId,confirm:true}),null,2)
              cleanupPlan.value=null;await refresh()
            },'danger'),
          ]):null,
        ]),
        h('h3','可用图片'),
        table(['assetId','格式 / 大小','保留状态','操作'],data.value.assets.map((a:any)=>[
          a.id,a.mime+' / '+Math.ceil(a.bytes/1024)+' KiB',a.pinned===false?'可按保留期回收':'固定保留',
          button(a.pinned===false?'固定保留':'取消固定',async()=>{await send('mail-admin/asset-pin',{id:a.id,pinned:a.pinned===false});await refresh()}),
        ])),
        h('h3','图片回收区'),
        table(['assetId','进入回收区时间','操作'],(data.value.trashedAssets??[]).map((a:any)=>[
          a.id,dateText(a.trashedAt),button('恢复并固定',async()=>{await send('mail-admin/asset-restore',{id:a.id});await refresh()}),
        ])),
      ]
    }

    return () => h(resolveComponent('k-layout'),null,{
      default:()=>h('div',{class:'mail-viewport',ref:viewport,tabindex:0,role:'region','aria-label':'邮件任务内容'},[h('div',{class:'mail-admin'},[
        h('style',css),
        h('header',{class:'hero'},[
          h('div',{class:'hero-title'},[h('div',{class:'hero-icon'},[h(MailIcon)]),h('div',[h('h2','邮件任务'),h('p',{class:'muted'},'把值得关注的消息，在合适的时间送达。')])]),
          h('span',{class:'version'},'v'+(data.value.version??'…')),
        ]),
        h('div',{class:'stats'},[
          h('div',{class:'stat'},[h('div',[h('div',{class:'stat-label'},'邮件任务'),h('div',{class:'stat-value'},data.value.tasks.length+' 个 · '+data.value.tasks.filter((r:any)=>r.task.enabled).length+' 个启用')]),h('svg',{class:'stat-symbol',viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.6,'aria-hidden':'true'},[h('rect',{x:4,y:4,width:16,height:17,rx:3}),h('path',{d:'M8 2v4m8-4v4M4 10h16m-12 4h3m-3 3h7'})])]),
          h('div',{class:'stat'},[h('div',[h('div',{class:'stat-label'},'发信状态'),h('div',{class:'stat-value'},data.value.paused?'本次已暂停':data.value.enabled?'允许发信':'全局已关闭')]),h(MailIcon,{class:'stat-symbol'})]),
          h('div',{class:'stat'},[h('div',[h('div',{class:'stat-label'},'邮件默认模型'),h('div',{class:'stat-value',style:'font-size:14px'},data.value.modelSettings?.defaultModel||'跟随任务设置')])]),
        ]),
        h('p',{class:'recipient-info'},'允许收件人：'+(data.value.allowedRecipients.join('、')||'尚未配置')+' · 每次由一个模型根据会话上下文判断是否发送'),
        h('nav',{class:'navigation','aria-label':'邮件管理导航'},[
          h('div',{class:'tabs'},[['tasks','任务'],['models','模型设置'],['workflow','工作流'],['templates','模板'],['runs','执行记录'],['maintenance','运行维护']].map(([id,label])=>h('button',{type:'button',class:['tab',tab.value===id?'active':''],'aria-pressed':tab.value===id,disabled:busy.value,onClick:()=>switchTab(id)},label))),
          h('div',{class:'nav-tools'},[button('刷新',refresh),button('回到顶部',()=>viewport.value?.scrollTo({top:0})),button(data.value.paused?'恢复发送':'暂停发送',async()=>{await send(data.value.paused?'mail-admin/resume':'mail-admin/pause');await refresh()},'danger',true)]),
        ]),
        notice.value?h('pre',{class:['notice',error.value?'error':'']},notice.value):null,
        resultDetails.value?.draftId?button('查看邮件预览',()=>switchTab('templates')):null,
        resultDetails.value?h('details',{class:'card'},[h('summary','查看诊断详情'),h('pre',JSON.stringify(resultDetails.value,null,2))]):null,
        ...(tab.value==='tasks'?taskPanel():tab.value==='models'?modelPanel():tab.value==='workflow'?workflowPanel():tab.value==='templates'?templatePanel():tab.value==='maintenance'?maintenancePanel():runsPanel()),
        preview.value && tab.value==='templates'?h('div',{class:'card'},[
          h('h3','邮件预览'),
          preview.value.mail?h('p','收件人：'+preview.value.mail.to.join(', ')+' · 模板版本：'+preview.value.templateVersion):null,
          h('iframe',{title:'邮件内容预览',sandbox:'',srcdoc:preview.value.html}),
          h('pre',preview.value.text),
          previewDraft.value?button('发送此草稿',async()=>{
            if(!window.confirm('确认发送到 '+preview.value.mail.to.join(', ')+'？')) return
            const result=await send('mail-admin/send',{id:previewDraft.value})
            notice.value=JSON.stringify(result,null,2);await refresh()
          },'primary'):null,
        ]):null,
        h('p',{class:'muted footer'},'试判断／试运行均不自动发信；工具模式会调用外部工具并可能产生绘图费用。错过计划分钟不补发。启停总开关和邮箱账号请在插件配置中设置。'),
      ])]),
    })
  },
})

export default (ctx:Context) => {
  icons.register('chatluna-mail:envelope',MailIcon)
  ctx.page({ name:'邮件任务',path:'/chatluna-mail',icon:'chatluna-mail:envelope',authority:4,order:690,component:MailPage })
}
