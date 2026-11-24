import {HistoryDecoder,ContextReadError,storageDetails,MAX_MESSAGE_BYTES,MAX_TOTAL_BYTES,RESCUE_COMPRESSED_BYTES,RESCUE_MESSAGE_BYTES,RESCUE_TOTAL_BYTES,type HistoryRecord} from './history.js'
import type {Task} from './types.js'

export type HistoryCheckpoint=string|{messageId:string;conversationId:string;at:string;timeBasis:'message-created-at'|'run-start'}
export const checkpointId=(checkpoint?:HistoryCheckpoint)=>typeof checkpoint==='string'?checkpoint:checkpoint?.messageId

// Input is the validated active branch, oldest first. Message IDs can disappear
// after ChatLuna retention/compression; recover only from a saved time boundary.
export async function selectHistory(branch:HistoryRecord[],task:Pick<Task,'contextMode'|'historyLimit'|'minNewMessages'> & {contextOverflow?:Task['contextOverflow'];allowEmpty?:boolean},checkpoint?:HistoryCheckpoint,textLimit=16000) {
 const id=checkpointId(checkpoint),checkpointIndex=id?branch.findIndex(row=>row.id===id):-1
 const missingCheckpoint=!!id && checkpointIndex<0
 const required=task.contextMode==='since-last-send'||task.minNewMessages>0
 let recovered=false
 let newIds:Set<string>|null=missingCheckpoint?null:new Set(branch.slice(checkpointIndex+1).map(row=>row.id))
 if(missingCheckpoint && required){
  if(typeof checkpoint!=='object'||!Number.isFinite(Date.parse(checkpoint.at)))throw new ContextReadError('CONTEXT_CHECKPOINT_UNRESOLVED','Context checkpoint is no longer in active history; no saved time boundary is available')
  const cutoff=Date.parse(checkpoint.at)
  newIds=new Set<string>()
  for(const row of branch){
   // A synthetic compression summary describes old content; its creation time
   // must not turn already processed conversation into new mail material.
   if(row.name==='infinite_context')continue
   const at=row.createdAt==null?NaN:new Date(row.createdAt).getTime()
   if(!Number.isFinite(at))throw new ContextReadError('CONTEXT_CHECKPOINT_UNRESOLVED','Context checkpoint recovery requires valid message timestamps')
   if(at>cutoff)newIds.add(row.id)
  }
  recovered=true
 }
 const candidates=task.contextMode==='since-last-send' && id && newIds?branch.filter(row=>newIds!.has(row.id)):branch
 const remainingNew:number[]=[]
 for(let i=0;i<candidates.length;i++)remainingNew[i]=(remainingNew[i-1]??0)+(newIds?.has(candidates[i].id)?1:0)
 const checkpointRecovery={mode:recovered?'timestamp-recovered':missingCheckpoint?'unavailable':id?'message-id':'initial',
  originalMessageId:id??null,at:typeof checkpoint==='object'?checkpoint.at:null,timeBasis:typeof checkpoint==='object'?checkpoint.timeBasis:null,
  warning:recovered?(typeof checkpoint==='object' && checkpoint.timeBasis==='run-start'?'旧检查点已不在活动分支，使用上次执行开始时间恢复；时间相近的已处理内容可能重叠，请核对预览':'旧检查点已不在活动分支，已使用原消息时间恢复，未重置为全量历史'):null}
 const decoder=new HistoryDecoder(task.contextOverflow==='trim-oldest',textLimit),selected:HistoryRecord[]=[]
 let cursor=candidates.length-1,readableMessages=0,newMessages:number|null=newIds?0:null,inspectedRows=0,lastUnreadable:ContextReadError|undefined
 for(;cursor>=0;cursor--){
  const needHistory=selected.length<task.historyLimit
  const needNewCount=task.minNewMessages>0 && (remainingNew[cursor]??0)>0 && newMessages!=null && newMessages<task.minNewMessages
  if(!needHistory && !needNewCount)break
  if(!needHistory && !newIds?.has(candidates[cursor].id))continue
  let row:HistoryRecord
  inspectedRows++
  try {row=await decoder.decode(candidates[cursor])}catch(error){
   if(!decoder.bestEffort || !(error instanceof ContextReadError))throw error
   lastUnreadable=error
   decoder.stats.unreadableMessages.push({messageId:String(candidates[cursor].id).slice(0,128),code:error.code,details:error.details})
   continue
  }
  if(!row.text?.trim())continue
  readableMessages++
  if(newMessages!=null && newIds?.has(row.id))newMessages++
  if(needHistory)selected.unshift(row)
 }
 const uninspectedRows=Math.max(0,cursor+1)
 if(lastUnreadable && (!readableMessages || task.minNewMessages>0 && (newMessages??0)<task.minNewMessages))throw lastUnreadable
 if(!task.allowEmpty && !readableMessages && !(task.contextMode==='since-last-send' && id))throw new ContextReadError('CONTEXT_TEXT_UNAVAILABLE','Context has no readable text after decoding stored messages')
 return {selected,contextStorage:decoder.stats,readableMessages,newMessages,
  selection:{strategy:'newest-readable-first' as const,countScope:'candidate-range' as const,activeBranchRows:branch.length,excludedByCheckpointRows:branch.length-candidates.length,inspectedRows,uninspectedRows,
   availableTextMessagesExact:uninspectedRows===0&&!lastUnreadable,newMessagesExact:newMessages==null||lastUnreadable?false:(remainingNew[cursor]??0)===0,
   countsAreLowerBounds:uninspectedRows>0||!!lastUnreadable,checkpointRecovery}}
}

// Does not decompress content or expose any message text/encoded body.
export function auditHistoryStorage(branch:HistoryRecord[],task:Pick<Task,'contextMode'|'historyLimit'|'minNewMessages'>,checkpoint?:HistoryCheckpoint) {
 const id=checkpointId(checkpoint),checkpointIndex=id?branch.findIndex(row=>row.id===id):-1
 const boundary=task.contextMode==='since-last-send' && checkpointIndex>=0?checkpointIndex+1:0
 const oversized=branch.flatMap((row,index)=>{
  const info=storageDetails(row),legacyTextBytes=typeof row.text==='string'?Buffer.byteLength(row.text):0
  const compressedOverLimit=(info.compressedBytes??0)>MAX_MESSAGE_BYTES || (info.encodedLength??0)>MAX_MESSAGE_BYTES*2
  if(!compressedOverLimit && legacyTextBytes<=MAX_MESSAGE_BYTES)return []
  return [{...info,legacyTextBytes,compressedBytesExact:typeof row.content!=='string',contentType:'not-decoded',index,
   afterCheckpoint:checkpointIndex<0?null:index>checkpointIndex,excludedByCheckpoint:index<boundary,compressedOverLimit,legacyTextOverLimit:legacyTextBytes>MAX_MESSAGE_BYTES}]
 })
 return {activeBranchRows:branch.length,checkpoint:id??null,checkpointFound:id?checkpointIndex>=0:null,checkpointAt:typeof checkpoint==='object'?checkpoint.at:null,recoveryRequired:!!id&&checkpointIndex<0,historyLimit:task.historyLimit,
  contextMode:task.contextMode,minNewMessages:task.minNewMessages,oversizedCount:oversized.length,oversizedMessages:oversized.slice(0,100),truncated:oversized.length>100,
  limits:{strictMessageBytes:MAX_MESSAGE_BYTES,strictTotalBytes:MAX_TOTAL_BYTES,bestEffortCompressedBytes:RESCUE_COMPRESSED_BYTES,bestEffortMessageBytes:RESCUE_MESSAGE_BYTES,bestEffortTotalBytes:RESCUE_TOTAL_BYTES},decoded:false,modelInvoked:false,
  notes:['Compressed-byte counts for string storage are base64 size estimates.','No content decoded: image/text type, decompression size and final readable selection cannot be inferred.','historyLimit counts readable messages; contextMaxAgeHours is freshness, not a time-range filter.']}
}
