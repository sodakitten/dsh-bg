// Regression for material on an input owner changing fixed overlay coordinates.
// Uses a local page only; FRAME_SOURCE can point at the previous release to
// demonstrate the regression. Requires Playwright on NODE_PATH.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const source=fs.readFileSync(process.env.FRAME_SOURCE||path.join(__dirname,'../framing.js'),'utf8');
const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/__beauticode/')){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,identity:null,themes:[],groups:[]}));return;}
  res.setHeader('content-type','text/html;charset=utf-8');
  res.end(`<!doctype html><html data-bc-active="true" data-bc-resolved-tone="light"><head><style>
  html,body{margin:0;height:100%;font:14px/24px sans-serif;background:#a4b3c4}
  body{--dsw-radius-panel:18px;--dsw-alias-bg-base:#f8fafc;--dsw-specific-input-major:#f8fafc}
  #root{height:100%;display:flex;flex-direction:column}#transcript{flex:1;overflow:auto;min-height:0}#transcript>div{height:1800px}
  .native_composerSeat{flex:none;padding:8px 20px}.native_composerStack{display:flex;flex-direction:column}
  [data-composer-card]{position:relative;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;border-radius:18px;background:var(--dsw-specific-input-major);padding:12px}
  #attachments{display:flex;gap:10px}#attachments span{width:68px;height:68px;background:#aabbcc;border-radius:14px}
  #draft{white-space:pre-wrap;min-height:60px;max-height:160px;overflow:auto;outline:none}#tools{display:flex;justify-content:flex-end}
  .fixed-overlay{position:fixed;top:80px;left:40px;width:300px;height:160px;border-radius:12px;background:#fff}
  #portal-menu{position:fixed;top:100px;right:30px;width:280px;height:160px;border-radius:12px;background:#fff}
  #question{position:relative;width:680px;max-width:100%;height:180px;border-radius:18px;background:#f8fafc}
  #beauticode-console-page{display:none}
  </style></head><body><div id="root"><div id="transcript"><div>Transcript</div></div><div class="native_composerSeat"><div class="native_composerStack"><div id="card" data-composer-card><div id="attachments"><span></span><span></span></div><div id="draft" contenteditable="true" data-composer-input>Long draft\nSecond line\nThird line</div><div id="tools"><button id="model">Model A</button></div></div></div></div></div><script>${source}</script></body></html>`);
});
(async()=>{
  server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const browser=await chromium.launch({channel:process.env.DSH_TEST_BROWSER_CHANNEL||'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1000,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let checks=0;const check=(v,m)=>{assert(v,m);checks++;console.log('PASS '+m);};
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForTimeout(350);
    const state=()=>page.evaluate(()=>{const c=document.getElementById('card'),r=c.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,scroll:document.getElementById('transcript').scrollTop,windowScroll:window.scrollY,htmlHeight:document.documentElement.scrollHeight,text:document.getElementById('draft').textContent,tag:document.querySelector('[data-bgc-composer="1"]')?.id,filter:getComputedStyle(c).backdropFilter,material:getComputedStyle(c,'::before').backdropFilter};});
    await page.locator('#transcript').evaluate(el=>el.scrollTop=900);const initial=await state();
    await page.evaluate(()=>{const bubble=document.createElement('div');bubble.className='fixed-overlay';bubble.id='bubble';bubble.innerHTML='<button>Overlay action</button>';document.getElementById('card').append(bubble);});await page.waitForTimeout(300);
    const rect=await page.locator('#bubble').boundingBox();
    check(rect.x===40&&rect.y===80,'inline fixed overlay retains viewport coordinates (old card filter moves it)');
    const material=await state();check(material.filter==='none'&&material.material==='blur(28px)','only the noninteractive material is filtered');
    await page.evaluate(()=>{window.composerGeometryReads=0;const native=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){if(this.closest('[data-composer-card]'))window.composerGeometryReads++;return native.call(this);};document.getElementById('attachments').append(document.createElement('span'));});
    await page.waitForTimeout(300);
    check(await page.evaluate(()=>window.composerGeometryReads)===0,'attachment mutations do not trigger a composer geometry scan');
    for(let i=0;i<8;i++){
      await page.evaluate(i=>{document.getElementById('model').textContent=i%2?'Long model name with reasoning':'Model A';const menu=document.createElement('div');menu.id='portal-menu';menu.setAttribute('role','menu');menu.innerHTML='<button>Model option</button>';document.body.append(menu);document.getElementById('model').focus();document.getElementById('model').classList.toggle('selected');},i);
      await page.waitForTimeout(230);await page.locator('#portal-menu').evaluate(el=>el.remove());
      const now=await state();check(now.tag==='card'&&now.x===initial.x&&now.y===initial.y&&now.h===initial.h&&now.scroll===initial.scroll&&now.windowScroll===0&&now.htmlHeight===800&&now.text===initial.text,'model selection '+i+' preserves card, draft and scrolling');
    }
    await page.evaluate(()=>{const card=document.getElementById('card');card.remove();document.querySelector('.native_composerStack').innerHTML='<div data-question-key="test"><div id="question" class="native_card">Question card<button>Answer</button></div></div>';});await page.waitForTimeout(300);
    check(await page.locator('[data-bgc-composer="1"]').count()===0&&await page.locator('#question').evaluate(el=>getComputedStyle(el).backgroundColor==='rgb(248, 250, 252)'),'question replacement uses its own solid theme surface');
    await page.evaluate(()=>document.querySelector('[data-question-key]').remove());await page.waitForTimeout(300);
    check(await page.locator('[data-bgc-composer="1"]').count()===0,'empty seat clears old surface');
    await page.evaluate(()=>document.querySelector('.native_composerStack').innerHTML='<div id="restored" data-composer-card><div data-composer-input contenteditable>Restored draft</div><button>Model B</button></div>');await page.waitForTimeout(300);
    check(await page.locator('#restored').getAttribute('data-bgc-composer')==='1','returning composer reuses host marker');
    check(errors.length===0,'no browser errors');console.log('Verified '+checks+' checks');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
