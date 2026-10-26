// Snapshots on the wire (game.js): every champ's entry goes packed into one binary block `pb` (a Uint8Array: raw bytes
// on the fast channel, base64 wherever it goes as JSON, see frame() and b64). Each field at the precision sim.js already rounds it to: positions,
// velocities, stun, KO and yaw as 0.01 steps in 16 bits, cooldowns and daze in a byte; rotations as the smallest three
// components of each quaternion at 10 bits (the largest is rebuilt; q and -q are the same turn): ~0.1 degree, nothing a
// ragdoll shows. 8 players fighting: ~1.38KB -> ~0.85KB a snapshot on the fast channel (~620 bytes of block; more where it goes
// as base64: the relay), which 60Hz snapshots need: twice as many of them, at about the upload 30Hz took (players in China
// often have under 1 Mbit/s coming in). Hooks, glue and the rest stay JSON.
import { PARTS } from './beast.js';

const Q0 = 9, NQ = PARTS.length, X = Q0 + NQ * 4, R = Math.SQRT1_2, M = 1023; // all but the largest component lie within ±1/√2
const ALIVE = 1 + 1 + 2 + 2 + 6 + NQ * 4 + 1 + 6 + 4 + 6; // bytes for a champ on the map (see the layout below); 1 for one off it
const c16 = v => Math.max(-32768, Math.min(32767, Math.round(v * 100))), u16 = v => Math.max(0, Math.min(65535, Math.round(v * 100)));
const u8 = v => Math.max(0, Math.min(255, v));

// [slot | alive<<7] [daze] [flags | hooked<<15 :16] [cd0] [cd1] [hips xyz :16 each] [12 rotations :32 each: largest's index :2, the other three :10 each] [hay %]
// [hips velocity xyz :16 each] [ack :32] [stun :16] [KO :16] [yaw :16]
export function packSnap(s) {
  const b = new Uint8Array(s.p.reduce((n, e) => n + (e[1] ? ALIVE : 1), 0)), v = new DataView(b.buffer);
  let o = 0;
  for (const e of s.p) {
    v.setUint8(o++, e[0] | (e[1] ? 128 : 0));
    if (!e[1]) continue;
    v.setUint8(o++, u8(e[2])); v.setUint16(o, e[3] | e[X + 6] << 15); o += 2; v.setUint8(o++, u8(e[4])); v.setUint8(o++, u8(e[5]));
    for (const k of [6, 7, 8]) { v.setInt16(o, c16(e[k])); o += 2; }
    for (let i = 0; i < NQ; i++, o += 4) {
      const q = e.slice(Q0 + i * 4, Q0 + i * 4 + 4);
      let big = 0;
      for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[big])) big = k;
      const sign = q[big] < 0 ? -1 : 1, [x, y, z] = q.filter((_, k) => k !== big).map(c => Math.min(M, Math.max(0, Math.round((c * sign / R + 1) / 2 * M))));
      v.setUint32(o, (big << 30 | x << 20 | y << 10 | z) >>> 0);
    }
    v.setUint8(o++, u8(e[X]));
    for (const k of [1, 2, 3]) { v.setInt16(o, c16(e[X + k])); o += 2; }
    v.setUint32(o, e[X + 4]); o += 4;
    v.setUint16(o, u16(e[X + 5])); v.setUint16(o + 2, u16(e[X + 7])); v.setInt16(o + 4, c16(e[X + 8])); o += 6;
  }
  const { p, ...rest } = s;
  return { ...rest, pb: b };
}

// JSON.stringify replacer for the JSON paths (the reliable channel, the relay, practice's simulated link): a block as base64
export const b64 = (k, v) => {
  if (!(v instanceof Uint8Array)) return v;
  let str = '';
  for (let i = 0; i < v.length; i += 4096) str += String.fromCharCode(...v.subarray(i, i + 4096));
  return btoa(str);
};
// the fast channel (PeerJS 'raw'): a message holding a block goes as one ArrayBuffer, [JSON length :32][JSON][blocks], each
// block in the JSON as { $b: [offset, length] }; anything else as a JSON string
export function frame(msg) {
  const blobs = [];
  let n = 0;
  const json = JSON.stringify(msg, (k, v) => v instanceof Uint8Array ? (blobs.push(v), { $b: [(n += v.length) - v.length, v.length] }) : v);
  if (!blobs.length) return json;
  const head = new TextEncoder().encode(json), out = new Uint8Array(4 + head.length + n);
  new DataView(out.buffer).setUint32(0, head.length); out.set(head, 4);
  let o = 4 + head.length;
  for (const b of blobs) { out.set(b, o); o += b.length; }
  return out.buffer;
}
export function unframe(data) {
  if (typeof data === 'string') return JSON.parse(data);
  const len = new DataView(data).getUint32(0), at = 4 + len;
  return JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, len)), (k, x) => x?.$b ? new Uint8Array(data, at + x.$b[0], x.$b[1]) : x);
}

// back to the layout sim.js snapshot() makes
export function unpackSnap(s) {
  const b = typeof s.pb === 'string' ? Uint8Array.from(atob(s.pb), c => c.charCodeAt(0)) : s.pb, v = new DataView(b.buffer, b.byteOffset, b.byteLength), p = [];
  for (let o = 0; o < v.byteLength;) {
    const h = v.getUint8(o++);
    if (!(h & 128)) { p.push([h, 0]); continue; }
    const f = v.getUint16(o + 1), e = [h & 127, 1, v.getUint8(o), f & 0x7fff, v.getUint8(o + 3), v.getUint8(o + 4)];
    o += 5;
    for (let k = 0; k < 3; k++, o += 2) e.push(v.getInt16(o) / 100);
    for (let i = 0; i < NQ; i++, o += 4) {
      const w = v.getUint32(o), q = [w >>> 20 & M, w >>> 10 & M, w & M].map(c => (c / M * 2 - 1) * R);
      q.splice(w >>> 30, 0, Math.sqrt(Math.max(0, 1 - q.reduce((t, c) => t + c * c, 0))));
      e.push(...q);
    }
    e.push(v.getUint8(o++));
    for (let k = 0; k < 3; k++, o += 2) e.push(v.getInt16(o) / 100);
    e.push(v.getUint32(o), v.getUint16(o + 4) / 100, f >> 15, v.getUint16(o + 6) / 100, v.getInt16(o + 8) / 100);
    o += 10;
    p.push(e);
  }
  delete s.pb;
  s.p = p;
  return s;
}
