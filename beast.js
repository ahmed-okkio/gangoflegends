// The Gang Beasts "beast" body (Medium build), shared by the sim (rigid bodies) and the renderer (skinning, props).
// Numbers are read off the original prefab (tools/import_beast.py dumps the mesh itself into gbcache/).
// Space: beast root at the feet, facing +z, x-mirrored from Unity so the beast's left is +x.
// Each part's frame is the original bone frame (origin = joint pivot); shapes are in that frame.
// Merged into their parent: crotch -> hips, stomach -> waist, hand -> forearm, foot -> leg.
//   cap: [radius, half segment, axis]   ball: radius   c: shape centre

export const CHEST = 0, HEAD = 1, ARM = 2, THIGH = 4, FORE = 6, LEG = 8, HIPS = 10, WAIST = 11; // pairs: +0 left (+x), +1 right

export const PARTS = [
  { name: 'chest', parent: WAIST, p: [0, 0.6347, -0.0101], q: [0, 0, 0, 1], mass: 10, shapes: [{ cap: [0.193, 0.082, 'x'], c: [0, 0.2544, -0.0134] }] },
  { name: 'head', parent: CHEST, p: [0, 1.0693, 0.0247], q: [0, 0, 0, 1], mass: 5, shapes: [{ ball: 0.2124, c: [0, 0.1653, 0.0573] }] },
  { name: 'leftArm', parent: CHEST, p: [0.2015, 0.9447, -0.0425], q: [0.0308, 0.0308, 0.7064, 0.7064], mass: 5, shapes: [{ cap: [0.0658, 0.1363, 'y'], c: [0, -0.1363, 0] }] },
  { name: 'rightArm', parent: CHEST, p: [-0.2015, 0.9447, -0.0425], q: [0.0308, -0.0308, -0.7064, 0.7064], mass: 5, shapes: [{ cap: [0.0658, 0.1363, 'y'], c: [0, -0.1363, 0] }] },
  { name: 'leftThigh', parent: HIPS, p: [0.2063, 0.3098, -0.0114], q: [-0.0433, -0.0151, 0.0857, 0.9953], mass: 5, shapes: [{ cap: [0.06, 0.09, 'y'], c: [0, -0.0916, 0] }] },
  { name: 'rightThigh', parent: HIPS, p: [-0.2063, 0.3098, -0.0114], q: [-0.0433, 0.0151, -0.0857, 0.9953], mass: 5, shapes: [{ cap: [0.06, 0.09, 'y'], c: [0, -0.0916, 0] }] },
  { name: 'leftForarm', parent: ARM, p: [0.4739, 0.9447, -0.0671], q: [0, 0, 0.7071, 0.7071], mass: 10, hinge: [-2.1, 0], shapes: [{ cap: [0.0487, 0.1561, 'y'], c: [0, -0.1561, 0] }, { ball: 0.04, c: [-0.0247, -0.3374, 0.0191] }] },
  { name: 'rightForarm', parent: ARM + 1, p: [-0.4739, 0.9447, -0.0671], q: [0, 0, -0.7071, 0.7071], mass: 10, hinge: [-2.1, 0], shapes: [{ cap: [0.0487, 0.1561, 'y'], c: [0, -0.1561, 0] }, { ball: 0.04, c: [0.0247, -0.3374, 0.0191] }] },
  { name: 'leftLeg', parent: THIGH, p: [0.239, 0.1201, 0.0057], q: [0.0872, 0, 0, 0.9962], mass: 10, hinge: [0, 1.57], shapes: [{ cap: [0.05, 0.05, 'y'], c: [0, -0.0356, 0] }] },
  { name: 'rightLeg', parent: THIGH + 1, p: [-0.239, 0.1201, 0.0057], q: [0.0872, 0, 0, 0.9962], mass: 10, hinge: [0, 1.57], shapes: [{ cap: [0.05, 0.05, 'y'], c: [0, -0.0356, 0] }] },
  { name: 'hips', parent: -1, p: [0, 0.4223, 0.0002], q: [0, 0, 0, 1], mass: 15, shapes: [{ cap: [0.178, 0.067, 'x'], c: [0, 0, 0] }, { cap: [0.1, 0.075, 'x'], c: [0, -0.0667, 0.0737] }] },
  { name: 'waist', parent: HIPS, p: [0, 0.4223, 0.0002], q: [0, 0, 0, 1], mass: 15, shapes: [{ cap: [0.18, 0.065, 'x'], c: [0, 0.2124, -0.0103] }, { cap: [0.116, 0.1025, 'x'], c: [0, 0.11, 0.0817] }] },
];
// parents before children, for forward kinematics
export const ORDER = [HIPS, WAIST, CHEST, HEAD, ARM, ARM + 1, FORE, FORE + 1, THIGH, THIGH + 1, LEG, LEG + 1];
export const HAND = [[-0.0247, -0.3374, 0.0191], [0.0247, -0.3374, 0.0191]]; // fist centre in forearm space, left/right
export const HIP_HEIGHT = 0.4223; // hips pivot above the floor when standing

// quaternion helpers on [x,y,z,w] arrays
export const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qinv = q => [-q[0], -q[1], -q[2], q[3]];
export const qrot = (q, v) => {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]), ty = 2 * (q[2] * v[0] - q[0] * v[2]), tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [v[0] + q[3] * tx + q[1] * tz - q[2] * ty, v[1] + q[3] * ty + q[2] * tx - q[0] * tz, v[2] + q[3] * tz + q[0] * ty - q[1] * tx];
};
// each part's pivot in its parent's frame (the joint anchor)
export const ANCHOR = PARTS.map(pt => pt.parent < 0 ? null : qrot(qinv(PARTS[pt.parent].q), pt.p.map((v, i) => v - PARTS[pt.parent].p[i])));
