// Snapshots on the wire (game.js): each champ's part rotations go as one base64 string instead of 48 numbers: the smallest
// three components of each quaternion at 15 bits (the largest is rebuilt; q and -q are the same turn), finer than the
// 0.001 they're rounded to. 8 players' snapshot ~2.9KB -> ~1.4KB: fewer packets to lose one of, and half the bandwidth
// (players in China often have under 1 Mbit/s coming in)
import { PARTS } from './beast.js';

const Q0 = 9, NQ = PARTS.length, R = Math.SQRT1_2, M = 32767; // all but the largest component lie within ±1/√2

export function packSnap(s) {
  return { ...s, p: s.p.map(e => {
    if (!e[1]) return e;
    const b = new Uint8Array(NQ * 6), v = new DataView(b.buffer);
    for (let i = 0; i < NQ; i++) {
      const q = e.slice(Q0 + i * 4, Q0 + i * 4 + 4);
      let big = 0;
      for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[big])) big = k;
      const sign = q[big] < 0 ? -1 : 1, [x, y, z] = q.filter((_, k) => k !== big).map(c => Math.min(M, Math.max(0, Math.round((c * sign / R + 1) / 2 * M))));
      v.setUint16(i * 6, x | (big & 1) << 15); v.setUint16(i * 6 + 2, y | (big >> 1) << 15); v.setUint16(i * 6 + 4, z);
    }
    return [...e.slice(0, Q0), btoa(String.fromCharCode(...b)), ...e.slice(Q0 + NQ * 4)];
  }) };
}

// back to the layout sim.js snapshot() makes, in place
export function unpackSnap(s) {
  for (const e of s.p) {
    if (!e[1] || typeof e[Q0] !== 'string') continue;
    const v = new DataView(Uint8Array.from(atob(e[Q0]), c => c.charCodeAt(0)).buffer), qs = [];
    for (let i = 0; i < NQ; i++) {
      const a = v.getUint16(i * 6), b = v.getUint16(i * 6 + 2), q = [a & M, b & M, v.getUint16(i * 6 + 4)].map(c => (c / M * 2 - 1) * R);
      q.splice((a >> 15) | (b >> 15) << 1, 0, Math.sqrt(Math.max(0, 1 - q.reduce((t, c) => t + c * c, 0))));
      qs.push(...q);
    }
    e.splice(Q0, 1, ...qs);
  }
  return s;
}
