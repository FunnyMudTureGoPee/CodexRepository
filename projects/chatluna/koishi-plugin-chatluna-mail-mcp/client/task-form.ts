// Pure form helpers shared by the UI and acceptance tests.
export function splitTime(time:string) {const [hour,minute]=time.split(':');return {hour,minute}}
export function daysInMonth(year:number,month:number) {return new Date(Date.UTC(year,month,0)).getUTCDate()}
export function localParts(iso:string,timezone:string) {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso))
  const p=Object.fromEntries(parts.map(v=>[v.type,v.value]))
  return {year:p.year,month:p.month,day:p.day,hour:p.hour,minute:p.minute}
}
export function scheduledInstant(date:{year:string;month:string;day:string},time:string,timezone:string) {
  const {hour,minute}=splitTime(time), y=Number(date.year),m=Number(date.month),d=Number(date.day)
  if(d<1 || d>daysInMonth(y,m)) throw new Error('请选择有效日期')
  const target=Date.UTC(y,m-1,d,Number(hour),Number(minute))
  let instant=target
  for(let i=0;i<5;i++){
    const p=localParts(new Date(instant).toISOString(),timezone)
    const shown=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute))
    const delta=target-shown
    if(!delta) return new Date(instant).toISOString()
    instant+=delta
  }
  throw new Error('所选日期时间在该时区不存在，请调整时间（可能遇到夏令时）')
}
export function variableDefinitions(rows:Array<{name:string;required:boolean;default:string}>) {
  const fields:Record<string,{required:boolean;default:string}>={}
  for(const row of rows){
    const name=row.name.trim()
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('变量名称只能使用字母、数字、横线或下划线')
    if(Object.prototype.hasOwnProperty.call(fields,name)) throw new Error('变量名称重复：'+name)
    Object.defineProperty(fields,name,{value:{required:row.required,default:row.default},enumerable:true})
  }
  return fields
}
