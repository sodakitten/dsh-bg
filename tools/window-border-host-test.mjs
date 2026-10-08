import { apply } from '../index.mjs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const root = await fs.mkdtemp(path.join(os.tmpdir(),'dsh-bg-border-test-'));
const token = crypto.randomBytes(32).toString('hex');
const tokenFile = path.join(root,'dsh-bridge.token'); await fs.writeFile(tokenFile,token);
const routes = new Map(); let cleanup, checks=0;
const check = (value,label) => { assert(value,label); checks++; console.log('PASS '+label); };
class Response extends EventEmitter {
  status=200; body=''; writeHead(code){this.status=code;return this;}
  write(data){this.body+=data;return true;} end(data=''){this.body+=data;return this;}
  destroy(){this.emit('close');}
}
apply({on:()=>()=>{},effect:fn=>{cleanup=fn();},webServer:{port:3080,register:route=>{
  routes.set(route.path,route.handler);return ()=>routes.delete(route.path);
}}},{tokenFile});
async function request(url,body,headers={}) {
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  req.url=url;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:3080',origin:'http://127.0.0.1:3080',...headers};
  const res=new Response(); await routes.get(url.split('?')[0])(req,res);return res;
}
const status=async()=>JSON.parse((await request('/__beauticode/status',undefined,{authorization:'Bearer '+token})).body);
const mode=(clientId,extra={})=>({clientId,kind:'mode',fish:false,muted:true,tone:'auto',resolvedTone:'light',themeSynced:true,blocked:false,...extra});
try {
  const web=await request('/__beauticode/events?clientId=webclient01');
  const desktop=await request('/__beauticode/events?clientId=desktop001');
  await request('/__beauticode/apply',{generation:1,media:'image',imageUrl:'http://127.0.0.1:3080/fixture?t=local'},{authorization:'Bearer '+token});
  await request('/__beauticode/ack',mode('webclient01',{desktopWindows:false,nativeBorderHidden:true}));
  check(!(await status()).nativeWindowBorder.requested,'browser receipt cannot enable native border');
  const bad=await request('/__beauticode/ack',mode('desktop001',{desktopWindows:'true',nativeBorderHidden:true}));
  check(bad.status===400,'invalid desktop identity rejected');
  const badOrigin=await request('/__beauticode/ack',mode('desktop001',{desktopWindows:true,nativeBorderHidden:true}),{origin:'https://example.invalid'});
  check(badOrigin.status===403,'foreign origin rejected');
  const orphan=await request('/__beauticode/ack',mode('missing001',{desktopWindows:true,nativeBorderHidden:true}));
  check(orphan.status===400,'receipt requires a live SSE client');
  await request('/__beauticode/ack',mode('desktop001',{desktopWindows:true,nativeBorderHidden:true}));
  check((await status()).nativeWindowBorder.requested,'desktop background requests hidden border');
  await request('/__beauticode/ack',mode('webclient01',{desktopWindows:false,nativeBorderHidden:false}));
  check((await status()).nativeWindowBorder.requested,'browser does not override desktop policy');
  // This test runs under Node, outside DSH ancestry: actual helper must refuse it.
  const deadline=Date.now()+8000;
  while(Date.now()<deadline && !(await status()).nativeWindowBorder.reason)await new Promise(r=>setTimeout(r,100));
  if(process.platform==='win32') check((await status()).nativeWindowBorder.reason==='not-desktop-host','helper refuses non-DSH process ancestry without changing any window');
  await request('/__beauticode/ack',mode('desktop001',{desktopWindows:true,nativeBorderHidden:false}));
  check(!(await status()).nativeWindowBorder.requested,'edge switch off restores policy');
  await request('/__beauticode/ack',mode('desktop001',{desktopWindows:true,nativeBorderHidden:true}));
  await request('/__beauticode/apply',{generation:2,media:'clear'},{authorization:'Bearer '+token});
  check(!(await status()).nativeWindowBorder.requested,'Host clear restores even before renderer acknowledgment');
  await request('/__beauticode/apply',{generation:3,media:'image',imageUrl:'http://127.0.0.1:3080/fixture?t=local'},{authorization:'Bearer '+token});
  desktop.destroy();check(!(await status()).nativeWindowBorder.requested,'last desktop disconnect removes native policy');
  web.destroy();console.log(checks+' real Host border contract checks passed');
} finally {
  cleanup?.();
  const resolved=path.resolve(root);
  if(path.dirname(resolved)!==path.resolve(os.tmpdir())||await fs.realpath(resolved)!==resolved)throw Error('Unsafe test cleanup');
  await fs.rm(resolved,{recursive:true,force:true});
}
