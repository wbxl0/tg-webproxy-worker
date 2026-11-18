#!/usr/bin/env node
// Telegram WEB proxy self-check — no Telegram client needed.
// usage:
//   HOST=tg.example.com SECRET=<32hex> node tgproxy_probe.mjs
//   HOST=... SECRET=... ROUNDS=3 node tgproxy_probe.mjs      # 3 rounds, watch jitter
//   HOST=127.0.0.1:8787 PLAIN=1 SECRET=... node tgproxy_probe.mjs   # local wrangler dev
//   BRIDGE_HOST=tg.example.com   # dev with routes: bridge follows the route hostname
// Requires Node 22+ (built-in fetch / WebSocket).
import crypto from 'node:crypto';

const HOST = process.env.HOST || process.argv[2];
const SECRET = (process.env.SECRET || process.argv[3] || '').trim().toLowerCase();
const ROUNDS = Number(process.env.ROUNDS || 1);
// local wrangler dev: req.url has no port; with routes the toml hostname is used -> BRIDGE_HOST
const BRIDGE_HOST = process.env.BRIDGE_HOST || HOST.replace(/:\d+$/, '');
const HTTPS = process.env.PLAIN === '1' ? 'http' : 'https';
const WSS = HTTPS === 'https' ? 'wss' : 'ws';
const T0 = Date.now();
const ms = (t) => `${Date.now() - t}ms`;

function die(msg) { console.log(`│ ❌ ${msg}`); process.exit(1); }

if (!HOST || !SECRET) die('missing args: HOST=<domain> SECRET=<32hex>');
if (!/^(?:[0-9a-f]{32}|(?:dd|ee|ef)[0-9a-f]{32})$/.test(SECRET)) die(`bad SECRET (${SECRET.length} chars, need 32 hex or dd/ee/ef+32)`);

const KEYBUF = Buffer.from(SECRET.slice(-32), 'hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest();

const bridgeOf = (host) => crypto.createHmac('sha256', KEYBUF)
  .update(`tdesktop-web-proxy-bridge-v1\n${host}`).digest('base64url');

async function round(i) {
  const step = (n, t) => console.log(`│ ${n.padEnd(10)} ${ms(t).padStart(6)}`);

  let t = Date.now();
  const h = await fetch(`${HTTPS}://${HOST}/health`).catch(() => null);
  if (!h || !h.ok) die('/health unreachable (dns / worker down)');
  const hb = await h.text();
  step('/health', t);
  if (!/"ok"\s*:\s*true/.test(hb)) die(`/health unexpected: ${hb.slice(0, 80)}`);

  t = Date.now();
  const page = await (await fetch(`${HTTPS}://${HOST}/?bridge=${bridgeOf(BRIDGE_HOST)}`)).text();
  const boot = page.match(/"([A-Za-z0-9_-]{43})"/)?.[1];
  step('bridge', t);
  if (!boot) die(`bridge page wrong (${page.length}B, secret/host mismatch?)`);

  t = Date.now();
  const sr = await fetch(`${HTTPS}://${HOST}/api/v1/session`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + boot, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from([0x10, 0, 0, 0, 0, 0, 0, 1, 1]),
  });
  const sess = sr.headers.get('x-session-token');
  step('session', t);
  if (!sess) die(`no session token (HTTP ${sr.status})`);

  const SID = i;
  const frame = (ty, sid, p) => {
    const q = p ? Buffer.from(p) : Buffer.alloc(0);
    const o = Buffer.alloc(8 + q.length);
    o[0] = ty; o[1] = (sid >> 16) & 255; o[2] = (sid >> 8) & 255; o[3] = sid & 255;
    o.writeUInt32BE(q.length, 4); q.copy(o, 8); return o;
  };

  const tLane = Date.now();
  const ws = new WebSocket(`${WSS}://${HOST}/api/v1/ws`, [`tproxy-lane-v1.${sess}.${SID}`]);
  ws.binaryType = 'arraybuffer';
  const nonce = crypto.randomBytes(16);
  let up = null, dn = null, ok = false;
  let tReq = Date.now();

  const done = new Promise((res) => {
    ws.addEventListener('open', () => {
      step('lane WS', tLane);
      ws.send(frame(1, SID));
      const P = crypto.randomBytes(64);
      P.writeUInt32LE(0xefefefef, 56); P.writeInt16LE(3, 60);
      const mat = P.subarray(8, 56);
      up = crypto.createCipheriv('aes-256-ctr', sha(Buffer.concat([mat.subarray(0, 32), KEYBUF])), mat.subarray(32, 48));
      const matR = Buffer.from(mat).reverse();
      dn = crypto.createDecipheriv('aes-256-ctr', sha(Buffer.concat([matR.subarray(0, 32), KEYBUF])), matR.subarray(32, 48));
      const C = Buffer.from(up.update(P)); P.copy(C, 8, 8, 56);
      setTimeout(() => ws.send(frame(2, SID, C)), 150);
      setTimeout(() => {
        const req = Buffer.concat([Buffer.from([0xf1, 0x8e, 0x7e, 0xbe]), nonce]);
        const msgId = Buffer.alloc(8); msgId.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)) << 32n);
        const len = Buffer.alloc(4); len.writeUInt32LE(req.length);
        const payload = Buffer.concat([Buffer.alloc(8), msgId, len, req]);
        ws.send(frame(2, SID, Buffer.from(up.update(Buffer.concat([Buffer.from([payload.length / 4]), payload])))));
        tReq = Date.now();
      }, 700);
    });
    ws.addEventListener('message', (e) => {
      const b = Buffer.from(e.data);
      if (b[0] !== 2) return;
      if (dn.update(b.subarray(8)).includes(nonce)) { ok = true; step('TG RTT', tReq); res(); }
    });
    ws.addEventListener('error', () => res());
    setTimeout(res, 12000);
  });

  await done;
  try { ws.close(); } catch {}
  await fetch(`${HTTPS}://${HOST}/api/v1/session`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + sess } }).catch(() => {});
  return ok;
}

console.log(`│ target ${HOST}`);
let pass = 0;
for (let i = 1; i <= ROUNDS; i++) {
  if (ROUNDS > 1) console.log(`│ --- round ${i}/${ROUNDS} ---`);
  const ok = await round(i);
  if (ok) pass++;
  else { console.log('│ ❌ lane opened but Telegram did not echo the nonce (worker -> kws blocked)'); break; }
}
console.log(`│ RESULT ${pass === ROUNDS ? 'PASS' : 'FAIL'}  ${pass}/${ROUNDS} rounds, ${ms(T0)} total`);
process.exit(pass === ROUNDS ? 0 : 1);
