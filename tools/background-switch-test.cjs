// Real client scripts on isolated local pages; no live DSH or user data.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{PNG}=require('pngjs');
const root=process.env.BG_SOURCE_ROOT||path.join(__dirname,'..');
const client=fs.readFileSync(path.join(root,'client.js'),'utf8'),atmosphere=fs.readFileSync(path.join(root,'atmosphere.js'),'utf8');
const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><path fill="#246c5b" d="M0 0h600v400H0z"/></svg>');
let canvasRequests=0,imageRequests=0,videoBytes=null;const acks=[];
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/__beauticode/ack'){let raw='';for await(const c of req)raw+=c;acks.push(JSON.parse(raw));res.end('{}');return;}
  if(url.pathname==='/video.webm'){
    await new Promise(r=>setTimeout(r,350));res.setHeader('content-type','video/webm');res.setHeader('accept-ranges','bytes');
    const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
    if(range){const from=Number(range[1]),to=Math.min(Number(range[2]||videoBytes.length-1),videoBytes.length-1);res.statusCode=206;res.setHeader('content-range',`bytes ${from}-${to}/${videoBytes.length}`);res.end(videoBytes.subarray(from,to+1));}else res.end(videoBytes);return;
  }
  if(url.pathname.endsWith('.svg')){imageRequests++;if(url.pathname==='/slow.svg')await new Promise(r=>setTimeout(r,700));res.setHeader('cache-control','no-store');res.setHeader('content-type','image/svg+xml');res.end(svg);return;}
  if(url.pathname==='/canvas'){canvasRequests++;await new Promise(r=>setTimeout(r,700));if(url.searchParams.has('fail')){res.statusCode=404;res.end();return;}res.setHeader('content-type','image/svg+xml');res.end(svg);return;}
  if(url.pathname.startsWith('/__beauticode/')){res.end('{}');return;}
  res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><html><head><style>html,body{margin:0;height:100%}#root{height:100%;background:transparent!important}</style></head><body><div id="root"><div class="test_sidebarCol"></div><div class="test_centerCol"></div></div><script>window.__BEAUTICODE_CANVAS_URL='/canvas${url.searchParams.has('fail')?'?fail':''}';window.__beauticodeTransport={headers:()=>({}),events:(url,fn)=>window.sendBG=p=>fn({data:JSON.stringify(p)})};</script><script>${atmosphere}</script><script>${client}</script></body></html>`);
});
(async()=>{
  server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const browser=await chromium.launch({channel:process.env.DSH_TEST_BROWSER_CHANNEL||'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:600,height:400}});let checks=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const check=(v,m)=>{assert(v,m);checks++;console.log('PASS '+m);};
  const base=`http://127.0.0.1:${server.address().port}`;
  const apply=(generation,imageUrl,preset)=>page.evaluate(p=>sendBG(p),{type:'apply',generation,media:'image',imageUrl,atmosphere:preset?{preset}:null});
  const ready=g=>page.waitForFunction(g=>document.documentElement.dataset.bcGeneration===String(g)&&!document.documentElement.hasAttribute('data-bc-pending-generation'),g);
  const pixel=async()=>{const p=PNG.sync.read(await page.screenshot());const i=(200*p.width+300)*4;return [...p.data.subarray(i,i+3)];};
  try{
    await page.goto(base);await apply(1,'/green.svg');await ready(1);const before=await pixel();
    await apply(2,'/slow.svg');await page.waitForTimeout(80);
    check((await pixel()).every((v,i)=>Math.abs(v-before[i])<3),'loading a candidate preserves the previously painted wallpaper');
    await ready(2);check(acks.some(a=>a.kind==='render'&&a.generation===2&&a.ok),'decoded candidate commits and acknowledges');
    await apply(3,'/missing');await page.waitForTimeout(250);
    await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-bc-pending-generation'));
    check((await pixel()).every((v,i)=>Math.abs(v-before[i])<3),'failed image preserves the committed wallpaper');
    check(acks.some(a=>a.generation===3&&a.ok===false),'failed image reports a failure instead of blank success');
    await page.evaluate(()=>{BeauticodeAtmosphere.setWindowMode('on');BeauticodeAtmosphere.setWindowMode('on');});
    await page.waitForTimeout(80);
    check(await page.evaluate(()=>!document.documentElement.hasAttribute('data-bc-gallery')),'gallery loading does not hide the old background');
    await page.evaluate(()=>BeauticodeAtmosphere.setWindowMode('closed'));
    check(await page.locator('#beauticode-gallery-bg').count()===0,'closing during load immediately removes pending gallery layers');
    await page.waitForTimeout(750);
    check(await page.locator('#beauticode-gallery-bg').count()===0,'a late image completion cannot resurrect a closed gallery');
    const beforeGalleryRequests=canvasRequests;
    const beforeImageRequests=imageRequests;
    await apply(4,'/green.svg','gallery');await ready(4);
    await page.waitForFunction(()=>document.documentElement.dataset.bcGallery==='true');
    check(canvasRequests===beforeGalleryRequests&&imageRequests===beforeImageRequests+1&&await page.locator('#beauticode-gallery-bg img').count()===0,'gallery handover reuses the decoded stage without a second request even with no-store');
    const layer=await page.locator('#beauticode-gallery-bg').elementHandle();const requests=canvasRequests;
    await page.evaluate(()=>{BeauticodeAtmosphere.setWindowMode('on');BeauticodeAtmosphere.setWindowMode('on');});
    check(await layer.evaluate(e=>e.isConnected),'repeated gallery enable reuses the same animation layer');
    check(canvasRequests===requests,'repeated gallery enable issues no extra image request');
    check(await page.locator('#beauticode-gallery-bg').count()===1,'only one gallery layer exists');
    await apply(5,'/green.svg');await ready(5);
    check(await page.locator('#beauticode-gallery-bg').count()===0&&!await page.evaluate(()=>document.documentElement.hasAttribute('data-bc-gallery')),'ordinary background retires gallery and restores the image');
    await apply(7,'/slow.svg');await page.waitForTimeout(40);await apply(8,'/green.svg');await ready(8);await page.waitForTimeout(750);
    check(await page.evaluate(()=>document.documentElement.dataset.bcGeneration==='8'&&document.querySelectorAll('.beauticode-media-slot').length===1),'rapid switches discard stale candidates without replacing the latest image');
    videoBytes=Buffer.from(await page.evaluate(async()=>{
      const c=document.createElement('canvas');c.width=600;c.height=400;const ctx=c.getContext('2d'),stream=c.captureStream(20),parts=[];
      const rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});rec.ondataavailable=e=>parts.push(e.data);const stopped=new Promise(r=>rec.onstop=r);rec.start();
      for(let i=0;i<20;i++){ctx.fillStyle='#246c5b';ctx.fillRect(0,0,600,400);ctx.fillStyle='#ff6666';ctx.fillRect(i*4,20,20,20);await new Promise(r=>setTimeout(r,50));}
      rec.stop();await stopped;stream.getTracks().forEach(t=>t.stop());return [...new Uint8Array(await new Blob(parts).arrayBuffer())];
    }));
    await page.evaluate(()=>sendBG({type:'apply',generation:9,media:'video',imageUrl:'/slow.svg',videoUrl:'/video.webm'}));await page.waitForTimeout(80);
    check((await pixel()).every((v,i)=>Math.abs(v-before[i])<3),'cold video warms behind the committed image without a black or gray flash');
    await ready(9);await page.waitForFunction(()=>document.querySelector('[data-bc-role="current"]').dataset.bcVideoReady==='true',null,{timeout:10000});
    check(await page.evaluate(()=>!document.querySelector('video').paused),'poster-first video still presents frames and continues playing');
    await apply(10,'/green.svg');await ready(10);
    check(await page.locator('video').count()===0,'switching away releases the old video decoder');
    await page.goto(base+'/?fail');await apply(6,'/green.svg');await ready(6);
    await page.evaluate(()=>BeauticodeAtmosphere.setWindowMode('on'));
    await page.waitForTimeout(800);
    check(await page.locator('#beauticode-gallery-bg').count()===0&&!await page.evaluate(()=>document.documentElement.hasAttribute('data-bc-gallery')),'gallery load failure keeps the ordinary wallpaper instead of a gray layer');
    check(errors.length===0,'no uncaught client errors');
    console.log(checks+' background switching checks passed');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
