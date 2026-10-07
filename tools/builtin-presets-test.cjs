// Exercise the real settings and carousel scripts against local host responses.
// Requires Playwright on NODE_PATH; no user profile or desktop window is used.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');const root=path.join(__dirname,'..');
const consoleScript=fs.readFileSync(path.join(root,'console.js'),'utf8'),framing=fs.readFileSync(path.join(root,'framing.js'),'utf8');
const saved=[{id:'builtin-gallery',name:'画窗',type:'image',bundled:true},{id:'custom',name:'自己的图片',type:'image'},{id:'video',name:'自己的视频',type:'video'}];
let active=null,failNext=false;const calls=[];
const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json;charset=utf-8');
  if(req.url==='/__beauticode/ui/status'){res.end(JSON.stringify({ok:true,muted:true,atmosphere:active,themeId:active==='custom'?'custom':null,themes:saved,importPolicy:{managedUploadAllowed:false}}));return;}
  if(req.url==='/__beauticode/ui/carousel'){res.end(JSON.stringify({ok:true,groups:[{id:'group',name:'已有分组',items:[{kind:'preset',id:'internal'},{kind:'preset',id:'infernal'}],intervalMs:60000,order:'sequential'}],activeGroupId:null}));return;}
  if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);calls.push({path:req.url,body:data});
    if(failNext){failNext=false;res.statusCode=422;res.end(JSON.stringify({ok:false,error:'测试切换失败'}));return;}
    active=req.url.endsWith('/preset')?data.id:data.id==='builtin-gallery'?'gallery':data.id;
    res.end(JSON.stringify({ok:true,message:'已切换'}));return;
  }
  res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><html><head><style>body{margin:0;font:14px/24px sans-serif}.dialog{display:flex;width:1000px}nav{width:120px}#options{width:780px}[hidden]{display:none!important}</style></head><body><div class="dialog" role="dialog" aria-modal="true"><nav><div><button>通用设置</button></div></nav><div id="options"><div data-slot="settings.section"></div></div></div><script>${consoleScript}</script><script>${framing}</script></body></html>`);
});
(async()=>{server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const browser=await chromium.launch({channel:process.env.DSH_TEST_BROWSER_CHANNEL||'msedge',headless:true});const page=await browser.newPage({viewport:{width:1200,height:1200}}),errors=[];page.on('pageerror',e=>errors.push(e.message));let checks=0;
const check=(v,m)=>{assert(v,m);checks++;console.log('PASS '+m);};const entry=id=>page.locator('[data-theme-id="'+id+'"]');
try{await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.getByRole('button',{name:'背景',exact:true}).click();
await entry('builtin-internal').waitFor();
check(await entry('builtin-internal').locator('.bc-theme-name').innerText()==='雨中百合'&&await entry('builtin-infernal').locator('.bc-theme-name').innerText()==='深色百合'&&await entry('builtin-infernal').locator('.bc-source').innerText()==='内置','both Chinese presets appear as built-in image entries');
check(await page.locator('.bc-theme-count').innerText()==='4','image count includes gallery, lilies and saved image');
check(await page.locator('[data-theme-delete^="builtin-"]').count()===0,'built-in presets have no delete button');
await entry('builtin-internal').click();await page.waitForFunction(()=>document.querySelector('[data-theme-id="builtin-internal"]')?.getAttribute('aria-current')==='true');
check(calls.at(-1).path==='/__beauticode/ui/preset'&&calls.at(-1).body.id==='internal','rain lily uses existing preset route and stable ID');
check(await entry('builtin-internal').locator('.bc-theme-dot').count()===1,'selected rain lily has the current-use indicator');
await entry('builtin-infernal').click();await page.waitForFunction(()=>document.querySelector('[data-theme-id="builtin-infernal"]')?.getAttribute('aria-current')==='true');
check(calls.at(-1).body.id==='infernal'&&await entry('builtin-internal').locator('.bc-theme-dot').count()===0,'dark lily replaces the active indicator');
await page.reload();await page.getByRole('button',{name:'背景',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-theme-id="builtin-infernal"]')?.getAttribute('aria-current')==='true');
check(true,'active lily is recognized after page reload');
await page.getByRole('tab',{name:'视频',exact:true}).click();check(await page.locator('.bc-theme-count').innerText()==='1'&&await entry('builtin-internal').count()===0,'image presets stay out of video category');
await page.getByRole('tab',{name:'图片',exact:true}).click();await entry('custom').click();await page.waitForFunction(()=>document.querySelector('[data-theme-id="custom"]')?.getAttribute('aria-current')==='true');
check(calls.at(-1).path==='/__beauticode/ui/theme/use'&&calls.at(-1).body.id==='custom','user background retains ordinary theme route');
failNext=true;await entry('builtin-internal').click();await page.getByText('测试切换失败',{exact:true}).waitFor();check(await entry('custom').getAttribute('aria-current')==='true'&&await entry('builtin-internal').isEnabled(),'failed preset selection leaves active item and controls intact');
await page.locator('[data-bgc-act="carousel-toggle"]').click();await page.locator('[data-bgc-carousel="add"] option').last().waitFor({state:'attached'});
const labels=await page.locator('[data-bgc-carousel="add"] option').allTextContents();
check(labels.filter(x=>x==='雨中百合（内置）').length===1&&labels.filter(x=>x==='深色百合（内置）').length===1&&!labels.some(x=>/Internal|Infernal/.test(x)),'carousel offers each Chinese preset once');
check((await page.locator('.bgc-citem-name').allTextContents()).join('|')==='雨中百合|深色百合','existing carousel IDs receive Chinese labels without migration');
check(errors.length===0,'no client runtime errors');console.log('Verified '+checks+' checks');
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
