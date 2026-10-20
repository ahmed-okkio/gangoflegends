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

const loaded = {};
export async function prepareMap(id, { meshes = !isNode } = {}) {
  const map = MAPS[id];
  if (!map?.gb || loaded[id]) return MAPS[id];
  const base = `./gbcache/${map.gb}/`;
  let scene;
  try { scene = await readJson(base + 'scene.json'); } catch { return map; } // not imported: keep the procedural fallback
  const bins = {};
  if (meshes) await Promise.all(Object.keys(scene.meshes).map(async k => { bins[k] = await xhr(base + k + '.bin', 'arraybuffer'); }));
  const bottom = scene.kill.find(k => /bottom/i.test(k.path));
  loaded[id] = MAPS[id] = {
    ...map,
    killY: bottom ? bottom.p[1] + bottom.h[1] : map.killY,
    bound: 22, // the side kill planes sit at +-25
    boxes: scene.colliders.map(c => ({ p: c.p, q: c.q, s: c.h })),
    rollers: [], kill: [],
    spawns: scene.spawns.map(([x, y, z]) => [x, y - 0.2, z]), // spawn markers float 0.2 above the floor
    imported: { scene, bins, base },
  };
  return MAPS[id];
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
