'use strict';
/*
 * Bank El Haz — tiny self-hosted relay.
 *
 * One process does three jobs, so the game needs no third-party services:
 *   1. serves the static app (index.html, /vendor, /assets)
 *   2. relays authoritative game state between clients in the same room
 *   3. tracks presence (who is connected) and relays emotes + server time
 *
 * Run:  npm install  &&  npm start      (PORT env overrides 3000)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/* ----------------------------- static files ----------------------------- */
const server = http.createServer((req, res) => {
  try {
    const rawPath = (req.url || '/').split('?')[0];
    // HTTP relay fallback (used automatically if the WebSocket can't connect)
    if (handleRelayHttp(req, res, rawPath)) return;
    // Discord avatars, proxied same-origin so the activity CSP always allows them
    if (rawPath.startsWith('/cdn/')) {
      const p = rawPath.slice(4); // strip "/cdn", keep the leading slash
      const ok = /^\/avatars\/\d+\/[A-Za-z0-9_-]+\.(png|gif|jpg|jpeg|webp)$/.test(p) ||
                 /^\/embed\/avatars\/\d+\.png$/.test(p);
      if (!ok) { res.writeHead(400); res.end('bad request'); return; }
      fetch('https://cdn.discordapp.com' + p, { signal: AbortSignal.timeout(8000) })
        .then(r => {
          if (!r.ok) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, {
            'Content-Type': r.headers.get('content-type') || 'image/png',
            'Cache-Control': 'public, max-age=86400',
          });
          r.arrayBuffer().then(b => res.end(Buffer.from(b))).catch(() => res.end());
        })
        .catch(() => { res.writeHead(502); res.end('bad gateway'); });
      return;
    }
    let urlPath = decodeURIComponent(rawPath);
    if (urlPath === '/') urlPath = '/index.html';
    // block path traversal, then resolve inside ROOT
    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (e) {
    res.writeHead(500); res.end('error');
  }
});

/* ------------------------- game state relay (WS + HTTP) ------------------ */
/** @type {Map<string, any>} */
const rooms = new Map();

function roomOf(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { clients: new Set(), state: null, presence: new Set(), pollSeen: new Map(), emotes: [], emoteSeq: 0 };
    rooms.set(id, r);
  }
  return r;
}
function send(ws, obj) {
  if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
}
function broadcast(room, obj, except) {
  for (const c of room.clients) if (c !== except) send(c, obj);
}
function presencePayload(room) {
  const users = {};
  for (const uid of room.presence) users[uid] = true;
  // HTTP pollers are presence too (they refresh every second)
  for (const [uid, ts] of room.pollSeen) if (Date.now() - ts < 15000) users[uid] = true;
  return { t: 'pres', users };
}
function applySet(room, v, state) {
  const next = (room.state ? room.state.v : 0) + 1;
  if (v !== next) return { ok: false, cur: room.state ? room.state.v : 0 };
  room.state = state;
  room.state.v = v;
  broadcast(room, { t: 'state', state: room.state });
  return { ok: true, cur: v };
}
function pushEmote(room, e, uid, except) {
  room.emoteSeq = (room.emoteSeq || 0) + 1;
  room.emotes.push({ id: room.emoteSeq, e, uid });
  if (room.emotes.length > 50) room.emotes = room.emotes.slice(-50);
  broadcast(room, { t: 'emote', e }, except);
}

/* HTTP fallback — works through any URL mapping, no WebSocket upgrade needed.
   The client polls GET /state and posts actions to /set and /emote. */
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let b = '', done = false;
  req.on('data', d => { b += d; if (b.length > 2e6) { done = true; req.destroy(); } });
  req.on('end', () => { if (!done) cb(b); });
  req.on('error', () => { if (!done) cb(''); });
}
function handleRelayHttp(req, res, rawPath) {
  if (rawPath !== '/state' && rawPath !== '/set' && rawPath !== '/emote' && rawPath !== '/health') return false;
  if (rawPath === '/health') {
    sendJSON(res, 200, { ok: true, rooms: rooms.size, ts: Date.now() });
    return true;
  }
  let q; try { q = new URL(req.url, 'http://x').searchParams; } catch (e) { return true; }
  const roomId = q.get('room') || 'lobby';
  const uid = (q.get('uid') || 'anon').slice(0, 120);

  if (rawPath === '/state' && req.method === 'GET') {
    const room = roomOf(roomId);
    room.pollSeen.set(uid, Date.now());
    const cv = Number(q.get('cv') || 0);
    const emotes = room.emotes.filter(e => e.id > cv).slice(-30);
    sendJSON(res, 200, {
      t: 'state', state: room.state, v: room.state ? room.state.v : 0,
      cv: room.emoteSeq, emotes, users: presencePayload(room).users, ts: Date.now(),
    });
    return true;
  }
  if (rawPath === '/set' && req.method === 'POST') {
    readBody(req, body => {
      let m; try { m = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { ok: false }); }
      if (!m || !m.state || typeof m.state !== 'object' || Array.isArray(m.state) || !Number.isFinite(m.v)) {
        return sendJSON(res, 400, { ok: false });
      }
      const room = roomOf(m.room || roomId);
      const r = applySet(room, m.v, m.state);
      sendJSON(res, 200, { ok: r.ok, v: r.ok ? m.v : undefined, cur: r.cur, state: room.state });
    });
    return true;
  }
  if (rawPath === '/emote' && req.method === 'POST') {
    readBody(req, body => {
      let m; try { m = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { ok: false }); }
      if (!m || !Number.isFinite(m.e)) return sendJSON(res, 400, { ok: false });
      pushEmote(roomOf(m.room || roomId), m.e, uid);
      sendJSON(res, 200, { ok: true });
    });
    return true;
  }
  sendJSON(res, 405, { ok: false });
  return true;
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  let roomId = 'lobby';
  let uid = '';
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    roomId = q.get('room') || 'lobby';
    uid = q.get('uid') || '';
  } catch (e) {}
  if (!uid) uid = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const room = roomOf(roomId);
  ws.roomId = roomId; ws.uid = uid; ws.alive = true;
  room.clients.add(ws); room.presence.add(uid); room.pollSeen.delete(uid);
  // a reconnect/refresh with the same id (Discord user id) replaces the old socket
  for (const c of room.clients) if (c !== ws && c.uid === uid) { try { c.close(); } catch (e) {} }

  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', () => {});
  ws.on('close', () => {
    room.clients.delete(ws);
    let stillHere = false;
    for (const c of room.clients) if (c.uid === uid) { stillHere = true; break; }
    if (!stillHere) room.presence.delete(uid);
    broadcast(room, presencePayload(room));
    if (room.clients.size === 0 && room.pollSeen.size === 0) rooms.delete(roomId);
  });
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'set') {
      if (!m.state || typeof m.state !== 'object' || Array.isArray(m.state) || !Number.isFinite(m.v)) {
        send(ws, { t: 'reject', v: m.v, cur: room.state ? room.state.v : 0 });
        return;
      }
      const r = applySet(room, m.v, m.state);
      if (r.ok) send(ws, { t: 'ack', v: m.v });
      else send(ws, { t: 'reject', v: m.v, cur: r.cur });
    } else if (m.t === 'emote') {
      if (Number.isFinite(m.e)) pushEmote(room, m.e, ws.uid, ws);
    } else if (m.t === 'ping') {
      send(ws, { t: 'pong', ts: m.ts });
    }
  });

  // initial sync: current state + presence + server time (presence goes to everyone,
  // so players already here see the newcomer immediately)
  send(ws, { t: 'init', state: room.state, ts: Date.now() });
  broadcast(room, presencePayload(room));
});

// drop dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; try { ws.ping(); } catch (e) {}
  }
}, 30000);

// expire HTTP pollers and drop empty rooms
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    for (const [uid, ts] of room.pollSeen) if (now - ts > 15000) room.pollSeen.delete(uid);
    if (room.clients.size === 0 && room.pollSeen.size === 0) { rooms.delete(id); continue; }
    broadcast(room, presencePayload(room));
  }
}, 5000);

server.listen(PORT, () => console.log('Bank El Haz relay listening on http://localhost:' + PORT));