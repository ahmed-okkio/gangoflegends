// Peer-to-peer transport over WebRTC (PeerJS, loaded as window.Peer).
// The host's peer id is derived from a short lobby code; PeerJS's public server is only used to introduce peers.
const PREFIX = 'gangoflegends-v1-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const makeCode = () => [...Array(5)].map(() => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
export const cleanCode = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

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
// TURN relays traffic when two players can't reach each other directly (strict NATs, carrier NAT). Cloudflare's relay,
// with short-lived credentials from our worker (worker/turn.js). PeerJS's old free relay no longer exists.
// Until the worker has a TURN key (worker/secrets.json) it answers with an error and players get STUN only.
const TURN_URL = 'https://gangoflegends-turn.ahmed-okkio.workers.dev';
let ice = null;
function iceServers() {
  return ice ??= fetch(TURN_URL, { signal: AbortSignal.timeout(5000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)))
    .then(({ iceServers }) => { log('relay credentials ok'); return [...STUN, ...iceServers.filter(s => [].concat(s.urls).some(u => u.startsWith('turn')))]; })
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
  pc.addEventListener('icecandidate', e => e.candidate && log('candidate', e.candidate.type, e.candidate.protocol, e.url || ''));
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
      pc.addEventListener('icecandidate', e => { if (e.candidate?.type === want) res(true); });
      pc.addEventListener('icecandidateerror', e => log('candidate error', e.url, e.errorCode, e.errorText));
      pc.createOffer().then(o => pc.setLocalDescription(o));
    });
    pc.close();
    found[server.urls] = got;
    log(server.urls, got ? `answers (${want})` : 'NO ANSWER');
  }
  const ok = kind => Object.entries(found).some(([u, yes]) => yes && u.startsWith(kind));
  return `Lobby server: ${signalling}. STUN: ${ok('stun') ? 'ok' : 'blocked'}. TURN relay: ${!Object.keys(found).some(u => u.startsWith('turn')) ? 'not set up' : ok('turn') ? 'ok' : 'blocked'}.`;
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
    const ev = emitter(), conns = new Map();
    peer.on('connection', conn => {
      log('host: incoming connection', conn.peer);
      watch(conn);
      conn.on('data', msg => {
        if (msg.t === 'hello' && !conns.has(conn.peer)) { conns.set(conn.peer, conn); ev.emit('join', conn.peer, String(msg.name || 'Player').slice(0, 14), String(msg.v || 'old')); }
        else if (conns.has(conn.peer)) ev.emit('msg', conn.peer, msg);
      });
      conn.on('open', () => log('host: channel open', conn.peer));
      const gone = () => { log('host: lost', conn.peer); if (conns.delete(conn.peer)) ev.emit('leave', conn.peer); };
      conn.on('close', gone); conn.on('error', gone);
    });
    // the lobby code stays reachable even if the signalling socket drops mid-game
    peer.on('disconnected', () => { log('host: lobby server disconnected, reconnecting'); if (!peer.destroyed) peer.reconnect(); });
    peer.on('error', e => log('host: error', e.type || '', e.message));
    return {
      mode: 'host', code, myId: 'host', on: ev.on,
      send(id, msg) { const c = conns.get(id); if (c?.open) c.send(msg); },
      broadcast(msg) { for (const c of conns.values()) if (c.open) c.send(msg); },
      kick(id) { conns.get(id)?.close(); conns.delete(id); },
      close() { peer.destroy(); },
    };
  }
  throw new Error('Could not get a free lobby code, try again.');
}

export async function join(code, name, v) {
  const peer = await newPeer();
  const ev = emitter();
  log('join: connecting to', code);
  try {
    const conn = await Promise.race([
      new Promise((res, rej) => {
        peer.on('error', e => rej(new Error(e.type === 'peer-unavailable' ? `No lobby found with code ${code}.` : e.message)));
        peer.on('open', id => {
          log('join: lobby server ok, my id', id);
          const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
          watch(c);
          c.on('open', () => { log('join: channel open'); res(c); });
          c.on('error', e => rej(e));
        });
      }),
      timeout(12000, 'Could not connect to that lobby. The host may be behind a strict firewall.'),
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
