import {z} from 'zod'
import {key} from './types.js'
import {compactText,HistoryDecoder,type HistoryRecord} from './history.js'
import {selectHistory} from './history-selection.js'

const common={id:key,historyLimit:z.number().int().min(1).max(200).optional()}
export const contextPreviewSchema=z.discriminatedUnion('mode',[
 z.object({...common,mode:z.literal('since-evaluation')}).strict(),
 z.object({...common,mode:z.literal('since-send')}).strict(),
 z.object({...common,mode:z.literal('hours'),hours:z.number().int().min(1).max(8760)}).strict(),
 z.object({...common,mode:z.literal('custom'),start:z.string().datetime({offset:true}),end:z.string().datetime({offset:true})}).strict(),
])
export type ContextPreviewRequest=z.infer<typeof contextPreviewSchema>
export type PreviewBaseline={runId:string;at:string;approximate:boolean}|null

// Preview only: time filters are independent of the task's freshness/minNew gates.
export async function previewHistory(branch:HistoryRecord[],request:ContextPreviewRequest,baseline:PreviewBaseline,historyLimit:number,characterBudget:number,now=new Date()) {
 const end=request.mode==='custom'?new Date(request.end):now
 const start=request.mode==='custom'?new Date(request.start):request.mode==='hours'?new Date(+now-request.hours*3600000):baseline?new Date(baseline.at):null
 if(!Number.isFinite(+end)||start&&!Number.isFinite(+start)||start&&+start>=+end||+end>+now)throw new Error('Context preview range must have start before end and cannot end in the future')
 let unknownDates=0,summaryRows=0
 const candidates=branch.filter(row=>{
  if(row.name==='infinite_context'){summaryRows++;return false}
  const at=row.createdAt==null?NaN:+new Date(row.createdAt)
  if(!Number.isFinite(at)){unknownDates++;return false}
  return at<=+end&&(!start||at>+start)
 })
 const result=candidates.length?await selectHistory(candidates,{contextMode:'recent',minNewMessages:0,historyLimit,contextOverflow:'trim-oldest',allowEmpty:true},undefined,Math.max(256,Math.min(16000,Math.floor(characterBudget/4)))):null
 const storage=result?.contextStorage??new HistoryDecoder(true).stats
 const history=(result?.selected??[]).map(row=>({id:row.id,role:row.role,createdAt:new Date(row.createdAt!).toISOString(),text:row.text!}))
 const chars=()=>JSON.stringify(history).length
 let droppedForBudget=0
 if(chars()>characterBudget&&history.length){
  const overhead=JSON.stringify(history.map(row=>({...row,text:''}))).length
  const each=Math.floor((characterBudget-overhead-128)/history.length/2)
  if(each>=256)for(const row of history)if(row.text.length>each){
   const originalChars=row.text.length;row.text=compactText(row.text,each)
   storage.compactions.push({messageId:row.id,originalChars,retainedChars:row.text.length,strategy:'preview-character-budget'})
  }
 }
 while(chars()>characterBudget&&history.length>1){history.shift();droppedForBudget++}
 if(chars()>characterBudget&&history.length===1){
  // JSON escapes can cost up to six characters per source character.
  const row=history[0],overhead=JSON.stringify([{...row,text:''}]).length
  const target=Math.floor((characterBudget-overhead-64)/6)
  if(target>=128&&row.text.length>target){
   const originalChars=row.text.length;row.text=compactText(row.text,target)
   storage.compactions.push({messageId:row.id,originalChars,retainedChars:row.text.length,strategy:'preview-escaped-character-budget'})
  }
 }
 if(chars()>characterBudget)throw new Error('Context preview exceeds configured character budget')
 const warnings:string[]=[]
 if((request.mode==='since-send'||request.mode==='since-evaluation')&&!baseline)warnings.push('未找到同会话的对应成功事件，首次预览使用当前可用历史，并受消息条数限制；不表示已获取全部历史。')
 if(baseline?.approximate)warnings.push('旧运行记录缺少上下文快照时间，使用旧时间边界估算；临界消息可能重叠或遗漏。')
 if(summaryRows)warnings.push('活动分支存在主插件生成的历史摘要，本次时间窗口不把摘要当成新消息；原始历史可能已被替换。')
 if(unknownDates)warnings.push('部分消息缺少有效时间，无法归入时间窗口，已排除并计数。')
 const times=branch.filter(row=>row.name!=='infinite_context'&&row.createdAt!=null).map(row=>+new Date(row.createdAt!)).filter(Number.isFinite)
 if(start&&times.length&&times.reduce((earliest,at)=>Math.min(earliest,at),Infinity)>+start)warnings.push('当前可用分支起点晚于请求起点；可能是期间没有消息，也可能是历史已清理，无法保证窗口完整。')
 if(storage.compactions.length)warnings.push('部分正文使用有损摘录，预览不是完整原文。')
 if(storage.unreadableMessages.length)warnings.push('部分消息达到读取保护上限或无法解码，已尽力保留其他可读内容。')
 if(droppedForBudget)warnings.push('字符预算不足，已继续移除最旧消息。')
 return {taskId:request.id,mode:request.mode,range:{start:start?.toISOString()??null,end:end.toISOString(),startExclusive:true,baseline},
  historyLimit,characterBudget,contextChars:chars(),history,historyCount:history.length,activeBranchRows:branch.length,candidateRows:candidates.length,unknownDateRows:unknownDates,summaryRows,droppedForBudget,
  selection:result?.selection??null,contextStorage:storage,warnings,
  effects:{modelInvoked:false,toolsInvoked:false,mailSent:false,progressUpdated:false},
  scope:'history-only',excludes:['preset','task-instructions','stored-summary','tool-results','image-recognition'],
 }
}
