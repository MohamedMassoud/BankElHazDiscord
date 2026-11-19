/*
 * Cloudflare Worker + Durable Object relay for Bank El Haz.
 *
 * One Durable Object per room owns the authoritative game state and the
 * WebSocket connections. Clients speak the simple JSON protocol below.
 *
 *   WS /ws?room=<room>&uid=<id>
 *     server -> client: init / state / pres / ack / reject / emote / pong
 *     client -> server: set / emote / ping
 *
 *   GET /health   -> { ok: true }
 *   GET /cdn/...  -> Discord avatar proxy
 */

function validState(s) {
  return !!s && typeof s === 'object' && !Array.isArray(s) &&
    Array.isArray(s.P) &&
    !!s.O && typeof s.O === 'object' && !Array.isArray(s.O) &&
    !!s.V && typeof s.V === 'object' && !Array.isArray(s.V) &&
    Array.isArray(s.log);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/health') return Response.json({ ok: true, ts: Date.now() });
      if (path.startsWith('/cdn/')) return proxyAvatar(path);

      if (path === '/ws') {
        const room = (url.searchParams.get('room') || 'lobby').slice(0, 80) || 'lobby';
        const id = env.ROOMS.idFromName(room);
        return env.ROOMS.get(id).fetch(request);
      }

      const asset = await env.ASSETS.fetch(request);
      if (path === '/' || path === '/index.html') {
        const h = new Headers(asset.headers);
        h.set('Cache-Control', 'no-store');
        return new Response(asset.body, { status: asset.status, headers: h });
      }
      return asset;
    } catch (e) {
      return new Response('relay error: ' + ((e && e.message) || e), { status: 500 });
    }
  },
};

async function proxyAvatar(path) {
  const p = path.slice(4); // "/avatars/..." or "/embed/..."
  const ok =
    /^\/avatars\/\d+\/[A-Za-z0-9_-]+\.(png|gif|jpg|jpeg|webp)$/.test(p) ||
    /^\/embed\/avatars\/\d+\.png$/.test(p);
  if (!ok) return new Response('bad request', { status: 400 });

  const upstream = await fetch('https://cdn.discordapp.com' + p);
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'image/png');
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(upstream.body, { status: upstream.status, headers });
}

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    this.lastPresenceKey = '';

    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get('state');
      this.state = validState(s) ? s : null;
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const uid = (url.searchParams.get('uid') || 'anon').slice(0, 120);

    // a refresh with the same Discord id replaces the old socket
    for (const ws of this.ctx.getWebSockets()) {
      let old = null;
      try { old = ws.deserializeAttachment(); } catch (e) {}
      if (old === uid) { try { ws.close(1000, 'replaced'); } catch (e) {} }
    }

    server.serializeAttachment(uid);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ t: 'init', state: this.state, ts: Date.now() }));
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async applySet(v, state) {
    const cur = this.state ? this.state.v : 0;
    if (!validState(state) || !Number.isFinite(v)) return { ok: false, cur };
    if (v !== cur + 1) return { ok: false, cur };
    this.state = state;
    this.state.v = v;
    await this.ctx.storage.put('state', this.state);
    this.broadcast({ t: 'state', state: this.state });
    return { ok: true, cur: v };
  }

  broadcast(obj, except) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(msg); } catch (e) {}
    }
  }

  presenceUsers() {
    const users = {};
    for (const ws of this.ctx.getWebSockets()) {
      let uid = null;
      try { uid = ws.deserializeAttachment(); } catch (e) {}
      users[uid || 'anon'] = true;
    }
    return users;
  }

  broadcastPresence() {
    const users = this.presenceUsers();
    const key = JSON.stringify(users);
    if (key === this.lastPresenceKey) return;
    this.lastPresenceKey = key;
    this.broadcast({ t: 'pres', users });
  }

  webSocketMessage(ws, message) {
    let m;
    try {
      m = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'set') {
      if (!validState(m.state) || !Number.isFinite(m.v)) {
        ws.send(JSON.stringify({ t: 'reject', v: m.v, cur: this.state ? this.state.v : 0 }));
        return;
      }
      this.applySet(m.v, m.state).then(r => {
        try {
          ws.send(JSON.stringify(r.ok ? { t: 'ack', v: m.v } : { t: 'reject', v: m.v, cur: r.cur }));
        } catch (e) {}
      });
    } else if (m.t === 'emote') {
      if (m.e !== undefined && m.e !== null) this.broadcast({ t: 'emote', e: m.e }, ws);
    } else if (m.t === 'ping') {
      try { ws.send(JSON.stringify({ t: 'pong', ts: m.ts })); } catch (e) {}
    }
  }

  webSocketClose() {
    this.broadcastPresence();
  }

  webSocketError() {
    this.broadcastPresence();
  }
}