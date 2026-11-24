import {gunzip} from 'node:zlib'
import {promisify} from 'node:util'
const decompress=promisify(gunzip)
export const MAX_MESSAGE_BYTES=1024*1024
export const MAX_TOTAL_BYTES=8*1024*1024
export const RESCUE_COMPRESSED_BYTES=8*1024*1024
export const RESCUE_MESSAGE_BYTES=16*1024*1024
export const RESCUE_TOTAL_BYTES=32*1024*1024
export function compactText(text:string,maxChars:number):string {
 if(text.length<=maxChars)return text
 const notice="[上下文有损摘录压缩，原文 "+text.length+" 字符；省略部分未提供给判断模型，不代表全文]\n"
 const separator="\n[…内容已省略…]\n",size=Math.max(1,Math.floor((maxChars-notice.length-3*separator.length)/4))
 return notice+[0,1,2,3].map(i=>text.slice(Math.floor((text.length-size)*i/3),Math.floor((text.length-size)*i/3)+size).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g,'')).join(separator)
}
export type HistoryRecord={id:string;parentId?:string|null;role:string;name?:string|null;text?:string|null;content?:ArrayBuffer|ArrayBufferView|string|null;createdAt?:Date|string|null}
export type StorageDetails={messageId:string;role:string;storageType:string;encodedLength:number|null;compressedBytes:number|null;decodedBytes?:number;limitBytes?:number}
// Metadata only: never include text, encoded content, provider data or URLs.
export function storageDetails(row:HistoryRecord):StorageDetails {
 const content=row.content
 return {messageId:String(row.id).slice(0,128),role:String(row.role).slice(0,32),storageType:content==null?'legacy-text':typeof content==='string'?'base64':ArrayBuffer.isView(content)?'binary-view':'array-buffer',encodedLength:typeof content==='string'?content.length:null,compressedBytes:content==null?null:typeof content==='string'?Buffer.byteLength(content,'base64'):content.byteLength}
}
export class ContextReadError extends Error {
  constructor(readonly code:'CONTEXT_EMPTY'|'CONTEXT_TEXT_UNAVAILABLE'|'CONTEXT_DECODE_FAILED'|'CONTEXT_STORAGE_LIMIT'|'CONTEXT_CHECKPOINT_UNRESOLVED',message:string,readonly details?:StorageDetails){super(message);this.name='ContextReadError'}
}
function textContent(value:unknown):string {
  if(typeof value==='string') return value
  if(!Array.isArray(value)) return ''
  return value.filter(v=>v && typeof v==='object' && v.type==='text' && typeof v.text==='string').map(v=>v.text).join('\n')
}
export class HistoryDecoder {
 constructor(readonly bestEffort=false,readonly textLimit=16000){}
 readonly stats={compressedMessages:0,legacyTextMessages:0,legacyFallbackMessages:0,nonTextMessages:0,decodedBytes:0,decodeBudgetBytes:0,compactions:[] as Array<{messageId:string;originalChars:number;retainedChars:number;strategy:string}>,unreadableMessages:[] as Array<{messageId:string;code:string;details?:StorageDetails}>,rescuedMessages:0}
 async decode(row:HistoryRecord):Promise<HistoryRecord> {
    const stats=this.stats
    const fail=(code:ContextReadError['code'],message:string,limitBytes?:number)=>new ContextReadError(code,message+' (message '+String(row.id).slice(0,128)+')',{...storageDetails(row),decodedBytes:stats.decodedBytes,limitBytes})
    const messageLimit=this.bestEffort?RESCUE_MESSAGE_BYTES:MAX_MESSAGE_BYTES
    const compressedLimit=this.bestEffort?RESCUE_COMPRESSED_BYTES:MAX_MESSAGE_BYTES
    const totalLimit=this.bestEffort?RESCUE_TOTAL_BYTES:MAX_TOTAL_BYTES
    const outputLimit=Math.min(messageLimit,Math.max(1,totalLimit-stats.decodeBudgetBytes))
    let text=typeof row.text==='string'?row.text:''
    const legacy=!!text.trim()
    let fallback=false,outputCharged=false
    if(row.content!=null){
      try{
        if(this.bestEffort && stats.decodeBudgetBytes>=totalLimit)throw fail('CONTEXT_STORAGE_LIMIT','Context decoded history exceeds storage limit',totalLimit)
        if(typeof row.content==='string' && row.content.length>compressedLimit*2) throw fail('CONTEXT_STORAGE_LIMIT','Context compressed message exceeds storage limit',compressedLimit)
        const bytes=typeof row.content==='string'?Buffer.from(row.content,'base64'):ArrayBuffer.isView(row.content)?Buffer.from(row.content.buffer,row.content.byteOffset,row.content.byteLength):Buffer.from(row.content)
        if(bytes.length>compressedLimit) throw fail('CONTEXT_STORAGE_LIMIT','Context compressed message exceeds storage limit',compressedLimit)
        const raw=await decompress(bytes,{maxOutputLength:outputLimit})
        stats.decodedBytes+=raw.length;stats.decodeBudgetBytes+=raw.length;outputCharged=true
        if(this.bestEffort && (bytes.length>MAX_MESSAGE_BYTES||raw.length>MAX_MESSAGE_BYTES))stats.rescuedMessages++
        text=textContent(JSON.parse(raw.toString('utf8')));stats.compressedMessages++
      }catch(error){
        if(error instanceof ContextReadError) throw error
        // Charge a failed inflate against the remaining work budget as well.
        if(this.bestEffort && !outputCharged)stats.decodeBudgetBytes=Math.min(totalLimit,stats.decodeBudgetBytes+outputLimit)
        if((error as NodeJS.ErrnoException)?.code==='ERR_BUFFER_TOO_LARGE') throw fail('CONTEXT_STORAGE_LIMIT',outputLimit<messageLimit?'Context decoded history exceeds storage limit':'Context decompressed message exceeds storage limit',outputLimit<messageLimit?totalLimit:messageLimit)
        if(!legacy) throw fail('CONTEXT_DECODE_FAILED','Context message content could not be decoded')
        stats.legacyFallbackMessages++;fallback=true
      }
    }else if(legacy) stats.legacyTextMessages++
    const textBytes=Buffer.byteLength(text)
    if(!this.bestEffort && textBytes>MAX_MESSAGE_BYTES) throw fail('CONTEXT_STORAGE_LIMIT','Context text message exceeds storage limit',MAX_MESSAGE_BYTES)
    if(row.content==null || fallback){
      const counted=this.bestEffort?Math.min(textBytes,Buffer.byteLength(compactText(text,this.textLimit))):textBytes
      stats.decodedBytes+=counted;stats.decodeBudgetBytes+=counted
    }
    if((this.bestEffort?stats.decodeBudgetBytes:stats.decodedBytes)>totalLimit) throw fail('CONTEXT_STORAGE_LIMIT','Context decoded history exceeds storage limit',totalLimit)
    if(this.bestEffort && text.length>this.textLimit){
      const originalChars=text.length;text=compactText(text,this.textLimit)
      stats.compactions.push({messageId:String(row.id).slice(0,128),originalChars,retainedChars:text.length,strategy:'distributed-excerpts'})
    }
    if(!text.trim()) stats.nonTextMessages++
    return {...row,text}
 }
}
export async function decodeHistory(rows:HistoryRecord[]) {
 const decoder=new HistoryDecoder(),messages:HistoryRecord[]=[]
 for(const row of rows)messages.push(await decoder.decode(row))
 return {messages,stats:decoder.stats}
}
