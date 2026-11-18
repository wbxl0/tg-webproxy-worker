#!/usr/bin/env node
// Per-DC lane matrix: opens one lane per (dc, media) pair and runs req_pq.
import crypto from 'node:crypto';
const HOST = process.env.HOST || 'tg.example.com';
const SECRET = (process.env.SECRET || '').trim().toLowerCase();
const KEYBUF = Buffer.from(SECRET.slice(-32), 'hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const bridgeOf = (h) => crypto.createHmac('sha256', KEYBUF).update(`tdesktop-web-proxy-bridge-v1\n${h}`).digest('base64url');
const frame = (ty, sid, p) => { const q = p ? Buffer.from(p) : Buffer.alloc(0); const o = Buffer.alloc(8 + q.length); o[0]=ty; o[1]=(sid>>16)&255; o[2]=(sid>>8)&255; o[3]=sid&255; o.writeUInt32BE(q.length,4); q.copy(o,8); return o; };

const page = await (await fetch(`https://${HOST}/?bridge=${bridgeOf(HOST)}`)).text();
const boot = page.match(/"([A-Za-z0-9_-]{43})"/)?.[1];
const sr = await fetch(`https://${HOST}/api/v1/session`, { method:'POST', headers:{Authorization:'Bearer '+boot,'Content-Type':'application/octet-stream'}, body: Buffer.from([0x10,0,0,0,0,0,0,1,1]) });
const sess = sr.headers.get('x-session-token');

function lane(sid, dc, media) {
  return new Promise((resolve) => {
    const t = Date.now(); const nonce = crypto.randomBytes(16);
    const P = crypto.randomBytes(64); P.writeUInt32LE(0xefefefef,56); P.writeInt16LE(dc*(media?-1:1),60);
    const mat=P.subarray(8,56);
    const up=crypto.createCipheriv('aes-256-ctr',sha(Buffer.concat([mat.subarray(0,32),KEYBUF])),mat.subarray(32,48));
    const mr=Buffer.from(mat).reverse();
    const dn=crypto.createDecipheriv('aes-256-ctr',sha(Buffer.concat([mr.subarray(0,32),KEYBUF])),mr.subarray(32,48));
    const C=Buffer.from(up.update(P)); P.copy(C,8,8,56);
    const ws=new WebSocket(`wss://${HOST}/api/v1/ws`,[`tproxy-lane-v1.${sess}.${sid}`]); ws.binaryType='arraybuffer';
    let ok=false, closed=null;
    ws.addEventListener('open',()=>{ ws.send(frame(1,sid)); setTimeout(()=>ws.send(frame(2,sid,C)),120);
      setTimeout(()=>{ const req=Buffer.concat([Buffer.from([0xf1,0x8e,0x7e,0xbe]),nonce]);
        const mid=Buffer.alloc(8); mid.writeBigUInt64LE(BigInt(Math.floor(Date.now()/1000))<<32n);
        const len=Buffer.alloc(4); len.writeUInt32LE(req.length);
        const payload=Buffer.concat([Buffer.alloc(8),mid,len,req]);
        ws.send(frame(2,sid,Buffer.from(up.update(Buffer.concat([Buffer.from([payload.length/4]),payload]))))); },600); });
    ws.addEventListener('message',(e)=>{ const b=Buffer.from(e.data); if(b[0]===2&&dn.update(b.subarray(8)).includes(nonce)) ok=true; });
    ws.addEventListener('close',(e)=>{ closed??='ws-close-'+e.code; resolve({sid,dc,media,ok,closed,ms:Date.now()-t}); });
    ws.addEventListener('error',()=>{ closed??='ws-error'; });
    setTimeout(()=>{ try{ws.close();}catch{} resolve({sid,dc,media,ok,closed:closed??'timeout',ms:Date.now()-t}); },8000);
  });
}
const jobs=[]; let sid=1;
for (let dc=1; dc<=5; dc++) for (const media of [false,true]) jobs.push(lane(sid++, dc, media));
const res=await Promise.all(jobs);
for (const r of res) console.log(`dc=${r.dc} ${r.media?'MEDIA':'plain'} ${r.ok?'PASS':'FAIL'} ${String(r.ms).padStart(5)}ms ${r.closed??''}`);
await fetch(`https://${HOST}/api/v1/session`,{method:'DELETE',headers:{Authorization:'Bearer '+sess}}).catch(()=>{});
