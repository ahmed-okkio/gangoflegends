// Stages imported from the player's own Gang Beasts install (tools/import_gb.py -> gbcache/<stage>/).
// prepareMap() swaps the imported layout into MAPS before a match; without an import the procedural map stays.
import { MAPS } from './maps.js';

const isNode = typeof window === 'undefined';

// XHR, not fetch: the game runs from file:// and Chromium's fetch refuses that scheme
export const xhr = (path, type) => new Promise((res, rej) => {
  const r = new XMLHttpRequest();
  r.open('GET', path); r.responseType = type;
  r.onload = () => (r.status === 0 || r.status === 200) && r.response ? res(r.response) : rej(new Error(`${path}: ${r.status}`));
  r.onerror = () => rej(new Error(path));
  r.send();
});
async function readJson(path) {
  if (isNode) { const fs = await import('node:fs/promises'); return JSON.parse(await fs.readFile(new URL(path, import.meta.url), 'utf8')); }
  return xhr(path, 'json');
}

async function readBin(path) {
  if (isNode) { const fs = await import('node:fs/promises'); const b = await fs.readFile(new URL(path, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }
  return xhr(path, 'arraybuffer');
}

// a mesh collider as world-space triangles for Rapier. .bin layout (tools/import_gb.py): positions, [normals], [uv0], [uv1], indices
function meshTris(m, buf, M) {
  const p = new Float32Array(buf, 0, m.verts * 3), v = new Float32Array(m.verts * 3);
  for (let i = 0; i < v.length; i += 3) for (let r = 0; r < 3; r++) v[i + r] = M[r][0] * p[i] + M[r][1] * p[i + 1] + M[r][2] * p[i + 2] + M[r][3];
  const off = m.verts * 4 * (3 + (m.normals ? 3 : 0) + (m.uv0 ? 2 : 0) + (m.uv1 ? 2 : 0));
  return { v, i: new Uint32Array(buf, off, m.indices) };
}

const loaded = {};
export async function prepareMap(id, { meshes = !isNode } = {}) {
  const map = MAPS[id];
  if (!map?.gb || loaded[id]) return MAPS[id];
  const base = `./gbcache/${map.gb}/`;
  let scene;
  try { scene = await readJson(base + 'scene.json'); } catch { return map; } // not imported: keep the procedural fallback
  const bins = {}, tris = scene.trimeshes ?? [];
  const keys = new Set([...meshes ? Object.keys(scene.meshes) : [], ...tris.map(t => t.mesh)]);
  await Promise.all([...keys].map(async k => { bins[k] = await readBin(base + k + '.bin'); }));
  // Incinerator's football-only colliders under and beside its conveyors would hold feet still between the rollers.
  // (The stair ramps for the ball stay: they help ragdolls up the steps.)
  const solid = c => !/Ball Only Collider|Convayor Collision Ball Proxy/.test(c.path);
  loaded[id] = MAPS[id] = {
    ...map,
    boxes: scene.colliders.filter(solid).map(c => ({ p: c.p, q: c.q, s: c.h })),
    caps: (scene.capsules ?? []).filter(solid),
    tris: tris.map(t => meshTris(scene.meshes[t.mesh], bins[t.mesh], t.matrix)),
    rollers: [],
    kill: scene.kill.map(killBox),
    train: scene.train ?? null, // Subway's car: its renderers and solid box (maps.js trains)
    // stages that place players from code (Ring) have no markers; maps.js has those
    spawns: scene.spawns.length >= 4 ? scene.spawns : map.spawns,
    imported: { scene, bins, base },
  };
  return MAPS[id];
}

// a stage's kill volume (oriented box) as the world-space { min, max } box sim.js tests the chest against. Gang Beasts
// kills on any body part touching one, so thin floor triggers (Ring's) get some height to reach a beast lying on them.
function killBox({ p, h, q: [x, y, z, w] = [0, 0, 0, 1] }) {
  const R = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
  const e = R.map(r => r.reduce((s, v, j) => s + Math.abs(v) * h[j], 0));
  if (e[1] < 0.3) e[1] = 0.5;
  return { min: p.map((v, i) => v - e[i]), max: p.map((v, i) => v + e[i]) };
}

// the Gang Beasts beast mesh (tools/import_beast.py -> gbcache/beast/); null until loaded or when not imported
export let beastAsset = null;
export async function loadBeast() {
  if (beastAsset || isNode) return;
  try {
    const [json, body, head] = await Promise.all([xhr('./gbcache/beast/beast.json', 'json'), xhr('./gbcache/beast/body.bin', 'arraybuffer'), xhr('./gbcache/beast/head.bin', 'arraybuffer')]);
    beastAsset = { json, body, head };
  } catch { /* not imported: render.js draws blobs */ }
}
