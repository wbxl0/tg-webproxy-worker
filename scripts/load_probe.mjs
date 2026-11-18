#!/usr/bin/env node
// Multi-lane probe: reproduce "image download drops the proxy".
// Opens N lanes at once (half media, half normal), runs req_pq on each,
// and reports whether existing lanes get closed when new ones open.
// usage: HOST=tg... SECRET=... N=8 node load_probe.mjs
import crypto from 'node:crypto';

const HOST = process.env.HOST || 'tg.example.com';
const SECRET = (process.env.SECRET || '').trim().toLowerCase();
const N = Number(process.env.N || 8);
const KEYBUF = Buffer.from(SECRET.slice(-32), 'hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const bridgeOf = (host) => crypto.createHmac('sha256', KEYBUF)
  .update(`tdesktop-web-proxy-bridge-v1\n${host}`).digest('base64url');
const frame = (ty, sid, p) => {
  const q = p ? Buffer.from(p) : Buffer.alloc(0);
  const o = Buffer.alloc(8 + q.length);
  o[0] = ty; o[1] = (sid >> 16) & 255; o[2] = (sid >> 8) & 255; o[3] = sid & 255;
  o.writeUInt32BE(q.length, 4); q.copy(o, 8); return o;
};
const t0 = Date.now();
const log = (s) => console.log(`| +${String(Date.now() - t0).padStart(5)}ms ${s}`);

const page = await (await fetch(`https://${HOST}/?bridge=${bridgeOf(HOST)}`)).text();
const boot = page.match(/"([A-Za-z0-9_-]{43})"/)?.[1];
if (!boot) { console.log('no bootstrap'); process.exit(1); }
const sr = await fetch(`https://${HOST}/api/v1/session`, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + boot, 'Content-Type': 'application/octet-stream' },
  body: Buffer.from([0x10, 0, 0, 0, 0, 0, 0, 1, 1]),
});
const sess = sr.headers.get('x-session-token');
log(`session ${sr.status} token=${!!sess}`);
if (!sess) process.exit(1);

function lane(sid, media, dc) {
  return new Promise((resolve) => {
    const st = { sid, media, dc, ok: false, closed: null, opened: false };
    const ws = new WebSocket(`wss://${HOST}/api/v1/ws`, [`tproxy-lane-v1.${sess}.${sid}`]);
    ws.binaryType = 'arraybuffer';
    const nonce = crypto.randomBytes(16);
    const P = crypto.randomBytes(64);
    P.writeUInt32LE(0xefefefef, 56); P.writeInt16LE(dc * (media ? -1 : 1), 60);
    const mat = P.subarray(8, 56);
    const up = crypto.createCipheriv('aes-256-ctr', sha(Buffer.concat([mat.subarray(0, 32), KEYBUF])), mat.subarray(32, 48));
    const matR = Buffer.from(mat).reverse();
    const dn = crypto.createDecipheriv('aes-256-ctr', sha(Buffer.concat([matR.subarray(0, 32), KEYBUF])), matR.subarray(32, 48));
    const C = Buffer.from(up.update(P)); P.copy(C, 8, 8, 56);
    ws.addEventListener('open', () => {
      st.opened = true;
      ws.send(frame(1, sid));
      setTimeout(() => ws.send(frame(2, sid, C)), 150);
      setTimeout(() => {
        const req = Buffer.concat([Buffer.from([0xf1, 0x8e, 0x7e, 0xbe]), nonce]);
        const msgId = Buffer.alloc(8); msgId.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)) << 32n);
        const len = Buffer.alloc(4); len.writeUInt32LE(req.length);
        const payload = Buffer.concat([Buffer.alloc(8), msgId, len, req]);
        ws.send(frame(2, sid, Buffer.from(up.update(Buffer.concat([Buffer.from([payload.length / 4]), payload])))));
      }, 700);
    });
    ws.addEventListener('message', (e) => {
      const b = Buffer.from(e.data);
      if (b[0] === 2 && dn.update(b.subarray(8)).includes(nonce)) st.ok = true;
      if (b[0] === 3) { st.closed = 'server-END'; ws.close(); resolve(st); }
    });
    ws.addEventListener('close', (e) => { st.closed ??= `ws-close-${e.code}`; resolve(st); });
    ws.addEventListener('error', () => { st.closed ??= 'ws-error'; resolve(st); });
    setTimeout(() => { try { ws.close(); } catch {} resolve(st); }, 15000);
  });
}

// open lanes in waves so we can see if later opens kill earlier ones
const jobs = [];
for (let i = 0; i < N; i++) {
  const sid = i + 1;
  const media = i % 2 === 1;
  const dc = media ? 4 : 2;
  jobs.push(lane(sid, media, dc));
  await new Promise(r => setTimeout(r, 250)); // stagger like real client
}
const res = await Promise.all(jobs);
for (const r of res) log(`lane sid=${r.sid} media=${r.media} dc=${r.dc} opened=${r.opened} pq=${r.ok ? 'OK' : 'FAIL'} end=${r.closed ?? '-'}`);
log(`RESULT ${res.filter(r => r.ok).length}/${N} lanes reached Telegram`);
await fetch(`https://${HOST}/api/v1/session`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + sess } }).catch(() => {});
process.exit(0);
