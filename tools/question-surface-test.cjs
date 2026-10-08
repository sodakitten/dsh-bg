// Pending interaction readability without a working backdrop texture, including
// repeated tab/window focus events. Isolated local fixture; no real user answers.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{PNG}=require('pngjs');
const source=fs.readFileSync(process.env.FRAME_SOURCE||path.join(__dirname,'../framing.js'),'utf8');
const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/__beauticode/')){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,identity:null,themes:[],groups:[]}));return;}
  res.setHeader('content-type','text/html;charset=utf-8');
  res.end(`<!doctype html><html data-bc-active="true" data-bc-resolved-tone="light"><head><style>
  html,body{margin:0;height:100%;font:14px/24px sans-serif}
  body{--dsw-static-neutral-bluish-900:#11141b;--dsw-static-neutral-bluish-50:#f8fafc;--dsw-specific-input-major:rgba(248,250,252,.36)}
  #transcript{position:fixed;inset:0;background:repeating-linear-gradient(90deg,#f00 0 20px,#00f 20px 40px)}
  .native_composerSeat{position:absolute;top:260px;left:80px;width:720px}
  .native_card{width:680px;height:220px;box-sizing:border-box;display:flex;flex-direction:column;border-radius:18px;background:var(--dsw-specific-input-major);overflow:hidden}
  .content{padding:50px 30px}#draft{margin-top:8px}
  #popup{position:fixed;top:50px;left:20px;width:80px;height:40px;background:#fff}
  #beauticode-console-page{display:none}
  </style></head><body><div id="root" data-phase="active"><div id="transcript">Underlying transcript</div><div class="native_composerSeat"><div data-question-key="pending"><div id="card" class="native_card"><div class="content">Choose an answer<label><input id="answer" type="radio" name="answer" checked>Recommended</label><input id="draft" value="Keep my answer"><button id="toggle" type="button">Minimize</button></div><div id="popup">Overlay</div></div></div></div></div><script>${source}</script></body></html>`);
});
(async()=>{
  server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const browser=await chromium.launch({channel:process.env.DSH_TEST_BROWSER_CHANNEL||'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1000,height:800},deviceScaleFactor:2}),page=await context.newPage(),other=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));let checks=0;
  const check=(v,m)=>{assert(v,m);checks++;console.log('PASS '+m);};
  const sample=async()=>{const png=PNG.sync.read(await page.screenshot());const i=(300*2*png.width+110*2)*4;return [...png.data.subarray(i,i+4)];};
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForTimeout(300);
    // Fault injection: the blur contributes no pixels. The card still has to
    // hide sharp transcript glyphs and background colors underneath it.
    await page.addStyleTag({content:'*,*::before{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'});
    for(const tone of ['light','dark'])for(const phase of ['active','settling','idle'])for(const density of [.15,1.5]){
      await page.evaluate(({tone,phase,density})=>{document.documentElement.dataset.bcResolvedTone=tone;document.getElementById('root').dataset.phase=phase;document.documentElement.style.setProperty('--bgc-ui',density);}, {tone,phase,density});
      const expected=tone==='light'?[248,250,252,255]:[17,20,27,255];
      check(JSON.stringify(await sample())===JSON.stringify(expected),`${tone}/${phase}/${density} paints solid pixels without blur at 200% scale`);
    }
    for(let i=0;i<6;i++){
      await other.bringToFront();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
      await page.bringToFront();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      const result=await page.evaluate(()=>{const c=document.getElementById('card'),s=getComputedStyle(c),r=document.getElementById('popup').getBoundingClientRect();return {tag:c.dataset.bgcComposer,filter:s.backdropFilter,pseudo:getComputedStyle(c,'::before').content,rect:[r.x,r.y],answer:document.getElementById('answer').checked,draft:document.getElementById('draft').value};});
      check(!result.tag&&result.filter==='none'&&result.pseudo==='none'&&result.rect.join(',')==='20,50'&&result.answer&&result.draft==='Keep my answer'&&JSON.stringify(await sample())==='[17,20,27,255]',`focus cycle ${i} keeps solid surface, answers and overlay placement`);
    }
    await page.evaluate(()=>{document.getElementById('card').dataset.bgcComposer='1';});
    check(await page.locator('#card').evaluate(el=>getComputedStyle(el,'::before').content==='none'),'old frost marker cannot reintroduce a cached pseudo layer');
    await page.evaluate(()=>{const frame=document.querySelector('[data-question-key]');delete frame.dataset.questionKey;frame.dataset.planReviewKey='review';document.getElementById('card').classList.add('native_cardMinimized');});await page.waitForTimeout(250);
    check(JSON.stringify(await sample())==='[17,20,27,255]'&&await page.locator('[data-bgc-composer="1"]').count()===0,'plan review/minimized state retains the same solid surface');
    await page.evaluate(()=>{delete document.documentElement.dataset.bcActive;});
    check(await page.locator('#card').evaluate(el=>getComputedStyle(el).backgroundColor==='rgba(248, 250, 252, 0.36)'),'disabling wallpaper releases the host background');
    check(errors.length===0,'no browser errors');console.log('Verified '+checks+' checks');
  }finally{await context.close();await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
