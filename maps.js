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
    view: { sea: 0.5 }, // water height, by the propeller (top 0.1) and rudder (0.66): Gang Beasts draws its sea at runtime (render.js)
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
