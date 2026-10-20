import {gunzip} from 'node:zlib'
import {promisify} from 'node:util'
const decompress=promisify(gunzip)
const MAX_MESSAGE_BYTES=1024*1024
const MAX_TOTAL_BYTES=8*1024*1024
export type HistoryRecord={id:string;parentId?:string|null;role:string;text?:string|null;content?:ArrayBuffer|ArrayBufferView|string|null;createdAt?:Date|string|null}
export class ContextReadError extends Error {
  constructor(readonly code:'CONTEXT_EMPTY'|'CONTEXT_TEXT_UNAVAILABLE'|'CONTEXT_DECODE_FAILED'|'CONTEXT_STORAGE_LIMIT',message:string){super(message);this.name='ContextReadError'}
}
function textContent(value:unknown):string {
  if(typeof value==='string') return value
  if(!Array.isArray(value)) return ''
  return value.filter(v=>v && typeof v==='object' && v.type==='text' && typeof v.text==='string').map(v=>v.text).join('\n')
}
export async function decodeHistory(rows:HistoryRecord[]) {
  const messages:HistoryRecord[]=[],stats={compressedMessages:0,legacyTextMessages:0,legacyFallbackMessages:0,nonTextMessages:0,decodedBytes:0}
  for(const row of rows){
    let text=typeof row.text==='string'?row.text:''
    const legacy=!!text.trim()
    let fallback=false
    if(row.content!=null){
      try{
        if(typeof row.content==='string' && row.content.length>MAX_MESSAGE_BYTES*2) throw new ContextReadError('CONTEXT_STORAGE_LIMIT','Context compressed message exceeds storage limit')
        const bytes=typeof row.content==='string'?Buffer.from(row.content,'base64'):ArrayBuffer.isView(row.content)?Buffer.from(row.content.buffer,row.content.byteOffset,row.content.byteLength):Buffer.from(row.content)
        if(bytes.length>MAX_MESSAGE_BYTES) throw new ContextReadError('CONTEXT_STORAGE_LIMIT','Context compressed message exceeds storage limit')
        const raw=await decompress(bytes,{maxOutputLength:MAX_MESSAGE_BYTES})
        stats.decodedBytes+=raw.length
        text=textContent(JSON.parse(raw.toString('utf8')));stats.compressedMessages++
      }catch(error){
        if(error instanceof ContextReadError) throw error
        if((error as NodeJS.ErrnoException)?.code==='ERR_BUFFER_TOO_LARGE') throw new ContextReadError('CONTEXT_STORAGE_LIMIT','Context decompressed message exceeds storage limit')
        if(!legacy) throw new ContextReadError('CONTEXT_DECODE_FAILED','Context message content could not be decoded')
        stats.legacyFallbackMessages++;fallback=true
      }
    }else if(legacy) stats.legacyTextMessages++
    const textBytes=Buffer.byteLength(text)
    if(textBytes>MAX_MESSAGE_BYTES) throw new ContextReadError('CONTEXT_STORAGE_LIMIT','Context text message exceeds storage limit')
    if(row.content==null || fallback) stats.decodedBytes+=textBytes
    if(stats.decodedBytes>MAX_TOTAL_BYTES) throw new ContextReadError('CONTEXT_STORAGE_LIMIT','Context decoded history exceeds storage limit')
    if(!text.trim()) stats.nonTextMessages++
    messages.push({...row,text})
  }
  return {messages,stats}
}
