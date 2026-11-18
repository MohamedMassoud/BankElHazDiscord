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

/* ------------------------- game state relay (WS) ------------------------ */
/** @type {Map<string, {clients:Set<import('ws')>, state:any, presence:Set<string>}>} */
const rooms = new Map();

function roomOf(id) {
  let r = rooms.get(id);
  if (!r) { r = { clients: new Set(), state: null, presence: new Set() }; rooms.set(id, r); }
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
  return { t: 'pres', users };
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
  room.clients.add(ws); room.presence.add(uid);
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
    if (room.clients.size === 0) rooms.delete(roomId);
  });
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'set') {
      // validate: a malformed payload must never take the relay down
      if (!m.state || typeof m.state !== 'object' || Array.isArray(m.state) || !Number.isFinite(m.v)) {
        send(ws, { t: 'reject', v: m.v, cur: room.state ? room.state.v : 0 });
        return;
      }
      const next = (room.state ? room.state.v : 0) + 1;
      // optimistic concurrency: accept only the expected next version
      if (m.v === next) {
        room.state = m.state; room.state.v = m.v;
        broadcast(room, { t: 'state', state: room.state });
        send(ws, { t: 'ack', v: m.v });
      } else {
        send(ws, { t: 'reject', v: m.v, cur: room.state ? room.state.v : 0 });
      }
    } else if (m.t === 'emote') {
      if (Number.isFinite(m.e)) broadcast(room, { t: 'emote', e: m.e }, ws);
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

server.listen(PORT, () => console.log('Bank El Haz relay listening on http://localhost:' + PORT));