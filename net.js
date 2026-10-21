// Peer-to-peer transport over WebRTC (PeerJS, loaded as window.Peer).
// The host's peer id is derived from a short lobby code; PeerJS's public server is only used to introduce peers.
const PREFIX = 'gangoflegends-v1-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const makeCode = () => [...Array(3)].map(() => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
export const cleanCode = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);

function emitter() {
  const fns = {};
  return {
    on(type, fn) { (fns[type] ||= []).push(fn); },
    emit(type, ...args) { for (const fn of fns[type] || []) fn(...args); },
  };
}
const timeout = (ms, msg) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));

// Connection log for debugging players who can't connect (menu: Network test / Copy network log)
export const netLog = [];
export function log(...a) {
  netLog.push(`${new Date().toISOString().slice(11, 23)} ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`);
  if (netLog.length > 500) netLog.shift();
}
// STUN finds each player's public address; several, since some are blocked in places (Google's in mainland China).
const STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
];
// TURN would relay WebRTC itself when two players can't reach each other directly. TURN_URL hands out short-lived
// credentials (worker/turn.js, once Cloudflare TURN is paid for); empty = STUN only, the WebSocket relay covers those players.
const TURN_URL = '';
// WebSocket relay (worker/turn.js Room): when WebRTC can't connect (strict NAT, mainland China) the joining player and
// the host both talk to a Cloudflare Durable Object that passes messages along. Slower than direct, but always gets through.
// ponytail: free Workers plan (~100k requests/day, 20 relayed messages = 1 request); move to paid if lots of people relay.
const RELAY = 'wss://gangoflegends-turn.ahmed-okkio.workers.dev/room/';
let ice = null, relayOn = false;
// "Use relay" in the menu: skip trying a direct connection (joining falls back to the relay on its own anyway)
export function useRelay(on) { relayOn = on; }
function iceServers() {
  return ice ??= !TURN_URL ? Promise.resolve(STUN) : fetch(TURN_URL, { signal: AbortSignal.timeout(5000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)))
    .then(j => { log('relay credentials ok'); return [...STUN, ...[].concat(j.iceServers ?? j).filter(s => [].concat(s.urls).some(u => u.startsWith('turn')))]; })
    .catch(e => { log('relay credentials failed:', e.message); return STUN; }); // STUN only for this session
}
const newPeer = async id => {
  const opts = { debug: 2, logFunction: (_lvl, ...a) => log('peerjs', ...a.map(String)), config: { iceServers: await iceServers() } };
  return id ? new window.Peer(id, opts) : new window.Peer(opts);
};
// ICE progress of one WebRTC connection: which candidate types got gathered and whether it connected
function watch(conn) {
  const pc = conn.peerConnection;
  if (!pc) return log('no peerConnection on', conn.peer);
  // public (srflx/relay) addresses are logged so a log shows the NAT: a new port per STUN server means a strict NAT
  pc.addEventListener('icecandidate', e => e.candidate && log('candidate', e.candidate.type, e.candidate.protocol, e.candidate.type === 'host' ? '' : `${e.candidate.address}:${e.candidate.port}`, e.url || ''));
  pc.addEventListener('icecandidateerror', e => log('candidate error', e.url, e.errorCode, e.errorText));
  pc.addEventListener('iceconnectionstatechange', () => log('ice', conn.peer, pc.iceConnectionState));
  pc.addEventListener('connectionstatechange', () => log('connection', conn.peer, pc.connectionState));
}

// Network test: is the lobby server reachable, and which STUN/TURN servers answer?
export async function selfTest() {
  log('--- network test', navigator.userAgent);
  const t0 = performance.now(), peer = await newPeer();
  const signalling = await Promise.race([
    new Promise(res => { peer.on('open', () => res(`ok in ${Math.round(performance.now() - t0)}ms`)); peer.on('error', e => res(`error ${e.type} ${e.message}`)); }),
    new Promise(res => setTimeout(() => res('timed out after 10s'), 10000)),
  ]);
  peer.destroy();
  log('lobby server (0.peerjs.com):', signalling);
  const found = {};
  // every STUN/TURN URL on its own, so the log shows which ports and transports get through (UDP 3478, TCP 80, TLS 443)
  for (const server of (await iceServers()).flatMap(s => [].concat(s.urls).map(urls => ({ ...s, urls })))) {
    const pc = new RTCPeerConnection({ iceServers: [server] }), want = server.urls.startsWith('turn') ? 'relay' : 'srflx';
    pc.createDataChannel('t');
    const got = await new Promise(res => {
      setTimeout(() => res(false), 6000);
      pc.addEventListener('icecandidate', e => { if (e.candidate?.type === want) { log(server.urls, 'gave', `${e.candidate.address}:${e.candidate.port}`); res(true); } });
      pc.addEventListener('icecandidateerror', e => log('candidate error', e.url, e.errorCode, e.errorText));
      pc.createOffer().then(o => pc.setLocalDescription(o));
    });
    pc.close();
    found[server.urls] = got;
    log(server.urls, got ? `answers (${want})` : 'NO ANSWER');
  }
  // NAT type: one connection asking every STUN server. If the same local port shows up as different public ports,
  // the router maps per destination (symmetric NAT) and direct connections mostly fail: only a relay gets through.
  const nat = await new Promise(res => {
    const pc = new RTCPeerConnection({ iceServers: STUN }), seen = {};
    pc.createDataChannel('t');
    pc.addEventListener('icecandidate', e => {
      const c = e.candidate;
      if (c?.type === 'srflx') { (seen[`${c.protocol}:${c.relatedPort}`] ??= new Set()).add(c.port); log('nat probe', c.relatedPort, '->', `${c.address}:${c.port}`); }
    });
    pc.createOffer().then(o => pc.setLocalDescription(o));
    setTimeout(() => { pc.close(); const sets = Object.values(seen); res(!sets.length ? 'unknown' : sets.some(p => p.size > 1) ? 'strict (symmetric)' : 'easy'); }, 4000);
  });
  log('NAT:', nat);
  const relay = await new Promise(res => {
    const ws = new WebSocket(`${RELAY}${makeCode()}?role=host`), t1 = performance.now();
    const done = r => { clearTimeout(t); ws.onclose = null; ws.close(); res(r); }, t = setTimeout(() => done('timed out after 8s'), 8000);
    ws.onopen = () => done(`ok in ${Math.round(performance.now() - t1)}ms`);
    ws.onclose = e => done(`blocked (${e.code})`);
  });
  log('relay:', relay);
  const ok = kind => Object.entries(found).some(([u, yes]) => yes && u.startsWith(kind));
  return `Lobby server: ${signalling}. NAT: ${nat}. STUN: ${ok('stun') ? 'ok' : 'blocked'}. Relay: ${relay}.`;
}

export async function host() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode();
    const peer = await newPeer(PREFIX + code);
    log('host: opening lobby', code);
    try {
      await Promise.race([
        new Promise((res, rej) => { peer.on('open', res); peer.on('error', rej); }),
        timeout(10000, 'Could not reach the matchmaking server. Check your internet connection.'),
      ]);
    } catch (e) {
      peer.destroy();
      if (e.type === 'unavailable-id') continue;
      log('host: failed', e.type || '', e.message);
      throw new Error(e.message || 'Could not start hosting.');
    }
    log('host: lobby open');
    // players are WebRTC connections or relay stand-ins, both { open, send, close }
    const ev = emitter(), conns = new Map();
    const data = (id, conn, msg) => {
      if (msg?.t === 'hello' && !conns.has(id)) { conns.set(id, conn); ev.emit('join', id, String(msg.name || 'Player').slice(0, 14), String(msg.v || 'old')); }
      else if (conns.has(id)) ev.emit('msg', id, msg);
    };
    const gone = id => { log('host: lost', id); if (conns.delete(id)) ev.emit('leave', id); };
    peer.on('connection', conn => {
      log('host: incoming connection', conn.peer);
      watch(conn);
      conn.on('data', msg => data(conn.peer, conn, msg));
      conn.on('open', () => log('host: channel open', conn.peer));
      conn.on('close', () => gone(conn.peer)); conn.on('error', () => gone(conn.peer));
    });
    // ponytail: no reconnect; if the relay socket drops, relayed players lose the host like a dropped WebRTC link
    const ws = new WebSocket(`${RELAY}${code}?role=host`), put = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
    ws.onopen = () => log('host: relay open');
    ws.onclose = e => log('host: relay closed', e.code, e.reason);
    ws.onmessage = e => {
      const { from, m, leave } = JSON.parse(e.data);
      if (leave) return gone(from);
      data(from, conns.get(from) ?? { open: true, send: msg => put({ to: from, m: msg }), close: () => put({ to: from, kick: true }) }, m);
    };
    // the lobby code stays reachable even if the signalling socket drops mid-game
    peer.on('disconnected', () => { log('host: lobby server disconnected, reconnecting'); if (!peer.destroyed) peer.reconnect(); });
    peer.on('error', e => log('host: error', e.type || '', e.message));
    return {
      mode: 'host', code, myId: 'host', on: ev.on,
      send(id, msg) { const c = conns.get(id); if (c?.open) c.send(msg); },
      broadcast(msg) { for (const c of conns.values()) if (c.open) c.send(msg); },
      kick(id) { conns.get(id)?.close(); conns.delete(id); },
      close() { peer.destroy(); ws.close(); },
    };
  }
  throw new Error('Could not get a free lobby code, try again.');
}

export async function join(code, name, v) {
  if (!relayOn) try { return await joinDirect(code, name, v); } catch (e) { if (e.noLobby) throw e; log('join: direct failed, trying the relay'); }
  return joinRelay(code, name, v);
}

function joinRelay(code, name, v) {
  const myId = `r-${Math.random().toString(36).slice(2, 10)}`, ev = emitter(), ws = new WebSocket(`${RELAY}${code}?id=${myId}`);
  log('join: relay to', code, 'as', myId);
  return new Promise((res, rej) => {
    let ready = false;
    const fail = msg => { clearTimeout(t); ws.onclose = null; ws.close(); rej(new Error(msg)); };
    const t = setTimeout(() => fail('Could not connect to that lobby, even through the relay.'), 15000);
    ws.onopen = () => { log('join: relay open'); ws.send(JSON.stringify({ t: 'hello', name, v })); };
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (ready) return ev.emit('msg', msg);
      // the host always answers hello (lobby or deny); hand that answer over once the caller has its handlers attached
      ready = true; clearTimeout(t); log('join: host answered via relay');
      res({ mode: 'client', myId, on: ev.on, send(m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); }, close() { ws.onclose = null; ws.close(); } });
      setTimeout(() => ev.emit('msg', msg));
    };
    ws.onclose = e => { log('join: relay closed', e.code, e.reason); if (ready) ev.emit('close'); else fail(e.reason || 'Could not reach the relay server.'); };
  });
}

async function joinDirect(code, name, v) {
  const peer = await newPeer();
  const ev = emitter();
  log('join: connecting to', code);
  try {
    const conn = await Promise.race([
      new Promise((res, rej) => {
        peer.on('error', e => rej(Object.assign(new Error(e.type === 'peer-unavailable' ? `No lobby found with code ${code}.` : e.message), { noLobby: e.type === 'peer-unavailable' })));
        peer.on('open', id => {
          log('join: lobby server ok, my id', id);
          const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
          watch(c);
          c.on('open', () => { log('join: channel open'); res(c); });
          c.on('error', e => rej(e));
        });
      }),
      timeout(25000, 'Could not connect to that lobby. The host may be behind a strict firewall.'), // relayed (TURN over TCP) setups are slow
    ]);
    conn.on('data', msg => ev.emit('msg', msg));
    conn.on('close', () => { log('join: connection closed'); ev.emit('close'); });
    conn.send({ t: 'hello', name, v });
    return { mode: 'client', myId: peer.id, on: ev.on, send(msg) { if (conn.open) conn.send(msg); }, close() { peer.destroy(); } };
  } catch (e) {
    log('join: failed', e.type || '', e.message);
    peer.destroy();
    throw e;
  }
}
