// Arenas, shared by the host sim (colliders) and the renderer (meshes).
// box: centre p, half-extents s, material m. Top of the main floor is always y = 0.
// kill: torso inside any of these boxes (or below killY) is eliminated.
// rollers: kinematic cylinders along x that spin at `spin` rad/s; render reads the same data.
// belts: conveyors { min, max, top, v }: the imported rollers in that x/z area become a slab at height top whose surface moves at v.

const box = (x, y, z, hx, hy, hz, m = 'girder') => ({ p: [x, y, z], s: [hx, hy, hz], m });

export const MAPS = {
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
  // more Gang Beasts stages; without an import each is just a plain floor
  rooftop: {
    name: 'Rooftop',
    blurb: 'A city rooftop in the rain. The edge is closer than it looks.',
    gb: 'rooftop',
    killY: -6,
    boxes: [box(0, -0.2, -3, 8, 0.2, 5, 'plate')],
    rollers: [], kill: [],
    spawns: [[-6, 0, -3], [6, 0, -3], [0, 0, -7], [0, 0, 1], [-3, 0, -5], [3, 0, -1], [-3, 0, -1], [3, 0, -5]],
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
    view: { dim: 0.4, lights: { 'Fire Pit Light long': { intensity: 5000, angle: 120, inner: 90, range: 60 } } },
    belts: [{ min: [4.6, 0, -6.8], max: [15, 0, -3.2], top: 0.2, v: [-1, 0, 0] }, { min: [-15, 0, -6.8], max: [-2.6, 0, -3.2], top: 0.2, v: [1, 0, 0] }],
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
