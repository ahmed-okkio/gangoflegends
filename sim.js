// Host-authoritative game simulation: Rapier world, active ragdolls, abilities, rounds.
// Runs on the host only (and in Node for tests); clients just render snapshots of it.
import RAPIER from '@dimforge/rapier3d-compat';
import { MAPS } from './maps.js';
import { CHAMPS } from './champs.js';
import { PARTS, ANCHOR, HAND, HIP_HEIGHT, CHEST, HEAD, ARM, THIGH, FORE, LEG, HIPS, WAIST } from './beast.js';

export const initPhysics = () => RAPIER.init();
export const DT = 1 / 60;
// LEFT / RIGHT: one button per hand, like Gang Beasts: tap to punch with that hand, hold to reach out and grab with it
export const BTN = { JUMP: 1, LEFT: 2, RIGHT: 4, A1: 8, A2: 16, BUTT: 32, LAY: 64 };
const HANDS = [BTN.LEFT, BTN.RIGHT]; // arm 0 is the beast's left
export const STAND = HIP_HEIGHT + PARTS[CHEST].p[1] - PARTS[HIPS].p[1]; // chest pivot height above the floor when standing

// --- tiny vector / quaternion helpers (Rapier hands out plain {x,y,z(,w)} objects) ---
const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a, s) => V(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = a => Math.sqrt(dot(a, a));
const norm = a => mul(a, 1 / (len(a) || 1));
const qmul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const qconj = q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const qrot = (q, p) => { const t = mul(cross(q, p), 2); return add(add(p, mul(t, q.w)), cross(q, t)); };
const qaxis = (ax, a) => { const s = Math.sin(a / 2); return { x: ax.x * s, y: ax.y * s, z: ax.z * s, w: Math.cos(a / 2) }; };
const UP = V(0, 1, 0), DOWN = V(0, -1, 0), X = V(1, 0, 0), Z = V(0, 0, 1), QI = { x: 0, y: 0, z: 0, w: 1 };
const qyaw = a => qaxis(UP, a);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const r2 = n => Math.round(n * 100) / 100, r3 = n => Math.round(n * 1000) / 1000;
const turnToward = (a, b, max) => a + Math.max(-max, Math.min(max, wrap(b - a)));

// --- ragdoll: the Gang Beasts beast (beast.js). Part index = body index everywhere; bodies[0] is the chest. ---
const TORSO = CHEST;
const CORE = [HIPS, WAIST, CHEST, HEAD, THIGH, THIGH + 1, LEG, LEG + 1]; // moved as one by the locomotion; arms hang off it
const HOLD = 20; // m/s^2 lift on the core (= gravity), so the hover spring only has to hold up the hanging arms
const SAFE = 2.5; // seconds of daze/stagger immunity after getting up from a knockout
const CHARGE = 3, RAMP = 1.5; // Hecarim E: lasts 3s, speeds up evenly from walking to full gallop over the first 1.5s
const FB_R = 2.4; // Sett E reach
const SPIN = 0.3; // Hecarim Q: seconds for its one turn
const TWIST = 0.7; // how firmly arms hold their roll (aimPart)
const TAP = 0.2; // a hand let go within this many seconds punches; held longer, it grabs
const GRIT_FILL = 70; // Sett Q: % of the Grit bar charged per second held
const UPPER = [HEAD]; // turns rigidly with the chest; the arms don't, so they lag and swing out when the beast spins
const isLeg = i => (i >= THIGH && i < THIGH + 2) || (i >= LEG && i < LEG + 2);
const Q = a => ({ x: a[0], y: a[1], z: a[2], w: a[3] });
const ROT_X = qaxis(Z, Math.PI / 2), ROT_Z = qaxis(X, Math.PI / 2); // capsules are y-up in Rapier

// collision groups: (membership << 16) | filter. bit 0 = world, bit slot+1 = that player.
// A ragdoll never collides with itself; legs ignore the world unless knocked out (the torso hovers instead).
const WORLD_GROUPS = (1 << 16) | 0xffff;
const bodyGroups = p => (p.bit << 16) | (0xffff & ~p.bit);
const legGroups = p => (p.bit << 16) | (0xffff & ~p.bit & ~1);
const worldAndOthers = p => (1 << 16) | (0xffff & ~p.bit); // ground rays, grabs
const othersOnly = p => (1 << 16) | (0x1fe & ~p.bit);      // hit checks

// local >= 0: a client's prediction copy. Only that player's ragdoll is simulated (straight from local input, so moving and
// swinging feel instant); everyone else is a kinematic stand-in placed from the host's snapshots, and sync() pulls the
// ragdoll toward the host's authoritative state as it arrives. Hits, KOs and rounds stay the host's call.
export function createSim({ mapId, players, practice = false, roundsToWin = 3, local = -1 }) {
  const map = MAPS[mapId];
  const world = new RAPIER.World(V(0, -20, 0)); // Gang Beasts' gravity
  world.timestep = DT;
  world.numSolverIterations = 8;
  const owner = new Map(); // collider handle -> { p, part }

  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const b of map.boxes)
    world.createCollider(RAPIER.ColliderDesc.cuboid(...b.s).setTranslation(...b.p).setRotation(b.q ? { x: b.q[0], y: b.q[1], z: b.q[2], w: b.q[3] } : QI).setFriction(0.9).setCollisionGroups(WORLD_GROUPS), ground);
  const rollerRot = (r, t) => qmul(qaxis(X, r.spin * t), qaxis(Z, Math.PI / 2)); // cylinder is y-up; lay it along x
  const rollers = map.rollers.map(r => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...r.p).setRotation(rollerRot(r, 0)));
    world.createCollider(RAPIER.ColliderDesc.cylinder(r.hx, r.r).setFriction(1.5).setCollisionGroups(WORLD_GROUPS), body);
    return { r, body };
  });

  const ps = players.map((pl, slot) => ({
    ...pl, slot, bit: 1 << (slot + 1), champ: CHAMPS[pl.champ] ? pl.champ : 'blitz',
    alive: false, bodies: null, input: { x: 0, z: 0, b: 0 }, prevB: 0, respawn: 0, ack: 0, q: new Map(), next: null, newest: -1,
  }));
  const teamCount = new Set(ps.map(p => p.team)).size;
  const scores = Array(Math.max(...ps.map(p => p.team)) + 1).fill(0);
  const events = []; // [kind, x, y, z, big] for the renderer's particles, drained by takeEvents()
  // [kind, x, y, z, big, slot]: slot = who caused it, so a predicting client can skip the host's copy of its own swings
  const fx = (kind, t, big = 0, slot = -1) => events.push([kind, r2(t.x), r2(t.y), r2(t.z), big, slot]);
  let hooks = [], st = practice ? 'fight' : 'count', timer = 2.5, round = 1, mt = 0, win = -1;
  // spawn points are dealt out at random every round
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  let order = shuffle(map.spawns.map((_, i) => i));

  function spawn(p, at = order[p.slot % order.length]) {
    const [sx, sy, sz] = map.spawns[at];
    const yaw = Math.atan2(-sx, -sz); // face the middle
    const q = qyaw(yaw), base = V(sx, sy + 0.05, sz);
    p.bodies = PARTS.map((part, i) => {
      // Gang Beasts rigidbodies: drag 1, angular drag 0.5
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(...Object.values(add(base, qrot(q, V(...part.p))))).setRotation(qmul(q, Q(part.q)))
        .setLinearDamping(1).setAngularDamping(i === HIPS || i === WAIST || i === CHEST ? 2 : 0.5).setCcdEnabled(i >= FORE && i < FORE + 2));
      for (const sh of part.shapes) {
        const desc = sh.ball ? RAPIER.ColliderDesc.ball(sh.ball) : RAPIER.ColliderDesc.capsule(sh.cap[1], sh.cap[0]).setRotation(sh.cap[2] === 'x' ? ROT_X : sh.cap[2] === 'z' ? ROT_Z : QI);
        const col = world.createCollider(desc.setTranslation(...sh.c).setMass(part.mass / part.shapes.length).setFriction(0.8)
          .setCollisionGroups(isLeg(i) ? legGroups(p) : bodyGroups(p)), body);
        owner.set(col.handle, { p, part: i });
      }
      return body;
    });
    PARTS.forEach((part, i) => {
      if (part.parent < 0) return;
      const a = V(...ANCHOR[i]);
      const data = part.hinge ? RAPIER.JointData.revolute(a, V(), X) : RAPIER.JointData.spherical(a, V());
      const j = world.createImpulseJoint(data, p.bodies[part.parent], p.bodies[i], true);
      j.setContactsEnabled(false);
      if (part.hinge) j.setLimits(...part.hinge);
    });
    Object.assign(p, {
      alive: true, yaw, daze: 0, sinceHit: 9, ko: 0, cd: [0, 0], punch: null, punchCd: 0, grabs: [null, null], held: [0, 0],
      stun: 0, spin: 0, spinHit: null, charge: 0, empower: 0, jumpT: 0, phase: 0, grounded: false, prevB: p.input.b,
      butt: null, buttCd: 0, lying: false, climb: 0, safe: 0, hooked: 0, spinA: 0, chargeT: 0,
      emp: null, dash: null, vault: 0, vaultBtn: 0, hay: 0, hayK: 0, hayBtn: 0, fb: 0, grit: 0,
    });
  }

  function removeRagdoll(p) {
    if (!p.bodies) return;
    for (const q of ps) q.grabs?.forEach((g, i) => {
      if (g && (q === p || p.bodies.includes(g.target))) { world.removeImpulseJoint(g.j, true); q.grabs[i] = null; }
    });
    hooks = hooks.filter(h => h.o !== p && h.vic !== p);
    for (const b of p.bodies) {
      for (let i = 0; i < b.numColliders(); i++) owner.delete(b.collider(i).handle);
      world.removeRigidBody(b);
    }
    p.bodies = null;
    p.alive = false;
  }

  const addVel = (b, dv) => b.setLinvel(add(b.linvel(), dv), true);
  const handPos = (p, i) => { const b = p.bodies[FORE + i]; return add(b.translation(), qrot(b.rotation(), V(...HAND[i]))); };
  const facing = p => V(Math.sin(p.yaw), 0, Math.cos(p.yaw));

  // colliders overlapping a ball. Collected first: touching the world inside Rapier's query callback panics.
  function overlap(pos, r, groups) {
    const out = [];
    world.intersectionsWithShape(pos, QI, new RAPIER.Ball(r), c => { out.push(c); return true; }, undefined, groups);
    return out;
  }
  // other live players touching a ball, once each: [{ vic, part }]
  function playersNear(p, pos, r) {
    const seen = new Map();
    for (const c of overlap(pos, r, othersOnly(p))) {
      const o = owner.get(c.handle);
      if ((o?.p.alive || o?.proxy) && !seen.has(o.p)) seen.set(o.p, { vic: o.p, part: o.part });
    }
    return [...seen.values()];
  }

  function hit(vic, part, dv, daze) {
    if (local >= 0) return; // a prediction copy only learns about hits from the host
    for (const b of vic.bodies) addVel(b, dv);
    addVel(vic.bodies[HEAD], mul(dv, 0.3)); // snap the head back a little
    vic.sinceHit = 0;
    fx('hit', vic.bodies[part].translation(), daze >= 40 ? 1 : 0);
    if (dv.y > 2) vic.jumpT = Math.max(vic.jumpT, 0.3); // don't let the hover spring swallow a launch
    if (vic.champ === 'sett') vic.grit = Math.min(100, vic.grit + daze * 0.8); // Sett's Grit: getting hit fills it
    // knocked out, or just back up from it: still gets knocked around, but no stagger or daze, so no chain stuns
    if (vic.ko > 0 || vic.safe > 0) return;
    vic.stun = Math.max(vic.stun, 0.15 + len(dv) * 0.04); // let the knockback play out before control returns
    vic.daze += daze * (part === HEAD ? 1.5 : 1) * (vic.hay > 0 ? 0.5 : 1); // Sett's Haymaker windup shrugs off half
    if (vic.daze >= 100) knockOut(vic);
  }

  function knockOut(p) {
    fx('ko', p.bodies[HEAD].translation());
    p.ko = 3.2; p.daze = 0;
    cancel(p);
    setLegGroups(p, bodyGroups(p));
  }
  // drop whatever the player was doing: knocked out, or caught by a hook
  function cancel(p) {
    p.spin = 0; p.charge = 0; p.punch = null; p.butt = null; p.dash = null; p.vault = 0; p.hay = 0;
    releaseGrabs(p);
  }
  const wake = p => setLegGroups(p, legGroups(p));
  function setLegGroups(p, g) {
    p.bodies.forEach((b, i) => { if (isLeg(i)) for (let c = 0; c < b.numColliders(); c++) b.collider(c).setCollisionGroups(g); });
  }
  function releaseGrabs(p) {
    p.grabs.forEach((g, i) => { if (g) { world.removeImpulseJoint(g.j, true); p.grabs[i] = null; } });
  }

  // spin a body about its joint pivot (the body origin) by dw; `carry` bodies turn rigidly with it.
  // The pivot swing adds linear momentum; it's tallied in `leak` and taken back off the whole beast after posing,
  // otherwise the limbs aiming forward every step push the beast along (the idle slide).
  // track = false leaves it out of `leak`: a limb pinned by a grab can't actually swing, so taking that momentum back
  // off the beast would just shove it around (grabbing a wall pushed the beast into the floor)
  let leak = V();
  function turn(b, dw, carry, track = true) {
    const pivot = b.translation();
    for (const c of [b, ...carry]) {
      c.setAngvel(add(c.angvel(), dw), true);
      const dv = cross(dw, sub(c.worldCom(), pivot));
      addVel(c, dv);
      if (track) leak = add(leak, mul(dv, c.mass()));
    }
  }
  // each limb's rest orientation relative to its parent (beast.js)
  const REST = PARTS.map(pt => pt.parent < 0 ? null : qmul(qconj(Q(PARTS[pt.parent].q)), Q(pt.q)));
  const arc = (a, b) => { // shortest rotation taking unit vector a onto b
    const c = cross(a, b), w = 1 + dot(a, b);
    if (w < 1e-4) return { ...norm(Math.abs(a.x) < 0.9 ? cross(a, X) : cross(a, Z)), w: 0 };
    const n = Math.hypot(c.x, c.y, c.z, w);
    return { x: c.x / n, y: c.y / n, z: c.z / n, w: w / n };
  };
  // spin body part i so its "down" axis points along dir, at the given strength (0 = limp, 1 = snap). Its twist about
  // that axis is held where it sits at rest relative to its parent, at least as firmly as `twist` even when the swing is
  // loose (arms: left free they roll and wring the skinned shoulders; legs stay loose, holding them spoils climbing).
  // Like Gang Beasts' joint drives, the target spin is relative to the parent body: a limb rides along with its parent
  // but keeps its own momentum, so arms dangle and fling out instead of being held in place in the world.
  function aimPart(p, i, dir, k, strength, carry = [], track = true, twist = 0) {
    const b = p.bodies[i], par = p.bodies[PARTS[i].parent], base = qmul(par.rotation(), REST[i]);
    let e = qmul(qmul(arc(qrot(base, DOWN), norm(dir)), base), qconj(b.rotation()));
    if (e.w < 0) e = { x: -e.x, y: -e.y, z: -e.z, w: -e.w };
    const s = Math.hypot(e.x, e.y, e.z);
    const dw = sub(add(par.angvel(), s < 1e-5 ? V() : mul(V(e.x, e.y, e.z), 2 * Math.atan2(s, e.w) * k / s)), b.angvel());
    const axis = qrot(b.rotation(), DOWN), roll = mul(axis, dot(dw, axis));
    turn(b, add(mul(sub(dw, roll), strength), mul(roll, Math.max(strength, twist))), carry, track);
  }
  // rotate a body towards a target orientation, about its joint pivot (the body origin) rather than its centre of mass,
  // so the joint doesn't eat the correction. `carry` bodies turn rigidly with it, so heavy arms and head ride along.
  function orient(b, qt, k, strength, carry = []) {
    let e = qmul(qt, qconj(b.rotation()));
    if (e.w < 0) e = { x: -e.x, y: -e.y, z: -e.z, w: -e.w };
    const s = Math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z);
    const target = s < 1e-5 ? V() : mul(V(e.x, e.y, e.z), 2 * Math.atan2(s, e.w) * k / s);
    turn(b, mul(sub(target, b.angvel()), strength), carry);
  }

  // Vi E punch: smash the target and everyone standing in a cone behind it
  function relentless(p, vic, part, f) {
    const vt = vic.bodies[TORSO].translation();
    hit(vic, part, add(mul(f, 7), V(0, 2, 0)), 35);
    for (const o of ps) {
      if (o === p || o === vic || !o.alive) continue;
      const d = sub(o.bodies[TORSO].translation(), vt), along = d.x * f.x + d.z * f.z;
      if (along > 0 && along < 1.8 && Math.abs(d.x * f.z - d.z * f.x) < 0.5 + along * 0.4 && Math.abs(d.y) < 1) hit(o, TORSO, add(mul(f, 5), V(0, 1.5, 0)), 20);
    }
  }

  function useAbility(p, i) {
    const ab = CHAMPS[p.champ].abilities[i];
    if (ab.id === 'charge' && p.charge > 0) { p.charge = 0; return; } // recast ends the charge early
    if (p.cd[i] > 0) return;
    p.cd[i] = ab.cd;
    const f = facing(p), t = p.bodies[TORSO].translation(), btn = i ? BTN.A2 : BTN.A1;
    if (ab.id === 'hook') hooks.push({ o: p, pos: add(add(t, mul(f, 0.7)), V(0, 0.2, 0)), dir: f, t: 0, vic: null, pull: 0 });
    else if (ab.id === 'fist') { p.empower = 4; p.emp = 'launch'; }
    else if (ab.id === 'rampage') { p.spin = SPIN; p.spinHit = new Set(); }
    else if (ab.id === 'charge') { p.charge = CHARGE; p.chargeT = 0; }
    else if (ab.id === 'vault') { p.vault = DT; p.vaultBtn = btn; } // charges while held, see control()
    else if (ab.id === 'relentless') { p.empower = 4; p.emp = 'through'; }
    else if (ab.id === 'haymaker') { p.hay = DT; p.hayK = 0; p.hayBtn = btn; } // charges while held, see control()
    else if (ab.id === 'facebreaker') facebreaker(p, f, t);
  }

  // Sett E: yank everyone close on both sides into him and stun them; caught from both sides at once stuns for longer
  function facebreaker(p, f, t) {
    p.fb = 0.35;
    fx('fb', t, 0, p.slot);
    if (local >= 0) return;
    const near = ps.filter(o => o !== p && o.alive).map(o => ({ o, d: sub(o.bodies[TORSO].translation(), t) }))
      .filter(({ d }) => Math.hypot(d.x, d.z) < FB_R && Math.abs(d.y) < 1.2);
    const both = near.some(({ d }) => dot(d, f) >= 0) && near.some(({ d }) => dot(d, f) < 0);
    for (const { o, d } of near) {
      hit(o, TORSO, add(mul(norm(V(-d.x, 0, -d.z)), 7), V(0, 1.2, 0)), both ? 35 : 15);
      if (o.ko <= 0 && o.safe <= 0) o.stun = Math.max(o.stun, both ? 1.5 : 0.6);
    }
  }
  // Sett Q: a big cone punch, as strong as the Grit charged into it (k 0..1); the middle of the cone hits hardest
  function haymaker(p, f, t, k) {
    p.punch = { arm: 1, t: 0, hit: new Set(ps) }; // the arm swings for show; the cone does the hitting
    addVel(p.bodies[FORE + 1], add(mul(f, 9), V(0, 1, 0)));
    fx('hit', add(t, mul(f, 1.2)), 1, p.slot);
    if (local >= 0) return;
    for (const o of ps) {
      if (o === p || !o.alive) continue;
      const d = sub(o.bodies[TORSO].translation(), t), dist = Math.hypot(d.x, d.z), along = (d.x * f.x + d.z * f.z);
      if (dist > 2.4 || Math.abs(d.y) > 1.2 || along < dist * Math.cos(0.6)) continue;
      const centre = Math.abs(d.x * f.z - d.z * f.x) < 0.35;
      hit(o, TORSO, mul(add(mul(f, centre ? 5 + 9 * k : 4 + 6 * k), V(0, 1.5 + 2 * k, 0)), 1.5), (centre ? 25 + 75 * k : 15 + 45 * k) * 1.5);
    }
  }

  function control(p, active) {
    const [T, H] = p.bodies;
    const inp = active ? p.input : { x: 0, z: 0, b: 0 };
    const pressed = inp.b & ~p.prevB;
    p.prevB = inp.b;

    if (p.ko > 0 && (p.ko -= DT) <= 0) { wake(p); p.safe = SAFE; }
    p.safe -= DT; p.hooked -= DT;
    // lying down (hold): go limp like a KO, legs touch the floor; let go to get back up
    const lying = p.ko <= 0 && !!(inp.b & BTN.LAY);
    if (lying !== p.lying) { p.lying = lying; setLegGroups(p, lying ? bodyGroups(p) : legGroups(p)); }
    const ctrl = p.ko > 0 || p.hooked > 0 ? 0 : lying ? 0.08 : 1; // hooked: limp, dragged along helpless
    const move = ctrl && (p.stun -= DT) <= 0 ? 1 : 0; // staggered: can't steer, jump or cast
    if ((p.sinceHit += DT) > 1.2) p.daze = Math.max(0, p.daze - 15 * DT);
    if (p.sinceHit > 3) p.grit = Math.max(0, p.grit - 12 * DT); // Grit drains out of combat
    p.cd = p.cd.map(c => Math.max(0, c - DT));
    p.punchCd -= DT; p.empower -= DT; p.jumpT -= DT; p.buttCd -= DT;

    const tp = T.translation(), tv = T.linvel(), Hb = p.bodies[HIPS];
    const ray = world.castRay(new RAPIER.Ray(tp, DOWN), STAND + 0.3, true, undefined, worldAndOthers(p));
    p.grounded = !!ray && ctrl > 0 && !lying;

    let mx = inp.x, mz = inp.z;
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    // Rampage spins the body (spinA) on top of the travel direction, so it works while walking or charging
    if (p.spin > 0) { p.spin -= DT; p.spinA += (2 * Math.PI / SPIN) * DT; } else p.spinA = 0; // one full turn
    if (move) {
      if (p.charge > 0) { if (m > 0.2) p.yaw = turnToward(p.yaw, Math.atan2(mx, mz), 3 * DT); }
      else if (m > 0.2) p.yaw = Math.atan2(mx, mz);
      if (pressed & BTN.A1) useAbility(p, 0);
      if (pressed & BTN.A2) useAbility(p, 1);
    }
    const f = facing(p); // travel direction
    const bf = V(Math.sin(p.yaw + p.spinA), 0, Math.cos(p.yaw + p.spinA)), side = V(bf.z, 0, -bf.x); // body facing; side = the beast's left

    // locomotion: steer the chest's velocity and hover it at standing height (Gang Beasts lifts the upper body too);
    // the same nudge goes to the whole core so the hips and legs hang underneath without stretching the joints
    let speed = 3.6;
    if (p.charge > 0) { p.charge -= DT; p.chargeT += DT; speed = 3.6 + 5.4 * Math.min(1, p.chargeT / RAMP); mx = f.x; mz = f.z; }
    // Vi Q: hold to wind up (slowed), let go (or max out) to dash; a longer windup dashes further and hits harder
    if (p.vault > 0) {
      if (move && inp.b & p.vaultBtn && p.vault < 1.25) { p.vault += DT; speed *= 0.35; }
      else { p.dash = { t: 0.2 + p.vault * 0.3, power: p.vault / 1.25 }; p.vault = 0; }
    }
    if (p.dash) { speed = 11; mx = f.x; mz = f.z; if ((p.dash.t -= DT) <= 0) p.dash = null; }
    // Sett Q: hold to plant and pour Grit into the punch (up to what the bar holds), let go to throw it
    if (p.hay > 0) {
      if (move && inp.b & p.hayBtn && p.hay < 3) { p.hay += DT; p.hayK = Math.min(p.grit, p.hayK + GRIT_FILL * DT); speed = 0; }
      else { if (move) { haymaker(p, f, tp, Math.max(0.15, p.hayK / 100)); p.grit = Math.max(0, p.grit - p.hayK); } p.hay = 0; p.hayK = 0; }
    }
    p.fb -= DT;
    if (lying) speed = 1.2; // crawl
    const k = (p.grounded ? 0.2 : 0.04) * move;
    const dv = V((mx * speed - tv.x) * k, 0, (mz * speed - tv.z) * k);
    if (p.grounded && p.jumpT <= 0) dv.y = ((STAND - ray.timeOfImpact) * 12 - tv.y) * 0.35 + HOLD * DT;
    if (p.grounded && move && pressed & BTN.JUMP) { dv.y = 6.5 - tv.y; p.jumpT = 0.3; }
    // climbing: hanging off a ledge by the hands, jump hauls the chest up past the hands, then they let go and
    // the body rolls forward over the edge
    const ledge = p.grabs.reduce((y, g, i) => g?.target.isFixed() ? Math.max(y, handPos(p, i).y) : y, -Infinity);
    if (move && !p.grounded && ledge > -Infinity && pressed & BTN.JUMP && p.climb <= 0) { p.climb = 1.2; p.over = false; }
    if (p.climb > 0) {
      p.climb -= DT;
      if (!p.over && ledge > -Infinity && tp.y < ledge + 0.6) {
        // haul up, held just behind the hands so the chest neither swings out nor jams under the lip
        const held = p.grabs.map((g, i) => g && handPos(p, i)).filter(Boolean), hx = held.reduce((a, h) => a + h.x, 0) / held.length, hz = held.reduce((a, h) => a + h.z, 0) / held.length;
        dv.y = (5 - tv.y) * 0.5 + HOLD * DT;
        dv.x = ((hx - f.x * 0.3 - tp.x) * 4 - tv.x) * 0.3; dv.z = ((hz - f.z * 0.3 - tp.z) * 4 - tv.z) * 0.3; // stay just out from the wall
      } else {
        if (!p.over) { p.over = true; p.climb = Math.min(p.climb, 0.4); releaseGrabs(p); }
        dv.y = (1.5 - tv.y) * 0.3 + HOLD * DT;
        dv.x = (f.x * 3 - tv.x) * 0.4; dv.z = (f.z * 3 - tv.z) * 0.4;
      }
    }
    if (p.grounded || move) for (const i of CORE) addVel(p.bodies[i], dv);

    // posture: hips, waist, chest and head stay upright and face the stick direction
    const lean = p.charge > 0 || p.dash ? 0.35 : p.butt ? 0.9 * Math.sin(Math.min(1, p.butt.t / 0.25) * Math.PI) : 0, yq = qyaw(p.yaw + p.spinA), up = (p.grounded ? 0.3 : 0.15) * ctrl;
    leak = V();
    orient(Hb, yq, 10, up);
    // punching turns the shoulders into it: wound back, then the punching side drives forward (that's the reach)
    const cock = p.held.findIndex(h => h > 0 && h < TAP && p.grounded);
    const tw = p.punch ? (p.punch.arm ? 0.7 : -0.7) : cock >= 0 ? (cock ? -0.3 : 0.3) : 0;
    orient(p.bodies[WAIST], qmul(qyaw(p.yaw + p.spinA + tw * 0.4), qaxis(X, lean * 0.5)), 10, up, [T, ...UPPER.map(i => p.bodies[i])]);
    orient(T, qmul(qyaw(p.yaw + p.spinA + tw), qaxis(X, lean)), 20, up, UPPER.map(i => p.bodies[i]));
    orient(H, qmul(yq, qaxis(X, lean * 0.6)), 20, up);

    const hspeed = Math.hypot(tv.x, tv.z), gait = Math.min(1, hspeed / 2);
    p.phase += hspeed * DT * 4.5;
    // hands, Gang Beasts style: pressing one cocks that arm back; let go quickly (a tap) and it throws the punch,
    // keep holding and it reaches out and grabs instead
    const grabbing = [false, false];
    for (const arm of [0, 1]) {
      if (ctrl && inp.b & HANDS[arm]) p.held[arm] += DT;
      else if (p.held[arm] > 0) {
        if (p.held[arm] < TAP && !p.grabs[arm] && move && p.punchCd <= 0 && p.spin <= 0) {
          p.punch = { arm, t: 0, hit: new Set() }; // already drawn back while the button was down
          p.punchCd = 0.25;
          fx('swing', handPos(p, arm), 0, p.slot);
          addVel(T, mul(f, 1.5)); // lunge into it
        }
        p.held[arm] = 0;
      }
      grabbing[arm] = p.held[arm] >= TAP || (p.held[arm] > 0 && !p.grounded); // in the air, grab at once: ledges go by fast
    }
    if (p.punch && (p.punch.t += DT) > 0.25) p.punch = null;
    // headbutt: the whole upper body snaps forward and the head leads
    if (move && pressed & BTN.BUTT && p.buttCd <= 0 && p.spin <= 0) {
      p.butt = { t: 0, hit: new Set() }; p.buttCd = 0.7;
      addVel(H, add(mul(f, 4), V(0, 0.5, 0))); addVel(T, mul(f, 1.5));
      fx('swing', H.translation(), 0, p.slot);
    }
    if (p.butt && (p.butt.t += DT) > 0.3) p.butt = null;

    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1, swing = Math.sin(p.phase + i * Math.PI);
      // arms: [upper arm dir, forearm dir, strength]. Idle hangs loose with a slight bend, like the originals.
      // `fs` scales the forearm: it lags the upper arm so swings whip instead of moving as one stick
      // poses follow the body facing (bf), which only differs from the travel direction mid-Rampage
      let ua = add(add(DOWN, mul(bf, 0.15 + swing * 0.4 * gait)), mul(side, s * 0.25)), fa = add(DOWN, mul(bf, 0.5 + swing * 0.3 * gait)), str = 0.1, fs = 1;
      if (grabbing[i]) { ua = fa = add(add(bf, V(0, 0.35, 0)), mul(side, s * 0.1)); str = 0.8; }
      if (p.charge > 0) { ua = fa = add(bf, V(0, -0.3, 0)); str = 0.6; }
      if (p.vault > 0) { ua = fa = add(mul(bf, -0.6), DOWN); str = 0.5; } // fists drawn back
      if (p.dash) { ua = fa = add(bf, V(0, 0.1, 0)); str = 0.8; } // both fists leading
      if (p.hay > 0 && i === 1) { ua = add(mul(bf, -0.8), V(0, 0.4, 0)); fa = add(bf, V(0, 0.6, 0)); str = 0.6; } // cocked back
      if (p.hay > 0 && i === 0) { ua = fa = add(bf, V(0, 0.2, 0)); str = 0.5; } // guard hand out front
      // Facebreaker: arms fling wide, then slam together in front
      if (p.fb > 0) { ua = fa = p.fb > 0.18 ? add(mul(side, s), mul(bf, -0.3)) : add(mul(side, s * 0.15), bf); str = 0.9; }
      // punch: the fist sweeps round from the side to the front (a short hook) out of the cocked pose below
      if (p.punch?.arm === i) {
        const u = Math.min(1, p.punch.t / 0.1);
        ua = add(add(mul(side, s * 0.9 * (1 - u)), mul(bf, 0.3 + 0.7 * u)), V(0, 0.15, 0)); fa = add(bf, V(0, 0.1, 0)); str = 0.9; fs = 0.8;
      }
      if (p.spin > 0) { ua = fa = add(mul(side, s), mul(bf, 0.1)); str = 0.5; fs = 0.4; }
      if (p.held[i] > 0 && !grabbing[i] && p.punch?.arm !== i) { ua = add(add(mul(bf, -0.5), mul(side, s * 0.7)), V(0, -0.3, 0)); fa = add(bf, V(0, 0.3, 0)); str = 0.6; fs = 0.7; } // cocked: elbow back and out
      if (grabbing[i] && !p.grounded) { ua = fa = add(mul(bf, 0.5), V(0, 1, 0)); str = 0.8; } // reach up for ledges
      if (p.climb > 0) { ua = fa = add(mul(bf, 0.3), DOWN); str = 0.8; } // push down on the ledge
      const free = !p.grabs[i]?.target.isFixed() || !p.grounded; // hanging or climbing, arm momentum is what lifts the beast
      aimPart(p, ARM + i, ua, 14, str * ctrl, [p.bodies[FORE + i]], free, TWIST);
      aimPart(p, FORE + i, fa, 14, str * fs * ctrl, [], free, TWIST);
      // legs: thighs swing, shins fold back on the up-swing
      aimPart(p, THIGH + i, add(DOWN, mul(bf, swing * 0.7 * gait)), 14, 0.5 * ctrl, [p.bodies[LEG + i]]);
      aimPart(p, LEG + i, add(DOWN, mul(bf, (swing * 0.7 - Math.max(0, Math.cos(p.phase + i * Math.PI)) * 0.9) * gait)), 14, 0.5 * ctrl);
    }
    const back = mul(leak, -1 / p.bodies.reduce((m, b) => m + b.mass(), 0));
    for (const b of p.bodies) addVel(b, back);

    // headbutt hits: the skull, a little ahead of the head pivot
    if (p.butt && p.butt.t > 0.03 && p.butt.t < 0.22) {
      for (const { vic, part } of playersNear(p, add(H.translation(), qrot(H.rotation(), V(0, 0.17, 0.08))), 0.24)) {
        if (p.butt.hit.has(vic)) continue;
        p.butt.hit.add(vic);
        hit(vic, part, add(mul(f, 4), V(0, 1.5, 0)), 30);
      }
    }

    // punch hits
    // punch hits land as hard as the fist is moving, so a spinning or running punch carries the body's momentum
    if (p.punch && p.punch.t > 0.01) {
      const arm = p.bodies[FORE + p.punch.arm], hp = handPos(p, p.punch.arm);
      const fv = add(arm.linvel(), cross(arm.angvel(), sub(hp, arm.worldCom())));
      for (const { vic, part } of playersNear(p, hp, 0.2)) {
        if (p.punch.hit.has(vic)) continue;
        const sp = len(sub(fv, vic.bodies[part].linvel()));
        if (sp < 2.5) continue; // a resting fist just pushes
        p.punch.hit.add(vic);
        if (p.empower > 0 && p.emp === 'through') { p.empower = 0; relentless(p, vic, part, f); }
        else if (p.empower > 0) { p.empower = 0; hit(vic, part, add(mul(f, 2), V(0, 10, 0)), 45); }
        else { const k = Math.min(sp, 12) / 6; hit(vic, part, add(mul(norm(add(norm(fv), f)), 2.2 * k), V(0, 0.6, 0)), 20 * k); }
      }
    }
    if (p.spin > 0) for (let i = 0; i < 2; i++) {
      for (const { vic, part } of playersNear(p, handPos(p, i), 0.25)) {
        if (p.spinHit.has(vic)) continue;
        p.spinHit.add(vic);
        const vt = vic.bodies[TORSO].translation();
        hit(vic, part, add(mul(norm(V(vt.x - tp.x, 0, vt.z - tp.z)), 6), V(0, 2, 0)), 24);
      }
    }
    if (p.dash) {
      const [first] = playersNear(p, add(tp, mul(f, 0.45)), 0.6);
      if (first) {
        const k = p.dash.power;
        p.dash = null;
        hit(first.vic, first.part, add(mul(f, 6 + k * 6), V(0, 2 + k * 2, 0)), 25 + k * 20);
        addVel(T, mul(f, -2));
      }
    }
    if (p.charge > 0) {
      const [first] = playersNear(p, add(tp, mul(f, 0.45)), 0.6);
      if (first) { // hits as hard as the gallop has built up
        const r = Math.min(1, p.chargeT / RAMP);
        p.charge = 0;
        hit(first.vic, first.part, add(mul(f, 5 + 6 * r), V(0, 1.5 + 2.5 * r, 0)), 20 + 25 * r);
        addVel(T, mul(f, -2));
      }
    }

    // grabs: each fist sticks to whatever it touches while its hand is held (after a climb, only once grabbing again)
    if (!grabbing[0] && !grabbing[1] && p.climb <= 0) p.over = false;
    for (let i = 0; i < 2; i++) {
      if (!grabbing[i] || p.over) { if (p.grabs[i]) { world.removeImpulseJoint(p.grabs[i].j, true); p.grabs[i] = null; } continue; }
      if (p.grabs[i]) continue;
      const arm = p.bodies[FORE + i], hp = handPos(p, i);
      const target = overlap(hp, 0.16, worldAndOthers(p))[0]?.parent();
      if (!target) continue;
      const local = qrot(qconj(target.rotation()), sub(hp, target.translation()));
      const j = world.createImpulseJoint(RAPIER.JointData.spherical(V(...HAND[i]), local), arm, target, true);
      j.setContactsEnabled(false);
      p.grabs[i] = { j, target };
      fx('grab', hp, 0, p.slot);
    }
  }

  // play back the next queued client input (setInput); a missing one repeats the last, which is right nearly always
  function feed(p) {
    const inp = p.q.get(p.next);
    if (inp) p.input = inp;
    p.q.delete(p.next);
    p.ack = p.next++;
  }

  function stepHooks() {
    if (local >= 0) { hooks = []; return; } // hooks are drawn from the host's snapshots
    hooks = hooks.filter(h => {
      h.t += DT;
      if (!h.vic) {
        h.pos = add(h.pos, mul(h.dir, 28 * DT));
        const [first] = playersNear(h.o, h.pos, 0.4);
        if (first) { h.vic = first.vic; hit(first.vic, first.part, V(), 25); cancel(h.vic); }
        return h.vic || h.t < 0.42;
      }
      h.pull += DT;
      h.vic.hooked = 0.1; // limp for as long as the pull lasts
      const vp = h.vic.bodies[TORSO].translation(), to = sub(h.o.bodies[TORSO].translation(), vp), d = len(to);
      h.pos = vp;
      if (d < 1.4 || h.pull > 0.7) return false;
      const v = add(mul(to, 14 / d), V(0, 1.5, 0));
      for (const b of h.vic.bodies) b.setLinvel(v, true);
      return true;
    });
  }

  const inKill = t => t.y < map.killY || (map.bound && Math.max(Math.abs(t.x), Math.abs(t.z)) > map.bound) || map.kill.some(k => t.x > k.min[0] && t.x < k.max[0] && t.y > k.min[1] && t.y < k.max[1] && t.z > k.min[2] && t.z < k.max[2]);

  function resetRound() {
    for (const p of ps) removeRagdoll(p);
    order = shuffle(order);
    for (const p of ps) if (!p.left) spawn(p);
    hooks = []; win = -1; st = 'count'; timer = 2.5;
  }

  // ---------- client prediction (local >= 0) ----------
  const me = ps[local], hist = new Map(); // local tick -> my hips { pos, vel } after that step
  let tick = 0, err = 0; // err: last correction size (m), for tests
  if (me) for (const q of ps) if (q !== me) {
    // everyone else: a kinematic bean the size of a standing beast, so I bump into them and can grab them
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, 0));
    const col = world.createCollider(RAPIER.ColliderDesc.capsule(0.4, 0.35).setTranslation(0, 0.35, 0).setCollisionGroups(bodyGroups(q)), body);
    owner.set(col.handle, { p: q, part: TORSO, proxy: true });
    q.bodies = PARTS.map(() => body);
  }
  const hips = () => me.bodies[HIPS];
  const shift = (dp, dv) => { for (const b of me.bodies) { b.setTranslation(add(b.translation(), dp), true); addVel(b, dv); } };
  // e: my entry in a host snapshot (see snapshot()). The host's state is my state `ack` local ticks ago, so the
  // error is measured against my history at that tick and the difference is folded into the present.
  function sync(s, e) {
    st = s.st;
    if (!e[1]) { if (me.alive) removeRagdoll(me); return; }
    const x = 9 + PARTS.length * 4, hp = V(e[6], e[7], e[8]), hv = V(e[x + 2], e[x + 3], e[x + 4]), ack = e[x + 5];
    // countdown: my inputs land on the host a round trip (tick - ack) after this snapshot's clock, so start moving that much early
    if (st === 'count') { timer = s.t - (tick - ack) * DT; if (timer <= 0) st = 'fight'; }
    if (!me.alive) { // (re)spawned on the host: start from the spawn point it used
      const near = map.spawns.map(([sx, , sz], i) => [Math.hypot(sx - hp.x, sz - hp.z), i]).sort((a, b) => a[0] - b[0])[0][1];
      spawn(me, near); hist.clear();
    }
    // status is the host's call
    me.daze = e[2]; me.grit = e[x];
    me.cd = me.cd.map((c, i) => Math.max(c, e[4 + i] / 10 - 0.2));
    me.stun = Math.max(me.stun, e[x + 6]);
    if (e[x + 7]) me.hooked = 0.1;
    if (e[3] & 16 && me.ko <= 0) { me.daze = 0; cancel(me); setLegGroups(me, bodyGroups(me)); }
    else if (!(e[3] & 16) && me.ko > 0) { me.ko = 0; wake(me); }
    if (e[3] & 16) me.ko = e[x + 8];
    me.safe = e[3] & 32 ? Math.max(me.safe, 0.1) : 0;
    const h = hist.get(ack);
    if (!h) return;
    const dp = sub(hp, h.pos), dv = sub(hv, h.vel), d = len(dp);
    err = d;
    // far off (teleport, missed a big hit): jump there. Otherwise ease in, and take velocity jumps (knockback) whole.
    // knocked out or hooked I'm drawn from the host's state, so just stay on it; tiny errors are left alone (no shimmer)
    const limp = me.ko > 0 || me.hooked > 0, kp = d > 2 || limp ? 1 : d < 0.03 ? 0 : 0.25, kv = len(dv) > 2.5 || limp ? 1 : len(dv) < 0.2 ? 0 : 0.2;
    const cp = mul(dp, kp), cv = mul(dv, kv);
    shift(cp, cv);
    for (const [t, v] of hist) if (t > ack) { v.pos = add(v.pos, cp); v.vel = add(v.vel, cv); } // they already include the old error
  }
  function stepLocal() {
    mt += DT; tick++;
    for (const { r, body } of rollers) body.setNextKinematicRotation(rollerRot(r, mt));
    if (st === 'count' && (timer -= DT) <= 0) st = 'fight';
    if (me.alive) control(me, st !== 'count');
    world.step();
    if (me.alive) hist.set(tick, { pos: hips().translation(), vel: hips().linvel() });
    hist.delete(tick - 240);
  }
  // others' stand-ins go where the screen shows them (hips position from the interpolated snapshot)
  function place(slot, x, y, z) { const q = ps[slot]; if (q !== me) q.bodies[0].setNextKinematicTranslation(V(x, y, z)); }

  function step() {
    if (me) return stepLocal();
    mt += DT;
    for (const { r, body } of rollers) body.setNextKinematicRotation(rollerRot(r, mt));
    if (st === 'count' && (timer -= DT) <= 0) st = 'fight';
    const active = st !== 'count';
    for (const p of ps) { if (p.next != null) feed(p); if (p.alive) control(p, active); }
    stepHooks();
    world.step();

    for (const p of ps) {
      if (p.alive && inKill(p.bodies[TORSO].translation())) { fx('out', p.bodies[TORSO].translation()); removeRagdoll(p); p.respawn = 1.5; }
      if (practice && !p.alive && !p.left && (p.respawn -= DT) <= 0) spawn(p, Math.floor(Math.random() * map.spawns.length));
    }
    if (practice) return;
    if (st === 'fight' && teamCount > 1) {
      const alive = new Set(ps.filter(p => p.alive).map(p => p.team));
      if (alive.size <= 1) {
        win = alive.size ? [...alive][0] : -1;
        if (win >= 0) scores[win]++;
        st = win >= 0 && scores[win] >= roundsToWin ? 'match' : 'round';
        timer = st === 'match' ? 5 : 3;
      }
    } else if (st === 'round' && (timer -= DT) <= 0) { round++; resetRound(); }
    else if (st === 'match' && (timer -= DT) <= 0) st = 'over';
  }

  function snapshot() {
    return {
      st, tm: Math.ceil(timer), t: r2(timer), rn: round, mt: r3(mt), sc: scores, win,
      p: ps.map(p => {
        if (!p.alive) return [p.slot, 0];
        const flags = (p.spin > 0) | (p.charge > 0) << 1 | (p.empower > 0) << 2 | (p.grabs.some(Boolean)) << 3 | (p.ko > 0) << 4 | (p.safe > 0) << 5 | (p.vault > 0 || p.hay > 0) << 6;
        // hips position + every part's rotation; clients rebuild the other positions from the joint anchors (beast.js fk)
        const t = p.bodies[HIPS].translation();
        const out = [p.slot, 1, Math.round(p.daze), flags, Math.ceil(p.cd[0] * 10), Math.ceil(p.cd[1] * 10), r2(t.x), r2(t.y), r2(t.z)];
        for (const b of p.bodies) { const q = b.rotation(); out.push(r3(q.x), r3(q.y), r3(q.z), r3(q.w)); }
        // then: Grit, Haymaker charge, and what a predicting client needs to line itself up (sync())
        const v = p.bodies[HIPS].linvel();
        out.push(Math.round(p.grit), Math.round(p.hayK), r2(v.x), r2(v.y), r2(v.z), p.ack, r2(Math.max(0, p.stun)), p.hooked > 0 ? 1 : 0, r2(Math.max(0, p.ko)));
        return out;
      }),
      h: hooks.map(h => [h.o.slot, r2(h.pos.x), r2(h.pos.y), r2(h.pos.z)]),
    };
  }

  if (!me) for (const p of ps) spawn(p);
  return {
    world, players: ps, step, snapshot, sync, place, takeEvents: () => events.splice(0),
    get state() { return st; },
    get tick() { return tick; },
    get err() { return err; },
    // a local player's input ({ x, z, b }), or a client's: { n, i: [[x, z, b], ...] } for its ticks n - i.length + 1 .. n,
    // queued and played back one per step in tick order (feed), so network jitter doesn't change which step an input
    // lands on and the tick echoed back (ack) lines up exactly with the client's own history
    setInput(slot, inp) {
      const p = ps[slot];
      if (!p) return;
      if (!Array.isArray(inp.i)) { p.input = { x: +inp.x || 0, z: +inp.z || 0, b: inp.b | 0 }; return; }
      const n = inp.n | 0;
      inp.i.slice(-8).forEach(([x, z, b], k, all) => { const t = n - all.length + 1 + k; if (p.next == null || t >= p.next) p.q.set(t, { x: +x || 0, z: +z || 0, b: b | 0 }); });
      p.newest = Math.max(p.newest, n);
      // first input, or the buffer drifted too deep (lag builds up) or ran dry (stale inputs): line up 2 ticks behind
      if (p.next == null || p.newest - p.next > 8 || p.next - p.newest > 6) { p.next = p.newest - 2; for (const t of p.q.keys()) if (t < p.next) p.q.delete(t); }
    },
    drop(slot) { const p = ps[slot]; if (p) { p.left = true; removeRagdoll(p); } },
  };
}
