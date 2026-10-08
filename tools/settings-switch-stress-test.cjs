// Combined real settings/bridge/framing/atmosphere scripts on a local fixture.
// The fake host waits for the real renderer receipt before completing a switch.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=process.env.BG_SOURCE_ROOT||path.join(__dirname,'..');
const scripts=['atmosphere.js','client.js','console.js','framing.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8'));
let page,active=null,generation=0,statusCount=0,postCount=0,statusDelay=0,failNext=false;
const receipt=new Map(),errors=[],acks=[];
const themes=[{id:'builtin-gallery',name:'画窗',type:'image',bundled:true},...Array.from({length:6},(_,i)=>({id:'saved'+i,name:'图片'+i,type:'image',sourceMode:'managed'}))];
const snapshot=()=>({ok:true,muted:true,atmosphere:active==='builtin-gallery'?'gallery':active==='builtin-internal'?'internal':active==='builtin-infernal'?'infernal':null,themeId:active?.startsWith('saved')?active:null,themes,importPolicy:{managedUploadAllowed:false}});
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');res.setHeader('content-type','application/json');
  if(url.pathname==='/__beauticode/ui/status'){statusCount++;const data=snapshot();await new Promise(r=>setTimeout(r,statusDelay));res.end(JSON.stringify(data));return;}
  if(url.pathname==='/__beauticode/ui/carousel'){res.end(JSON.stringify({ok:true,groups:[],activeGroupId:null}));return;}
  if(url.pathname==='/__beauticode/ack'){let raw='';for await(const c of req)raw+=c;const ack=JSON.parse(raw);acks.push(ack);if(ack.kind==='render'&&ack.ok)receipt.get(ack.generation)?.();res.end('{}');return;}
  if(url.pathname.endsWith('.svg')){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><path fill="#246c5b" d="M0 0h600v400H0z"/></svg>');return;}
  if(req.method==='POST'){
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);postCount++;await new Promise(r=>setTimeout(r,120));
    if(failNext){failNext=false;res.statusCode=422;res.end(JSON.stringify({ok:false,error:'fixture switch failed'}));return;}
    active=url.pathname.endsWith('/preset')?'builtin-'+body.id:body.id;const g=++generation;
    const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('renderer receipt timeout')),4000);receipt.set(g,()=>{clearTimeout(timer);receipt.delete(g);resolve();});});
    await page.evaluate(p=>sendBG(p),{type:'apply',generation:g,media:'image',imageUrl:'/bg-'+active+'.svg',atmosphere:{preset:snapshot().atmosphere}});await ready;
    res.end(JSON.stringify({ok:true,message:'已切换'}));return;
  }
  if(url.pathname.startsWith('/__beauticode/')){res.end('{}');return;}
  res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><html><head><style>html,body,#root{margin:0;height:100%}body{font:14px/24px sans-serif}.test_frame{height:100%;display:flex}.test_sidebarCol{width:240px}.test_centerCol{flex:1}#dialog{position:fixed;inset:30px;display:flex;z-index:30}nav{width:150px}#options{width:850px;overflow:auto}[hidden]{display:none!important}</style></head><body><div id="root"><div class="test_frame"><div class="test_sidebarCol"></div><div class="test_centerCol"></div></div></div><div id="dialog" role="dialog" aria-modal="true"><nav><div><button>通用设置</button></div></nav><div id="options"><div data-slot="settings.section"></div></div></div><script>window.paintCount=0;const paint=CanvasRenderingContext2D.prototype.putImageData;CanvasRenderingContext2D.prototype.putImageData=function(...a){paintCount++;return paint.apply(this,a)};window.__beauticodeTransport={headers:()=>({}),events:(url,fn)=>window.sendBG=p=>fn({data:JSON.stringify(p)})};</script>${scripts.map(s=>'<script>'+s+'</script>').join('')}</body></html>`);
});
(async()=>{server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const browser=await chromium.launch({channel:process.env.DSH_TEST_BROWSER_CHANNEL||'msedge',headless:true});page=await browser.newPage({viewport:{width:2144,height:1400},deviceScaleFactor:1.5});page.on('pageerror',e=>errors.push(e.message));let passed=0;const check=(v,m)=>{assert(v,m);passed++;console.log('PASS '+m);};
const ready=()=>page.waitForFunction(()=>!document.querySelector('#beauticode-console-page').dataset.busy);const click=id=>page.locator('[data-theme-id="'+id+'"]').click();
try{
  await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('button',{name:'背景',exact:true}).click();await click('builtin-gallery');await ready();await page.waitForFunction(()=>document.querySelector('[data-theme-id="builtin-gallery"]').getAttribute('aria-current')==='true');
  const firstPosts=postCount;
  await page.evaluate(()=>{for(let i=0;i<100;i++)document.querySelector('[data-theme-id="builtin-gallery"]').click();});await page.waitForTimeout(500);
  check(postCount===firstPosts,'100 clicks on the active wallpaper perform zero additional host applies');
  const pixels=await page.locator('#beauticode-gallery-bg canvas').evaluate(c=>c.width*c.height);
  check(pixels<200000,'4K/DPR water canvas retains the small simulation texture instead of a full-window bitmap');
  const paints=await page.evaluate(()=>paintCount);await page.mouse.move(450,180);await page.waitForTimeout(400);
  check(await page.evaluate(()=>paintCount)===paints,'settings interaction does not continuously repaint water beneath the modal');
  statusDelay=250;const start=statusCount;
  await page.evaluate(()=>{for(let i=0;i<100;i++)document.dispatchEvent(new CustomEvent('bgc:background-changed'));});await page.waitForTimeout(650);
  check(statusCount-start<=2,'100 background signals coalesce into at most two status reads');
  const oldItem=await page.locator('[data-theme-id="builtin-gallery"]').elementHandle();await page.evaluate(()=>document.dispatchEvent(new CustomEvent('bgc:background-changed')));await page.waitForTimeout(320);
  check(await oldItem.evaluate(e=>e.isConnected),'unchanged status preserves the list DOM instead of rebuilding it');
  await click('builtin-internal');await page.waitForTimeout(30);await page.evaluate(()=>document.dispatchEvent(new CustomEvent('bgc:background-changed')));
  check(await page.locator('.bc-theme-item:enabled').count()===0,'status refresh cannot unlock buttons during a pending background switch');
  await ready();await page.waitForFunction(()=>document.querySelector('[data-theme-id="builtin-internal"]').getAttribute('aria-current')==='true');
  for(const id of ['builtin-infernal','saved0','builtin-gallery','saved1','builtin-internal','builtin-gallery']){await click(id);await ready();await page.waitForFunction(id=>document.querySelector('[data-theme-id="'+id+'"]').getAttribute('aria-current')==='true',id);}
  check(await page.locator('.beauticode-media-slot').count()===1&&await page.locator('#beauticode-gallery-bg').count()===1,'repeated real renderer handovers leave one media slot and one gallery');
  failNext=true;await click('saved2');await ready();
  check(await page.locator('[data-theme-id="builtin-gallery"]').getAttribute('aria-current')==='true','failed selection preserves the actually active background');
  check(await page.locator('.bc-theme-item:disabled').count()===0,'controls recover after a failed switch');
  check(errors.length===0,'combined plugin scripts report no client errors');
  check(acks.length>0&&acks.every(a=>a.desktopWindows===false),'ordinary browser receipts cannot opt into Windows border changes');
  const nextReceipt=async(action,test)=>{const start=acks.length;await action();const deadline=Date.now()+3000;while(Date.now()<deadline&&!acks.slice(start).some(test))await new Promise(r=>setTimeout(r,20));return acks.slice(start).some(test);};
  check(await nextReceipt(()=>page.evaluate(()=>{window.dshDesktop={protocolVersion:1};Object.defineProperty(navigator,'platform',{configurable:true,value:'Win32'});document.dispatchEvent(new CustomEvent('bgc:settings-changed'));}),a=>a.desktopWindows&&a.nativeBorderHidden),'native desktop reports the default enabled edge policy');
  check(await nextReceipt(()=>page.locator('[data-bgc-act="edge"]').click(),a=>a.desktopWindows&&!a.nativeBorderHidden),'edge switch off immediately reports native border restoration');
  check(await nextReceipt(()=>page.locator('[data-bgc-act="edge"]').click(),a=>a.desktopWindows&&a.nativeBorderHidden),'edge switch on immediately reports native border suppression');
  check(await nextReceipt(()=>page.evaluate(()=>sendBG({type:'apply',generation:500,media:'clear'})),a=>a.kind==='render'&&a.generation===500&&!a.nativeBorderHidden),'clearing background restores the native border policy');
  check(errors.length===0,'native border receipt integration leaves the renderer error-free');
  console.log(passed+' integrated rapid selection checks passed');
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
