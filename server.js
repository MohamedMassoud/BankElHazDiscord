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
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
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
  try { roomId = new URL(req.url, 'http://x').searchParams.get('room') || 'lobby'; } catch (e) {}
  const uid = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const room = roomOf(roomId);
  ws.roomId = roomId; ws.uid = uid; ws.alive = true;
  room.clients.add(ws); room.presence.add(uid);

  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', () => {});
  ws.on('close', () => {
    room.clients.delete(ws); room.presence.delete(uid);
    broadcast(room, presencePayload(room));
    if (room.clients.size === 0) rooms.delete(roomId);
  });
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'set') {
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
      broadcast(room, { t: 'emote', e: m.e }, ws);
    } else if (m.t === 'ping') {
      send(ws, { t: 'pong', ts: m.ts });
    }
  });

  // initial sync: current state + presence + server time
  send(ws, { t: 'init', state: room.state, ts: Date.now() });
  send(ws, presencePayload(room));
});

// drop dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; try { ws.ping(); } catch (e) {}
  }
}, 30000);

server.listen(PORT, () => console.log('Bank El Haz relay listening on http://localhost:' + PORT));