const {Context}=require('koishi')
const memory=require('@koishijs/plugin-database-memory').default
const server=require('@koishijs/plugin-server').default
const consolePlugin=require('@koishijs/plugin-console').default
const fs=require('node:fs'),path=require('node:path')
const previewRoot=path.resolve(__dirname,'../node_modules/.mail-preview')
for(const dir of ['lib','console']) fs.mkdirSync(path.join(previewRoot,dir),{recursive:true})
fs.copyFileSync(path.resolve(__dirname,'../lib/index.cjs'),path.join(previewRoot,'lib/index.cjs'))
fs.copyFileSync(path.resolve(__dirname,'../console/index.js'),path.join(previewRoot,'console/index.js'))
const mailPlugin=require(path.join(previewRoot,'lib/index.cjs'))
const {createServer}=require('node:net')
async function freePort(){return new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})})}
;(async()=>{
  const port=await freePort(),ctx=new Context()
  ctx.plugin(memory)
  ctx.plugin(server,{host:'127.0.0.1',port})
  ctx.plugin(consolePlugin,{open:false,uiPath:'/console',devMode:false})
  ctx.plugin({name:'preview-context',apply(scope){
    scope.provide('chatluna')
    scope.set('chatluna',{
      conversation:{
        getConversation:async()=>({id:'demo-conversation',status:'active',preset:'preview-preset',model:'preview/model',latestMessageId:'m2',lastChatAt:new Date()}),
        listMessages:async()=>[{id:'m1',parentId:null,role:'human',text:'隔离测试消息',createdAt:new Date()},{id:'m2',parentId:'m1',role:'ai',text:'用于验证上下文诊断',createdAt:new Date()}],
      },
      platform:{
        listAllModels:()=>({value:[{type:1,platform:'preview',name:'model',toModelName:()=> 'preview/model'},{type:1,platform:'preview',name:'alternate',toModelName:()=> 'preview/alternate'}]}),
        getToolRegistry:()=>({
          web_search:{name:'web_search',description:'搜索公开资料（隔离预览夹具）',meta:{source:'extension'}},
          music_library:{name:'music_library',description:'查询本地歌曲库（隔离预览夹具）',meta:{source:'extension'}},
          send_mail:{name:'send_mail',description:'可发送邮件的工具，不应出现在白名单',meta:{source:'extension'}},
        }),
        getTool:(name)=>({name,description:name,selector:()=>true,createTool:()=>({name})}),
        getFilteredTools:()=>['web_search','music_library'],
      },
      resolveToolMask:async()=>({mode:'allow',allow:['web_search','music_library'],deny:[]}),
      preset:{getPreset:()=>({value:{}}),getAllPreset:()=>({value:['preview-preset']})},
      promptRenderer:{renderPresetTemplate:async()=>({messages:[['system','隔离测试预设']]})},
      createChatModel:async()=>({value:{invoke:async()=>({content:'{"shouldSend":false,"reason":"隔离测试不发送邮件"}'})}}),
      createAgent:async()=>{throw new Error('隔离预览不执行工具工作流')},
    })
  }})
  ctx.plugin({name:'preview-media',apply(scope){
    scope.provide('mediaLuna')
    scope.set('mediaLuna',{
      channels:{list:async()=>[{name:'art',enabled:true},{name:'disabled',enabled:false}]},
      tasks:{getById:async()=>null},cache:{get:async()=>null},generateByName:async()=>null,
    })
  }})
  ctx.plugin(mailPlugin,{...mailPlugin.Config({token:'preview-only-no-live-credentials'}),allowedRecipients:['demo@example.com']})
  await ctx.start()
  ctx.model.extend('chatluna_conversation',{id:'string',title:'string',model:'string',preset:'string',status:'string',updatedAt:'timestamp'},{primary:'id'})
  await ctx.database.create('chatluna_conversation',{id:'demo-conversation',title:'演示日常会话',model:'preview/model',preset:'preview-preset',status:'active',updatedAt:new Date()})
  const now=new Date()
  await ctx.database.create('chatluna_mail',{
    id:'task:demo-daily',kind:'task',status:'paused',hash:'preview-demo',createdAt:now,updatedAt:now,
    payload:JSON.stringify({id:'demo-daily',enabled:false,time:'09:00',timezone:'Asia/Shanghai',conversationId:'demo-conversation',prompt:'基于当前上下文判断是否有新事项值得发送邮件',to:['demo@example.com']})
  })
  await ctx.database.create('chatluna_mail',{
    id:'task:demo-workflow',kind:'task',status:'paused',hash:'preview-workflow',createdAt:now,updatedAt:now,
    payload:JSON.stringify({id:'demo-workflow',name:'搜索选曲配图',enabled:false,time:'20:00',timezone:'Asia/Shanghai',conversationId:'demo-conversation',prompt:'搜索资料、从歌曲库选一首歌，必要时配图后写邮件',to:['demo@example.com'],executionMode:'tools',tools:['web_search','music_library'],workflowImages:true})
  })
  await ctx.database.create('chatluna_mail',{
    id:'settings:workflow',kind:'settings',status:'active',hash:'preview-workflow-settings',createdAt:now,updatedAt:now,
    payload:JSON.stringify({enabled:true,allowedTools:['web_search','music_library'],maxSteps:6,maxToolCalls:8,timeoutSeconds:120,maxToolResultChars:6000,platform:'preview',selfId:'bot',userId:'42',channelId:'',guildId:'',isDirect:true,mediaImportEnabled:true,mediaOwnerId:7,mediaChannels:['art']})
  })
  if(!ctx.bots.some(bot=>bot.platform==='preview'&&bot.selfId==='bot')) ctx.bots.push({platform:'preview',selfId:'bot',status:'online'})
  console.log('PREVIEW_URL=http://127.0.0.1:'+port+'/console/chatluna-mail')
  const stop=async()=>{await ctx.stop();process.exit(0)}
  process.on('SIGINT',stop);process.on('SIGTERM',stop)
})().catch(e=>{console.error(e);process.exit(1)})
