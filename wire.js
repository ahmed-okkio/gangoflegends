// Snapshots on the wire (game.js): every champ's entry goes packed into one binary block (sent as a base64 string `pb`:
// PeerJS's channels and the relay both carry JSON). Each field at the precision sim.js already rounds it to: positions,
// velocities, stun, KO and yaw as 0.01 steps in 16 bits, cooldowns and daze in a byte; rotations as the smallest three
// components of each quaternion at 15 bits (the largest is rebuilt; q and -q are the same turn), finer than the 0.001
// they're rounded to. 8 players fighting: ~1.38KB -> ~1.17KB a snapshot (~810 bytes of block, ~1.08KB as base64), which
// 60Hz snapshots need: twice as many of them (players in China often have under 1 Mbit/s coming in). Hooks, glue and the
// rest stay JSON.
// ponytail: base64 costs a third on top; a binary data channel ('raw' serialization) if the bandwidth matters more
import { PARTS } from './beast.js';

const Q0 = 9, NQ = PARTS.length, X = Q0 + NQ * 4, R = Math.SQRT1_2, M = 32767; // all but the largest component lie within ±1/√2
const ALIVE = 1 + 1 + 2 + 2 + 6 + NQ * 6 + 1 + 6 + 4 + 6; // bytes for a champ on the map (see the layout below); 1 for one off it
const c16 = v => Math.max(-32768, Math.min(32767, Math.round(v * 100))), u16 = v => Math.max(0, Math.min(65535, Math.round(v * 100)));
const u8 = v => Math.max(0, Math.min(255, v));

// [slot | alive<<7] [daze] [flags | hooked<<15 :16] [cd0] [cd1] [hips xyz :16 each] [12 rotations :48 each] [hay %]
// [hips velocity xyz :16 each] [ack :32] [stun :16] [KO :16] [yaw :16]
export function packSnap(s) {
  const b = new Uint8Array(s.p.reduce((n, e) => n + (e[1] ? ALIVE : 1), 0)), v = new DataView(b.buffer);
  let o = 0;
  for (const e of s.p) {
    v.setUint8(o++, e[0] | (e[1] ? 128 : 0));
    if (!e[1]) continue;
    v.setUint8(o++, u8(e[2])); v.setUint16(o, e[3] | e[X + 6] << 15); o += 2; v.setUint8(o++, u8(e[4])); v.setUint8(o++, u8(e[5]));
    for (const k of [6, 7, 8]) { v.setInt16(o, c16(e[k])); o += 2; }
    for (let i = 0; i < NQ; i++, o += 6) {
      const q = e.slice(Q0 + i * 4, Q0 + i * 4 + 4);
      let big = 0;
      for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[big])) big = k;
      const sign = q[big] < 0 ? -1 : 1, [x, y, z] = q.filter((_, k) => k !== big).map(c => Math.min(M, Math.max(0, Math.round((c * sign / R + 1) / 2 * M))));
      v.setUint16(o, x | (big & 1) << 15); v.setUint16(o + 2, y | (big >> 1) << 15); v.setUint16(o + 4, z);
    }
    v.setUint8(o++, u8(e[X]));
    for (const k of [1, 2, 3]) { v.setInt16(o, c16(e[X + k])); o += 2; }
    v.setUint32(o, e[X + 4]); o += 4;
    v.setUint16(o, u16(e[X + 5])); v.setUint16(o + 2, u16(e[X + 7])); v.setInt16(o + 4, c16(e[X + 8])); o += 6;
  }
  let str = '';
  for (let i = 0; i < b.length; i += 4096) str += String.fromCharCode(...b.subarray(i, i + 4096));
  const { p, ...rest } = s;
  return { ...rest, pb: btoa(str) };
}

// back to the layout sim.js snapshot() makes
export function unpackSnap(s) {
  const v = new DataView(Uint8Array.from(atob(s.pb), c => c.charCodeAt(0)).buffer), p = [];
  for (let o = 0; o < v.byteLength;) {
    const h = v.getUint8(o++);
    if (!(h & 128)) { p.push([h, 0]); continue; }
    const f = v.getUint16(o + 1), e = [h & 127, 1, v.getUint8(o), f & 0x7fff, v.getUint8(o + 3), v.getUint8(o + 4)];
    o += 5;
    for (let k = 0; k < 3; k++, o += 2) e.push(v.getInt16(o) / 100);
    for (let i = 0; i < NQ; i++, o += 6) {
      const a = v.getUint16(o), b = v.getUint16(o + 2), q = [a & M, b & M, v.getUint16(o + 4)].map(c => (c / M * 2 - 1) * R);
      q.splice((a >> 15) | (b >> 15) << 1, 0, Math.sqrt(Math.max(0, 1 - q.reduce((t, c) => t + c * c, 0))));
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
