'use strict';
const el = id => document.getElementById(id);
let revision = null, savedTokens = null, busy = false, hostOrigin = '*', nextId = 0;
const pending = new Map();
function post(message) { window.parent.postMessage({jsonrpc:'2.0', ...message},hostOrigin); }
function request(method,params) { return new Promise((resolve,reject) => {
  const id=++nextId;
  const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('连接超时，请重新打开上下文窗口插件。'));},20000);
  pending.set(id,{resolve,reject,timeout});post({id,method,params});
}); }
function theme(context={}) {
  for(const [key,value] of Object.entries(context.styles?.variables || {})) document.documentElement.style.setProperty(key,value);
  if(context.theme) document.documentElement.style.colorScheme=context.theme;
  if(context.safeAreaInsets) { const s=context.safeAreaInsets;document.body.style.padding=`${Math.max(20,s.top||0)}px ${Math.max(14,s.right||0)}px ${Math.max(20,s.bottom||0)}px ${Math.max(14,s.left||0)}px`; }
}
window.addEventListener('message',event=>{
  if(event.source!==window.parent || (hostOrigin!=='*'&&event.origin!==hostOrigin))return;
  const m=event.data;if(m?.jsonrpc!=='2.0')return;
  if(m.method==='ui/notifications/host-context-changed'){theme(m.params);return;}
  if(m.method==='ping'||m.method==='ui/resource-teardown'){if(m.id!=null)post({id:m.id,result:{}});return;}
  const p=pending.get(m.id);if(!p)return;
  if(hostOrigin==='*'&&event.origin!=='null')hostOrigin=event.origin;
  clearTimeout(p.timeout);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);
});
let ready;
function connect(){
  if(!ready)ready=(async()=>{
    if(window.parent===window)throw new Error('请从 Codex 的插件应用入口打开此面板。');
    const r=await request('ui/initialize',{appInfo:{name:'codex-context-window',version:'0.1.0'},appCapabilities:{availableDisplayModes:['inline','fullscreen']},protocolVersion:'2026-01-26'});
    theme(r.hostContext);post({method:'ui/notifications/initialized'});
  })().catch(error=>{ready=null;throw error;});
  return ready;
}
async function call(name,args={}){
  await connect();const r=await request('tools/call',{name,arguments:args});
  if(r.isError)throw new Error(r.content?.[0]?.text||'操作失败。');
  if(!r.structuredContent)throw new Error('未收到配置数据。');
  return r.structuredContent;
}
function update(){
  el('value').textContent=el('window').value;
  el('window').disabled=busy||revision===null;
  el('apply').disabled=busy||revision===null||Number(el('window').value)*1000===savedTokens;
  el('reset').disabled=busy||revision===null;
  el('reload').disabled=busy;
}
function render(data){
  revision=data.revision;savedTokens=data.tokens;el('window').value=data.selectedK;
  el('saved').textContent=data.tokens==null?'尚未设置 · 默认选择 512k':`已保存：${(data.tokens/1000).toLocaleString()}k tokens`;
  el('path').textContent=data.configPath;
  el('details').textContent=`全局模型：${data.model||'默认'}；自动压缩阈值：${data.autoCompactTokens??'模型默认'}${data.hasProfileOverrides?'；存在配置档覆盖值':''}`;
}
async function perform(action){
  if(busy)return;busy=true;update();el('status').className='';el('status').textContent=action==='save'?'正在保存…':'正在读取…';
  try{
    const data=await call(action==='save'?'set_context_window':'read_context_window',action==='save'?{window_k:Number(el('window').value),revision}:{});
    render(data);el('status').className='success';el('status').textContent=action==='save'?`已保存 ${data.tokens/1000}k。${data.changed?'原配置已备份。':''}重启 Codex 并新建聊天后使用。`:'';
  }catch(error){el('status').className='error';el('status').textContent=error.message;}
  finally{busy=false;update();}
}
el('window').addEventListener('input',update);
el('reset').addEventListener('click',()=>{el('window').value=512;update();el('status').className='';el('status').textContent='已选择默认 512k，点击“应用”保存。';});
el('apply').addEventListener('click',()=>perform('save'));
el('reload').addEventListener('click',()=>perform('read'));
perform('read');
