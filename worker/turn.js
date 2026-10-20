// Cloudflare Worker: hands the game short-lived TURN relay credentials so the long-term TURN key never ships in the app.
// Deploy: cd worker && npx wrangler deploy && npx wrangler secret bulk secrets.json (TURN_KEY_ID, TURN_KEY_API_TOKEN).
// ponytail: anyone with the URL can fetch credentials; add auth if relay bandwidth (1000 GB/month free) ever gets abused.
let cached = null; // { at, body }, per isolate: one set of credentials an hour is plenty

export default {
  async fetch(req, env) {
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
