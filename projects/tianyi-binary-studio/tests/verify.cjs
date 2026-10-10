const fs=require('fs'),vm=require('vm'),assert=require('assert');const {createCanvas,loadImage}=require('@napi-rs/canvas');
const els={};function el(id){return els[id]??=(id==='canvas'?Object.assign(createCanvas(1200,1500),{style:{},addEventListener(){}}):{value:'',checked:false,min:'0',max:'999999',style:{},options:[],classList:{toggle(){},add(){},remove(){}},addEventListener(){},setAttribute(){},insertAdjacentHTML(_,s){for(const m of s.matchAll(/<input id="([^"]+)" type="range" min="([^"]+)" max="([^"]+)" step="([^"]+)" value="([^"]+)"/g)){Object.assign(el(m[1]),{min:m[2],max:m[3],value:m[5]});}}});}
for(const [k,v] of Object.entries({width:1200,height:1500,seed:66,direction:'left',remove:'off',colorMode:'original',accent:'#66ccff',background:'#071422',title:'LUO TIANYI'}))el(k).value=v;for(const [k,v] of Object.entries({printW:200,printH:250,bleedMm:3,printPpi:300}))el(k).value=v;el('showBleed').checked=true;el('frame').checked=true;el('editGuides').checked=true;el('pickTarget').value='dissolve';Object.assign(el('phraseGap'),{value:.45,min:.1,max:2});Object.assign(el('lyricDistance'),{value:38,min:10,max:100});Object.assign(el('lyricDensity'),{value:45,min:8,max:100});el('midiLayout').value='orbit';Object.assign(el('midiSpread'),{value:80,min:45,max:100});Object.assign(el('lyricSize'),{value:26,min:14,max:48});el('lyrics').value='';el('segmentStart').value=0;el('segmentLength').value=8;el('waveGain').value=1.5;el('lyricOffset').value=0;el('lyricChars').value=18;el('showWave').checked=true;el('showLyrics').checked=true;for(const k of ['width','height']){el(k).min=320;el(k).max=2400;}el('direction').options=['left','right','bottom','top','center','edges','angle'].map(value=>({value}));el('remove').options=['off','edge','all'].map(value=>({value}));el('colorMode').options=['original','mix','mono'].map(value=>({value}));
const ctx={console,TextDecoder,document:{getElementById:el,querySelectorAll:()=>[],querySelector:()=>el('wrapper'),createElement:t=>t==='canvas'?createCanvas(1,1):el('anchor')},setTimeout,clearTimeout,Blob,URL};vm.createContext(ctx);const path=require('path');const html=fs.readFileSync(path.join(__dirname,'..','Tianyi_Binary_Studio.html'),'utf8');let code=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('updateUI();loadExample();','updateUI();');vm.runInContext(code,ctx);
(async()=>{ctx.img=await loadImage(html.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/)[0]);vm.runInContext('source=img;sourceVersion++;',ctx);for(const m of ['rebuild','touch','plain']){vm.runInContext(`mode='${m}';render();`,ctx);assert.equal(el('renderState').textContent,'预览已更新');assert(!el('count').textContent.startsWith('0 '));}vm.runInContext('apply(validate({...getState(),transparent:true,frame:false}));',ctx);assert.equal(els.canvas.getContext('2d').getImageData(0,0,1,1).data[3],0);assert.throws(()=>vm.runInContext('validate({spacing:0})',ctx));assert.throws(()=>vm.runInContext('validate({accent:"bad"})',ctx));const codeTest="\nfunction midiFixture(){\n const vlq=n=>{let a=[n&127];while(n>>=7)a.unshift((n&127)|128);return a;};\n const chunk=a=>[77,84,114,107,0,0,(a.length>>8)&255,a.length&255,...a];\n const tempo=[0,255,81,3,7,161,32,...vlq(480),255,81,3,15,66,64,0,255,47,0];\n const notes=[0,144,60,100,...vlq(480),60,0,0,255,5,2,108,97,0,144,62,80,...vlq(480),128,62,0,0,255,47,0];\n return new Uint8Array([77,84,104,100,0,0,0,6,0,1,0,2,1,224,...chunk(tempo),...chunk(notes)]).buffer;\n}\nconst parsed=parseMidi(midiFixture());if(parsed.notes.length!==2||parsed.notes[0].end!==.5||parsed.notes[1].end!==1.5||parsed.lyrics[0].time!==.5)throw Error('Tempo / running status / lyrics mismatch');\nlet rejected=false;try{parseMidi(new Uint8Array([1,2,3]).buffer);}catch{rejected=true;}if(!rejected)throw Error('Truncated MIDI accepted');\nmidi=parsed;$('midiTrack').value='all';$('lyrics').value='';syncLyrics();mode='rebuild';render();if($('renderState').textContent!=='\u9884\u89c8\u5df2\u66f4\u65b0')throw Error($('renderState').textContent);if(parts.join('').includes('>la</text>'))throw Error('Unexpected lyric rendering');\n";vm.runInContext(codeTest,ctx);vm.runInContext("$('midiLayout').value='diagonal';render();if($('renderState').textContent!=='预览已更新')throw Error('Diagonal render failed');",ctx);vm.runInContext(`
const testState={...getState(),dissolveX:50,dissolveY:50,dissolveAngle:90};
if(dispersion(.5,.5,{...testState,direction:'center'}).axis!==1)throw Error('Center mask');
if(dispersion(.5,.5,{...testState,direction:'edges'}).axis!==0)throw Error('Edge mask');
if(Math.abs(dispersion(.5,.8,{...testState,direction:'angle'}).axis-.8)>.0001)throw Error('Angle mask');
for(const direction of ['center','edges','angle','top']){apply(validate({...getState(),mode:'rebuild',direction}));if($('renderState').textContent!=='预览已更新')throw Error(direction+' render');}
`,ctx);vm.runInContext(`const picked=pickPoint(250,300,{left:100,top:100,width:300,height:400},1200,1500);if(Math.abs(picked.x-50)>.001||Math.abs(picked.y-50)>.001)throw Error('Scaled click mapping');`,ctx);vm.runInContext(`
const linked=linkedLyrics([{start:0,end:.5,pitch:60},{start:1,end:2,pitch:62}],[{time:0,text:'你好'}],true,0,.4);if(linked.fragments.length!==2||linked.phrases.length!==2||!linked.fragments.every(f=>f.estimated))throw Error('Lyric links');
$('midiLayout').value='orbit';$('pickTarget').value='ring';$('ringX').value=30;$('ringY').value=40;updatePoint();const mg=printGeometry(getState(),printSettings());if(Math.abs(parseFloat($('pointMarker').style.left)-(getState().width*.3-mg.x)/mg.w*100)>.001)throw Error('Ring marker');render();if($('renderState').textContent!=='预览已更新')throw Error('Ring rendering');
`,ctx);vm.runInContext(`
if(orbitOpacity(0,300,120)!==1||orbitOpacity(.4,300,120)!==1||orbitOpacity(1,300,120)!==0)throw Error('Fade boundaries');
let last=1;for(let t=0;t<=1;t+=.05){const a=orbitOpacity(t,300,120);if(a>last+.0001)throw Error('Nonmonotonic fade');last=a;}
apply(validate({...getState(),orbitArc:90,orbitFade:120}));if(Number($('orbitFade').value)!==90)throw Error('Angle clamping');
apply(validate({...getState(),orbitArc:300,orbitFade:120}));if($('renderState').textContent!=='预览已更新')throw Error('Arc render');
`,ctx);vm.runInContext(`for(const orbitStart of [0,90,180,270,359]){apply(validate({...getState(),orbitStart}));if($('renderState').textContent!=='预览已更新')throw Error('Start angle render');}if(validate({}).orbitStart!==90)throw Error('Legacy config default');`,ctx);vm.runInContext(`
mode='rebuild';$('direction').value='center';$('midiLayout').value='orbit';$('pickTarget').value='ring';$('dissolveX').value=17;$('dissolveY').value=23;applyCanvasPoint(70,80);if(Number($('ringX').value)!==70||Number($('dissolveX').value)!==17)throw Error('Ring affected dissolve');
$('pickTarget').value='dissolve';applyCanvasPoint(30,40);if(Number($('ringX').value)!==70||Number($('dissolveX').value)!==30)throw Error('Dissolve affected ring');
$('pickTarget').value='ring';$('midiLayout').value='diagonal';if(applyCanvasPoint(5,5)!==false||Number($('dissolveX').value)!==30)throw Error('Inactive target fallback');
mode='touch';$('pickTarget').value='touch';applyCanvasPoint(11,12);if(Number($('touchX').value)!==11||Number($('ringX').value)!==70||Number($('dissolveX').value)!==30)throw Error('Touch isolation');
`,ctx);vm.runInContext(`
mode='rebuild';$('midiLayout').value='orbit';render();if($('renderState').textContent!=='预览已更新')throw Error($('renderState').textContent);
const svg=parts.join('');if(!(svg.indexOf('id="midi-back"')<svg.indexOf('id="binary-character"')&&svg.indexOf('id="binary-character"')<svg.indexOf('id="midi-front"')))throw Error('Layer order');
apply(validate({...getState(),width:1600,height:1000,posX:35,posY:60}));if(Number($('width').value)!==1600||Number($('posX').value)!==35)throw Error('Manual canvas controls');
`,ctx);vm.runInContext(`
const v15s={...getState(),orbitStart:0,orbitArc:360,frontSplit:0,rearOpacity:36,depthBlend:25};
if(Math.abs(midiDepthBrightness(0,v15s)-midiDepthBrightness(.000001,v15s))>.00001)throw Error('Brightness discontinuity');
if(Math.abs(midiDepthBrightness(.25,v15s)-.36)>.00001)throw Error('Rear brightness');
if(midiDepthBrightness(.75,v15s)!==1)throw Error('Front brightness');
if('quietStart' in validate({...getState(),quietStart:58}))throw Error('Legacy spatial fade retained');
mode='rebuild';$('midiLayout').value='orbit';$('editGuides').checked=true;render();
if(!$('guideOverlay').innerHTML.includes('起点')||!$('guideOverlay').innerHTML.includes('身后'))throw Error('Missing guides');
if(parts.join('').includes('起点')||parts.join('').includes('身后'))throw Error('Guides leaked into SVG export');
const withGuides=$('canvas').toBuffer('image/png');$('editGuides').checked=false;render();
if(!withGuides.equals($('canvas').toBuffer('image/png')))throw Error('Guides leaked into PNG export');
`,ctx);vm.runInContext(`
apply(validate({...getState(),frame:true,midiBrightness:300,midiGlow:100,noteAccent:100}));
if(parts.join('').includes('RECONSTRUCT')||parts.join('').includes('id="structure"'))throw Error('Removed decorations returned');
if(!parts.join('').includes('id="structure-bottom"')||!parts.join('').includes('VOICE'))throw Error('Bottom terminal details missing');if($('renderState').textContent!=='预览已更新')throw Error('Enhanced MIDI render');
`,ctx);vm.runInContext(`
apply(validate({...getState(),terminalStatus:true,terminalMidi:true,terminalAnchor:true}));
if(!parts.join('').includes('SAMPLES')||!parts.join('').includes('MIDI / LOADED')||!parts.join('').includes('ORBIT /'))throw Error('Terminal data missing');
apply(validate({...getState(),terminalStatus:false,terminalMidi:false,terminalAnchor:false}));
if(parts.join('').includes('SAMPLES')||parts.join('').includes('ORBIT /'))throw Error('Terminal switches ignored');
`,ctx);vm.runInContext(`
apply(validate({...getState(),terminalUpper:true,upperX:7,upperY:9}));
if(!parts.join('').includes('POS  ')||!parts.join('').includes('GRID '))throw Error('Registration missing');
apply(validate({...getState(),terminalUpper:false}));
if(parts.join('').includes('POS  '))throw Error('Registration toggle');
`,ctx);vm.runInContext(`
const pq=printSettings({printW:350,printH:300,bleedMm:3,printPpi:300});const pg=printGeometry({width:1750,height:1500},pq);
if(pg.pw!==4205||pg.ph!==3614)throw Error('Print pixels');
const ps=buildPrintSvg({width:1750,height:1500},pq);if(!ps.includes('width="356mm"')||ps.includes('id="print-trim-guide"'))throw Error('Print SVG dimensions / guides');
if(!buildPrintSvg({width:1750,height:1500},{...pq,exportBleedLines:true}).includes('id="print-trim-guide"'))throw Error('Proof guide missing');
if(pg.x>=0||pg.y>=0||Math.abs(pg.w-2*pg.b-1750)>.00001||Math.abs(pg.h-2*pg.by-1500)>.00001)throw Error('Bleed must expand');
`,ctx);const rb=await vm.runInContext("pngResolution(new Uint8Array($('canvas').toBuffer('image/png')),300).arrayBuffer()",ctx);const pb=Buffer.from(rb);assert.equal(pb.toString('ascii',12,16),'IHDR');assert.equal(pb.toString('ascii',37,41),'pHYs');assert.equal(pb.readUInt32BE(41),11811);console.log("PASS: render modes, MIDI parser, independent anchors, angular fade, continuous depth brightness, legacy config, editor guides and clean exports.");})();