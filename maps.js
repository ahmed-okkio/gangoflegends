// Arenas, shared by the host sim (colliders) and the renderer (meshes).
// box: centre p, half-extents s, material m. Top of the main floor is always y = 0.
// kill: torso inside any of these boxes (or below killY) is eliminated.
// rollers: kinematic cylinders along x that spin at `spin` rad/s; render reads the same data.
// belts: conveyors { min, max, top, v }: the imported rollers in that x/z area become a slab at height top whose surface moves at v.

// trains: { tracks: [{ z, dir }], y, reach, speed, delay: [min, max] }: a car (the imported stage's `train`) runs each track
// from x = -dir * reach to dir * reach, then waits a delay before the next. Kill boxes deep in the tunnels do the rest.

const box = (x, y, z, hx, hy, hz, m = 'girder') => ({ p: [x, y, z], s: [hx, hy, hz], m });

// where the trains are at match time t: [{ x, z, dir }] for the ones out on the line. A pure function of t, so the host,
// the clients' predicted worlds and the renderer all agree without sending anything
export function trainsAt(map, t) {
  const T = map.trains;
  if (!T) return [];
  const run = 2 * T.reach / T.speed, rnd = n => { const r = Math.sin(n * 12.9898) * 43758.5453; return r - Math.floor(r); };
  // one train at a time down a random track, never more than 3 in a row on the same one. Waits of 1.5-6.3s: a train
  // 25% more often than the two tracks' own 4-30s schedules (Gang Beasts' TrainSpawn) put together
  for (let n = 0, at = 0, k = -1, same = 0; ; n++) { // ponytail: walks the schedule from 0 each call; ~t / 9s steps, cache if matches run for hours
    const nk = same >= 3 ? (k + 1) % T.tracks.length : Math.floor(rnd(n + 0.5) * T.tracks.length);
    same = nk === k ? same + 1 : 1; k = nk;
    at += T.delay[0] + rnd(n) * (T.delay[1] - T.delay[0]);
    if (t < at) return [];
    const { z, dir } = T.tracks[k];
    if (t < at + run) return [{ x: dir * (T.speed * (t - at) - T.reach), z, dir, k }];
    at += run;
  }
}

// the ferris wheel's turn (radians about z) at match time t: map.wheel { speed: [start, max] deg/s, ramp: [from, to] s }
// turns at start speed, then speeds up evenly to max between from and to (Gang Beasts' axle starts escalating 30-60s in,
// up to its MaxSpeed 95). A pure function of t, like trainsAt
export function wheelAngle(map, t) {
  const { speed: [w0, w1], ramp: [a, b] } = map.wheel, k = Math.PI / 180;
  const ramp = Math.min(Math.max(t - a, 0), b - a);
  return k * (w0 * t + (w1 - w0) * (ramp * ramp / (2 * (b - a)) + Math.max(t - b, 0)));
}

// the water's surface over (x, z), or null for none: the sea of Trawler and Wheel (view.sea) everywhere, Aquarium's pools over
// their own water meshes (stages.js water: triangles flattened to x, z). Only with the stage imported
export function waterLevel(map, x, z) {
  if (!map.imported) return null;
  if (map.view?.sea != null) return map.view.sea;
  for (const w of map.water ?? []) {
    if (x < w.min[0] || x > w.max[0] || z < w.min[1] || z > w.max[1]) continue;
    const t = w.tris;
    for (let i = 0; i < t.length; i += 6) {
      const s = (ax, az, bx, bz) => (bx - ax) * (z - az) - (bz - az) * (x - ax);
      const a = s(t[i], t[i + 1], t[i + 2], t[i + 3]), b = s(t[i + 2], t[i + 3], t[i + 4], t[i + 5]), c = s(t[i + 4], t[i + 5], t[i], t[i + 1]);
      if ((a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0)) return w.y;
    }
  }
  return null;
}

// Aquarium's octopus: eight tentacles rooted 3m out round the pool's centre (Gang Beasts' layout), 19.5m long
export const TENTACLE_ROOTS = [0, 1, 2, 3, 4, 5, 6, 7].map(k => [3 * Math.sin(k * Math.PI / 4), 3 * Math.cos(k * Math.PI / 4)]);
export const TENTACLE_LEN = 19.5;
// points along tentacle k's spine at fractions fs (0 deep in the pool, 1 the tip), each [x, y, z, tangent x, y, z]: up out of
// the water at y over its root, arching `arch` high over to `tip`. A cubic Bezier, sampled by arc length so the bones keep
// their spacing. Shared by the host's colliders (sim.js) and the drawn bones (render.js), so both bend it the same
export function tentacleSpine(k, tip, arch, fs, y) {
  const [rx, rz] = TENTACLE_ROOTS[k], top = Math.max(tip[1], y) + arch;
  const P = [[rx, y - 14, rz], [rx, y + arch * 0.6, rz], [rx + (tip[0] - rx) * 0.6, top, rz + (tip[2] - rz) * 0.6], tip];
  const at = u => { const v = 1 - u, w = [v * v * v, 3 * v * v * u, 3 * v * u * u, u * u * u]; return [0, 1, 2].map(c => w.reduce((s, wi, i) => s + wi * P[i][c], 0)); };
  const N = 24, pts = [], acc = [0];
  for (let i = 0; i <= N; i++) pts.push(at(i / N));
  for (let i = 1; i <= N; i++) acc.push(acc[i - 1] + Math.hypot(...[0, 1, 2].map(c => pts[i][c] - pts[i - 1][c])));
  return fs.map(f => {
    const d = f * acc[N];
    let i = 1;
    while (i < N && acc[i] < d) i++;
    const s = (d - acc[i - 1]) / ((acc[i] - acc[i - 1]) || 1), a = pts[i - 1], b = pts[i], L = Math.hypot(...[0, 1, 2].map(c => b[c] - a[c])) || 1;
    return [...[0, 1, 2].map(c => a[c] + (b[c] - a[c]) * s), ...[0, 1, 2].map(c => (b[c] - a[c]) / L)];
  });
}

export const MAPS = {
  // Gang Beasts stages (gb); without an import each is a stand-in: Girders its own beams, the rest a plain floor
  rooftop: {
    name: 'Rooftop',
    blurb: 'A city rooftop in the rain. The edge is closer than it looks.',
    gb: 'rooftop',
    killY: -10, // out past the third window down (8 floors over ~23.5m, ~3m each); by eye from the user
    gbKill: false, // GB's own kill volumes start 2m under the roof: out the moment you slip off. killY does it instead
    boxes: [box(0, -0.2, -3, 8, 0.2, 5, 'plate')],
    rollers: [], kill: [{ min: [-5.5, -24, -0.5], max: [-1.5, -2, 5.5] }], // through the skylight: its pit floor is only 3m down
    spawns: [[-6, 0, -3], [6, 0, -3], [0, 0, -7], [0, 0, 1], [-3, 0, -5], [3, 0, -1], [-3, 0, -1], [3, 0, -5]],
  },
  girders: {
    name: 'Girders',
    blurb: 'A half-built tower high above the city. Mind the drop.',
    gb: 'girders', // replaced by the imported Gang Beasts stage when gbcache/girders exists
    view: { poro: [-4.6, 0, -3.2, 0.8] }, // imported look: sky colours, camera, easter egg (render.js buildImported)
    killY: -8,
    boxes: [
      box(0, -0.2, 0, 8, 0.2, 1.1),          // long beam
      box(0, -0.2, 0, 1.1, 0.2, 7),          // cross beam
      box(0, -0.2, 0, 2.6, 0.2, 2.6, 'plate'),
      box(-5.5, -0.2, -3.5, 1.1, 0.2, 2.4),  // side spur
      box(5.5, -0.2, 3.5, 1.1, 0.2, 2.4),
      // pillars + crossbar to hang off
      box(-2.4, 1.5, -2.4, 0.15, 1.5, 0.15, 'dark'), box(2.4, 1.5, -2.4, 0.15, 1.5, 0.15, 'dark'),
      box(0, 3.1, -2.4, 2.55, 0.12, 0.12, 'dark'),
    ],
    rollers: [],
    kill: [],
    spawns: [[-6, 0, 0], [6, 0, 0], [0, 0, -5.5], [0, 0, 5.5], [-1.6, 0, 1.6], [1.6, 0, -1.6], [-5.5, 0, -4.5], [5.5, 0, 4.5]],
  },
  incinerator: {
    name: 'Incinerator',
    blurb: 'A furnace pit with a lid that opens. Keep off the middle.',
    gb: 'incinerator',
    killY: -6,
    boxes: [box(0, -0.2, 0, 6, 0.2, 4, 'plate')],
    rollers: [], kill: [],
    // the stage has no spawn markers; these are on the floor behind the pit (z < -1.25 is the pit and its belts)
    spawns: [[-1.5, 0, 2], [-4.5, 0, 2], [-7.5, 0, 2], [-3, 0, 4.5], [-6, 0, 4.5], [2.5, 0, 4], [6, 0, 4], [4.5, 0, 0.2]],
    // both conveyors roll toward the pit, like Gang Beasts'
    // by eye: ambient (lightmap, environment) turned down so the pit's light carries the room. That light is brighter,
    // wider and longer than Gang Beasts' (2000, 65 degrees, 37.9) to reach the whole stage
    view: { dim: 0.55, exposure: 0.95, lights: { 'Fire Pit Light long': { intensity: 5000, angle: 120, inner: 90, range: 60 } } },
    belts: [{ min: [4.6, 0, -6.8], max: [15, 0, -3.2], top: 0.2, v: [-1, 0, 0] }, { min: [-15, 0, -6.8], max: [-2.6, 0, -3.2], top: 0.2, v: [1, 0, 0] }],
  },
  trawler: {
    name: 'Trawler',
    blurb: 'A fishing boat out at sea. Throw them overboard, or down the hold.',
    gb: 'trawler',
    // GB's own eight sit in a ring on the stern; spread over the boat instead: bow (clear of the hold), the walkway past the
    // cabin and the stern (deck heights raycast off the imported stage)
    gbSpawns: [[-11, 4.3, -1.5], [-10, 4.3, 1.5], [-5.5, 4.3, -2.5], [-5.5, 4.3, 2.5], [3, 3.3, -3], [9, 3.3, -2], [9, 3.3, 2], [13, 3.3, 0]],
    sharks: true, // Gang Beasts' (tools/import_shark.py; sim.js stepSharks)
    view: { sea: 1.6 }, // water height: just under the hull's rim (1.8), over the blue as in Gang Beasts, which draws its sea at runtime (render.js)
    killY: -6,
    boxes: [box(0, -0.2, 0, 9, 0.2, 2.5, 'plate')],
    rollers: [], kill: [],
    spawns: [[-6, 0, 0], [6, 0, 0], [-3, 0, -1.5], [3, 0, 1.5], [-3, 0, 1.5], [3, 0, -1.5], [0, 0, -1.5], [0, 0, 1.5]],
  },
  subway: {
    name: 'Subway',
    blurb: 'An underground platform between two tracks. Mind the gap.',
    gb: 'subway',
    view: { cam: { pitch: 32, min: 11, max: 20 } }, // Gang Beasts' camera sits 5 up and 8 back (32 degrees); closer than Girders' by eye
    killY: -6,
    boxes: [box(3.5, -0.2, 0, 8, 0.2, 3, 'plate')],
    rollers: [], kill: [],
    // Gang Beasts' trains: the back track runs +x, the front -x. Speed by eye; the tunnels' kill boxes start at |x| 17
    trains: { tracks: [{ z: 6, dir: 1 }, { z: -6, dir: -1 }], y: -1.5, reach: 60, speed: 25, delay: [1.5, 6.3] },
    // the platform walls under the yellow lip filled out flush with it (the front's sat 0.3m back): no hiding under it,
    // and climbing up from the track the hands find the lip instead of the chest jamming beneath it
    gbBoxes: [box(0, -0.8, 4.15, 25, 0.65, 0.15), box(0, -0.8, -4.15, 25, 0.65, 0.15)],
    spawns: [[9.5, 0, 1.5], [2.3, 0, -2.5], [5.2, 0, 2.5], [-2.5, 0, 1.5], [-2.5, 0, -1.5], [9.5, 0, -1.5], [2.3, 0, 2.5], [5.3, 0, -2.5]],
  },
  wheel: {
    name: 'Wheel',
    blurb: 'A pier with a ferris wheel that keeps speeding up. Ride it, or get thrown off it.',
    gb: 'wheel',
    wheel: { speed: [12, 95], ramp: [45, 120] }, // by eye: a slow lap at first, a spin every ~4s two minutes in
    view: { sea: -3.85 }, // the top of Gang Beasts' sea KillVolume. Swim it like Trawler's: that volume is dropped, drowning does it
    gbKillSkip: /\/KillVolume$/,
    killY: -12, // well under the surface, like Trawler's: sinking out is the drowning's call
    boxes: [box(0, -0.2, -6, 6, 0.2, 4, 'plate')],
    rollers: [], kill: [],
    spawns: [[-3, 0, -4], [3, 0, -4], [-3, 0, -8], [3, 0, -8], [0, 0, -3], [0, 0, -9], [-5, 0, -6], [5, 0, -6]],
  },
  aquarium: {
    name: 'Aquarium',
    blurb: 'An aquarium with an octopus in the pool. Its tentacles will drag you under.',
    gb: 'aquarium',
    pools: /aquarium_water(Upper|Lower)$/, // swim in the stage's own water meshes (stages.js): the round pool and the lower tank
    octopus: true, // Gang Beasts' tentacles (tools/import_tentacle.py; sim.js stepTentacles)
    // its own Volume: +1 EV (others +1.4), contrast +10, no saturation boost, and a master curve lifting the mids (end slopes 2, 0.47)
    // tank: the round pool's water seen through its glass (radius, glass bottom and top; GB's water shader shades it deep blue)
    // camera kept under the skylight's ring (~6m up), like Gang Beasts' view from inside the room
    view: { tank: [4.62, -2.48, -0.52], cam: { pitch: 25, min: 10, max: 14 }, exposure: 0.6, curve: [2, 0.47], grade: { contrast: { value: 1.1 }, saturation: { value: 1 } } },
    killY: -20, // under the round pool GB's Kill Volume starts 4.5m down: what the tentacles drag you into
    boxes: [box(0, -0.2, 0, 8, 0.2, 8, 'plate')],
    rollers: [], kill: [],
    spawns: [[-6, 0, 0], [6, 0, 0], [0, 0, -6], [0, 0, 6], [-4.2, 0, -4.2], [4.2, 0, 4.2], [-4.2, 0, 4.2], [4.2, 0, -4.2]],
  },
  grind: {
    name: 'Grind',
    hidden: true, // not in the menus; the sim tests use this arena
    blurb: 'A Zaun chem-works with a hungry grinder in the middle.',
    killY: -6,
    boxes: [
      box(0, -0.25, 3.15, 7, 0.25, 1.85, 'plate'),
      box(0, -0.25, -3.15, 7, 0.25, 1.85, 'plate'),
      box(-4.5, -0.25, 0, 2.5, 0.25, 1.3, 'plate'),
      box(4.5, -0.25, 0, 2.5, 0.25, 1.3, 'plate'),
      box(0, 0.35, -5.1, 7, 0.35, 0.1, 'dark'),   // low back wall
      box(-7.1, 0.9, 0, 0.1, 0.9, 5.2, 'dark'),   // side wall
    ],
    rollers: [
      { p: [0, -0.9, 0.6], r: 0.55, hx: 2, spin: -5 },
      { p: [0, -0.9, -0.6], r: 0.55, hx: 2, spin: 5 },
    ],
    kill: [{ min: [-2, -5, -1.3], max: [2, 0.7, 1.3] }],
    spawns: [[-5, 0, 3], [5, 0, -3], [-5, 0, -3], [5, 0, 3], [0, 0, 3.4], [0, 0, -3.4], [-2.5, 0, 2.2], [2.5, 0, -2.2]],
  },
};
