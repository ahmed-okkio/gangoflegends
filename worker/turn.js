// Cloudflare Worker for Gang of Legends' networking fallbacks.
//  /room/<CODE>  WebSocket relay: when two players can't connect peer-to-peer (strict NAT, mainland China), the host
//                and that player both connect here and a Durable Object (one per lobby code) passes messages between them.
//  /             TURN credentials, once a Cloudflare TURN key is set (worker/secrets.json: TURN_KEY_ID, TURN_KEY_API_TOKEN).
// Deploy: npx wrangler deploy (from worker/).
// ponytail: anyone can open (or take over) a room; add auth if that or the free quota (100k requests/day) ever gets abused.

export class Room {
  constructor(state) { this.state = state; }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const url = new URL(req.url), isHost = url.searchParams.get('role') === 'host', id = url.searchParams.get('id') || crypto.randomUUID();
    if (isHost) for (const ws of this.state.getWebSockets('host')) ws.close(1000, 'replaced');
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [isHost ? 'host' : `c:${id}`]); // hibernates while idle, so open lobbies cost nothing
    if (!isHost && !this.host()) server.close(4004, 'No lobby found with that code.');
    return new Response(null, { status: 101, webSocket: client });
  }

  host() { return this.state.getWebSockets('host')[0]; }

  // host -> { to?: id, m?: msg, kick?: true } (no `to` = everyone); player -> msg, delivered to the host as { from, m }
  webSocketMessage(ws, data) {
    const [tag] = this.state.getTags(ws);
    if (tag !== 'host') { try { this.host()?.send(JSON.stringify({ from: tag.slice(2), m: JSON.parse(data) })); } catch {} return; } // re-encoded so a player can't forge `from`
    const { to, m, kick } = JSON.parse(data);
    const targets = to ? this.state.getWebSockets(`c:${to}`) : this.state.getWebSockets().filter(w => w !== ws);
    const out = JSON.stringify(m);
    for (const t of targets) kick ? t.close(1000, 'kicked') : t.send(out);
  }

  webSocketClose(ws) {
    const [tag] = this.state.getTags(ws);
    if (tag === 'host') { for (const w of this.state.getWebSockets()) if (w !== ws) w.close(1000, 'Host left.'); }
    else this.host()?.send(JSON.stringify({ from: tag.slice(2), leave: true }));
  }

  webSocketError(ws) { this.webSocketClose(ws); }
}

let cached = null; // TURN credentials { at, body }, per isolate: one set an hour is plenty

export default {
  async fetch(req, env) {
    const room = new URL(req.url).pathname.match(/^\/room\/([A-Z0-9]{3,5})$/);
    if (room) return env.ROOM.get(env.ROOM.idFromName(room[1])).fetch(req);
    if (!env.TURN_KEY_ID) return new Response('no TURN key', { status: 502, headers: { 'access-control-allow-origin': '*' } });
    if (!cached || Date.now() - cached.at > 3600e3) {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 6 * 3600 }), // outlives the cache plus a long session
      });
      if (!r.ok) return new Response(`turn key error ${r.status}`, { status: 502, headers: { 'access-control-allow-origin': '*' } });
      const { iceServers } = await r.json();
      // browsers block port 53, so those URLs only make ICE wait
      const list = [].concat(iceServers).map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)) }));
      cached = { at: Date.now(), body: JSON.stringify({ iceServers: list }) };
    }
    return new Response(cached.body, { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
  },
};
