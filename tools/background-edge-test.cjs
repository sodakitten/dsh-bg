// Fractional Windows scale factors / crop limits on isolated local pages.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{PNG}=require('pngjs');
const root=process.env.BG_SOURCE_ROOT||path.join(__dirname,'..');
const client=fs.readFileSync(path.join(root,'client.js'),'utf8'),atmosphere=fs.readFileSync(path.join(root,'atmosphere.js'),'utf8'),framing=fs.readFileSync(path.join(root,'framing.js'),'utf8');
const css=client.match(/style.textContent = `([\s\S]*?)`;/)[1].replaceAll('${CROSSFADE_MS}','180'),galleryCSS=atmosphere.match(/style.textContent = `([\s\S]*?)`;/)[1];
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1300" height="700"><path fill="#246c5b" d="M0 0h1300v700H0z"/></svg>');
const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/__beauticode/')){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,identity:'edge',themes:[],groups:[]}));return;}
  const gallery=req.url.includes('gallery');res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><html data-bc-active="true" data-bc-resolved-tone="light" data-bc-bg-blur="true" ${gallery?'data-bc-gallery="true"':''} style="--bc-bg-blur:9px"><head><style>html,body{margin:0;height:100%}${css}${galleryCSS}#beauticode-console-page{display:none}</style></head><body>${gallery?'<div id="beauticode-gallery-bg">':'<div id="beauticode-bg-stage"><div class="beauticode-media-slot" data-bc-role="current">'}<img src="${image}">${gallery?'</div>':'</div></div>'}<div id="beauticode-console-page"></div><script>localStorage.setItem('dsh-bg-crop/settings/v1',JSON.stringify({edgeFill:true}));localStorage.setItem('dsh-bg-crop/v1',JSON.stringify({edge:{zoom:1,tx:100,ty:100}}));</script><script>${framing}</script></body></html>`);
});
(async()=>{server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const browser=await chromium.launch({channel:process.env.DSH_TEST_BROWSER_CHANNEL||'msedge',headless:true});let checks=0;
try{for(const dpr of [1,1.25,1.5,2]){const page=await browser.newPage({viewport:{width:801,height:601},deviceScaleFactor:dpr});page.on('pageerror',e=>console.error('PAGE ERROR',e.message));for(const mode of ['image','gallery']){await page.goto(`http://127.0.0.1:${server.address().port}/${mode}`);await page.waitForFunction(()=>document.querySelector('img').style.transform);await page.waitForTimeout(200);
const png=PNG.sync.read(await page.screenshot());const points=[[0,png.height>>1],[png.width-1,png.height>>1],[png.width>>1,0],[png.width>>1,png.height-1]];
for(const [x,y]of points){const i=(y*png.width+x)*4;assert([36,108,91].every((v,k)=>Math.abs(png.data[i+k]-v)<5),`${mode} dpr=${dpr} edge (${x},${y}) got ${[...png.data.subarray(i,i+3)]}`);}
checks++;console.log('PASS '+mode+' all four edges, 801×601 at '+dpr+' scale and pan limit');}await page.close();}console.log(checks+' edge rendering checks passed');}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
