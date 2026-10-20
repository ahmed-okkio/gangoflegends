// Host-authoritative game simulation: Rapier world, active ragdolls, abilities, rounds.
// Runs on the host only (and in Node for tests); clients just render snapshots of it.
import RAPIER from '@dimforge/rapier3d-compat';
import { MAPS } from './maps.js';
import { CHAMPS } from './champs.js';
import { PARTS, ANCHOR, HAND, HIP_HEIGHT, CHEST, HEAD, ARM, THIGH, FORE, LEG, HIPS, WAIST } from './beast.js';

export const initPhysics = () => RAPIER.init();
export const DT = 1 / 60;
export const BTN = { JUMP: 1, PUNCH: 2, GRAB: 4, A1: 8, A2: 16 };
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
const UPPER = [HEAD, ARM, ARM + 1, FORE, FORE + 1]; // hang off the chest
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

export function createSim({ mapId, players, practice = false, roundsToWin = 3 }) {
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
    alive: false, bodies: null, input: { x: 0, z: 0, b: 0 }, prevB: 0, respawn: 0,
  }));
  const teamCount = new Set(ps.map(p => p.team)).size;
  const scores = Array(Math.max(...ps.map(p => p.team)) + 1).fill(0);
  const events = []; // [kind, x, y, z, big] for the renderer's particles, drained by takeEvents()
  const fx = (kind, t, big = 0) => events.push([kind, r2(t.x), r2(t.y), r2(t.z), big]);
  let hooks = [], st = practice ? 'fight' : 'count', timer = 2.5, round = 1, mt = 0, win = -1;

  function spawn(p) {
    const [sx, sy, sz] = map.spawns[p.slot % map.spawns.length];
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
      alive: true, yaw, daze: 0, sinceHit: 9, ko: 0, cd: [0, 0], punch: null, punchCd: 0, nextArm: 0, grabs: [null, null],
      stun: 0, spin: 0, spinHit: null, charge: 0, empower: 0, jumpT: 0, phase: 0, grounded: false, prevB: p.input.b,
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
      if (o?.p.alive && !seen.has(o.p)) seen.set(o.p, { vic: o.p, part: o.part });
    }
    return [...seen.values()];
  }

  function hit(vic, part, dv, daze) {
    for (const b of vic.bodies) addVel(b, dv);
    addVel(vic.bodies[HEAD], mul(dv, 0.3)); // snap the head back a little
    vic.sinceHit = 0;
    fx('hit', vic.bodies[part].translation(), daze >= 40 ? 1 : 0);
    vic.stun = Math.max(vic.stun, 0.15 + len(dv) * 0.04); // let the knockback play out before control returns
    if (dv.y > 2) vic.jumpT = Math.max(vic.jumpT, 0.3); // and don't let the hover spring swallow a launch
    if (vic.ko > 0) { vic.ko = Math.max(vic.ko, 1.5); return; } // hitting a limp body keeps it limp
    vic.daze += daze * (part === HEAD ? 1.5 : 1);
    if (vic.daze >= 100) knockOut(vic);
  }

  function knockOut(p) {
    fx('ko', p.bodies[HEAD].translation());
    p.ko = 3.2; p.daze = 0; p.spin = 0; p.charge = 0; p.punch = null;
    releaseGrabs(p);
    setLegGroups(p, bodyGroups(p));
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
  let leak = V();
  function turn(b, dw, carry) {
    const pivot = b.translation();
    for (const c of [b, ...carry]) {
      c.setAngvel(add(c.angvel(), dw), true);
      const dv = cross(dw, sub(c.worldCom(), pivot));
      addVel(c, dv);
      leak = add(leak, mul(dv, c.mass()));
    }
  }
  // spin the body part so its "down" axis points along dir, at the given strength (0 = limp, 1 = snap)
  function aimPart(b, dir, k, strength, carry = []) {
    const c = qrot(b.rotation(), DOWN), d = norm(dir);
    const ax = cross(c, d), s = len(ax);
    const target = s < 1e-4 ? V() : mul(ax, Math.atan2(s, dot(c, d)) * k / s);
    turn(b, mul(sub(target, b.angvel()), strength), carry);
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

  function useAbility(p, i) {
    const ab = CHAMPS[p.champ].abilities[i];
    if (p.cd[i] > 0) return;
    p.cd[i] = ab.cd;
    const f = facing(p), t = p.bodies[TORSO].translation();
    if (ab.id === 'hook') hooks.push({ o: p, pos: add(add(t, mul(f, 0.7)), V(0, 0.2, 0)), dir: f, t: 0, vic: null, pull: 0 });
    else if (ab.id === 'fist') p.empower = 4;
    else if (ab.id === 'rampage') { p.spin = 0.6; p.spinHit = new Set(); }
    else if (ab.id === 'charge') p.charge = 2.2;
  }

  function control(p, active) {
    const [T, H] = p.bodies;
    const inp = active ? p.input : { x: 0, z: 0, b: 0 };
    const pressed = inp.b & ~p.prevB;
    p.prevB = inp.b;

    if (p.ko > 0 && (p.ko -= DT) <= 0) wake(p);
    const ctrl = p.ko > 0 ? 0 : 1;
    const move = ctrl && (p.stun -= DT) <= 0 ? 1 : 0; // staggered: can't steer, jump or cast
    if ((p.sinceHit += DT) > 1.2) p.daze = Math.max(0, p.daze - 15 * DT);
    p.cd = p.cd.map(c => Math.max(0, c - DT));
    p.punchCd -= DT; p.empower -= DT; p.jumpT -= DT;

    const tp = T.translation(), tv = T.linvel(), Hb = p.bodies[HIPS];
    const ray = world.castRay(new RAPIER.Ray(tp, DOWN), STAND + 0.3, true, undefined, worldAndOthers(p));
    p.grounded = !!ray && ctrl > 0;

    let mx = inp.x, mz = inp.z;
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    if (move) {
      if (p.spin > 0) { p.spin -= DT; p.yaw += 20 * DT; }
      else if (p.charge > 0) { if (m > 0.2) p.yaw = turnToward(p.yaw, Math.atan2(mx, mz), 3 * DT); }
      else if (m > 0.2) p.yaw = Math.atan2(mx, mz);
      if (pressed & BTN.A1) useAbility(p, 0);
      if (pressed & BTN.A2) useAbility(p, 1);
    }
    const f = facing(p), side = V(f.z, 0, -f.x); // side = local +x (the beast's left)

    // locomotion: steer the chest's velocity and hover it at standing height (Gang Beasts lifts the upper body too);
    // the same nudge goes to the whole core so the hips and legs hang underneath without stretching the joints
    let speed = 3.6;
    if (p.charge > 0) { p.charge -= DT; speed = 8.5; mx = f.x; mz = f.z; }
    if (p.spin > 0) speed *= 0.6;
    const k = (p.grounded ? 0.2 : 0.04) * move;
    const dv = V((mx * speed - tv.x) * k, 0, (mz * speed - tv.z) * k);
    if (p.grounded && p.jumpT <= 0) dv.y = ((STAND - ray.timeOfImpact) * 12 - tv.y) * 0.35 + HOLD * DT;
    if (p.grounded && move && pressed & BTN.JUMP) { dv.y = 6.5 - tv.y; p.jumpT = 0.3; }
    if (p.grounded || move) for (const i of CORE) addVel(p.bodies[i], dv);

    // posture: hips, waist, chest and head stay upright and face the stick direction
    const lean = p.charge > 0 ? 0.35 : 0, yq = qyaw(p.yaw), up = (p.grounded ? 0.3 : 0.15) * ctrl;
    leak = V();
    orient(Hb, yq, 10, up);
    orient(p.bodies[WAIST], qmul(yq, qaxis(X, lean * 0.5)), 10, up, [T, ...UPPER.map(i => p.bodies[i])]);
    orient(T, qmul(yq, qaxis(X, lean)), 20, up, UPPER.map(i => p.bodies[i]));
    orient(H, yq, 20, up);

    const hspeed = Math.hypot(tv.x, tv.z), gait = Math.min(1, hspeed / 2);
    p.phase += hspeed * DT * 4.5;
    const grabbing = ctrl && inp.b & BTN.GRAB;
    if (move && pressed & BTN.PUNCH && p.punchCd <= 0 && p.spin <= 0) {
      const arm = p.nextArm; p.nextArm ^= 1;
      p.punch = { arm, t: 0, hit: new Set() };
      p.punchCd = 0.32;
      fx('swing', handPos(p, arm));
      addVel(p.bodies[FORE + arm], add(mul(f, 7), V(0, 1, 0)));
      addVel(T, mul(f, 1));
    }
    if (p.punch && (p.punch.t += DT) > 0.3) p.punch = null;

    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1, swing = Math.sin(p.phase + i * Math.PI);
      // arms: [upper arm dir, forearm dir, strength]. Idle hangs loose with a slight bend, like the originals.
      // `fs` scales the forearm: it lags the upper arm so swings whip instead of moving as one stick
      let ua = add(add(DOWN, mul(f, 0.15 + swing * 0.4 * gait)), mul(side, s * 0.25)), fa = add(DOWN, mul(f, 0.5 + swing * 0.3 * gait)), str = 0.25, fs = 1;
      if (grabbing) { ua = fa = add(add(f, V(0, 0.35, 0)), mul(side, s * 0.1)); str = 0.8; }
      if (p.charge > 0) { ua = fa = add(f, V(0, -0.3, 0)); str = 0.6; }
      if (p.punch?.arm === i) { ua = fa = add(add(f, V(0, 0.1, 0)), mul(side, -s * 0.1)); str = 0.6; fs = 0.4; }
      if (p.spin > 0) { ua = fa = add(mul(side, s), mul(f, 0.1)); str = 0.5; fs = 0.4; }
      aimPart(p.bodies[ARM + i], ua, 14, str * ctrl, [p.bodies[FORE + i]]);
      aimPart(p.bodies[FORE + i], fa, 14, str * fs * ctrl);
      // legs: thighs swing, shins fold back on the up-swing
      aimPart(p.bodies[THIGH + i], add(DOWN, mul(f, swing * 0.7 * gait)), 14, 0.5 * ctrl, [p.bodies[LEG + i]]);
      aimPart(p.bodies[LEG + i], add(DOWN, mul(f, (swing * 0.7 - Math.max(0, Math.cos(p.phase + i * Math.PI)) * 0.9) * gait)), 14, 0.5 * ctrl);
    }
    const back = mul(leak, -1 / p.bodies.reduce((m, b) => m + b.mass(), 0));
    for (const b of p.bodies) addVel(b, back);

    // punch hits
    if (p.punch && p.punch.t > 0.04 && p.punch.t < 0.24) {
      for (const { vic, part } of playersNear(p, handPos(p, p.punch.arm), 0.2)) {
        if (p.punch.hit.has(vic)) continue;
        p.punch.hit.add(vic);
        if (p.empower > 0) { p.empower = 0; hit(vic, part, add(mul(f, 2), V(0, 10, 0)), 45); }
        else hit(vic, part, add(mul(f, 3.5), V(0, 1, 0)), 20);
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
    if (p.charge > 0) {
      const [first] = playersNear(p, add(tp, mul(f, 0.45)), 0.6);
      if (first) {
        p.charge = 0;
        hit(first.vic, first.part, add(mul(f, 11), V(0, 4, 0)), 45);
        addVel(T, mul(f, -2));
      }
    }

    // grabs: each fist sticks to whatever it touches while grab is held
    for (let i = 0; i < 2; i++) {
      if (!grabbing) { if (p.grabs[i]) { world.removeImpulseJoint(p.grabs[i].j, true); p.grabs[i] = null; } continue; }
      if (p.grabs[i]) continue;
      const arm = p.bodies[FORE + i], hp = handPos(p, i);
      const target = overlap(hp, 0.16, worldAndOthers(p))[0]?.parent();
      if (!target) continue;
      const local = qrot(qconj(target.rotation()), sub(hp, target.translation()));
      const j = world.createImpulseJoint(RAPIER.JointData.spherical(V(...HAND[i]), local), arm, target, true);
      j.setContactsEnabled(false);
      p.grabs[i] = { j, target };
      fx('grab', hp);
    }
  }

  function stepHooks() {
    hooks = hooks.filter(h => {
      h.t += DT;
      if (!h.vic) {
        h.pos = add(h.pos, mul(h.dir, 28 * DT));
        const [first] = playersNear(h.o, h.pos, 0.4);
        if (first) { h.vic = first.vic; hit(first.vic, first.part, V(), 25); }
        return h.vic || h.t < 0.42;
      }
      h.pull += DT;
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
    for (const p of ps) if (!p.left) spawn(p);
    hooks = []; win = -1; st = 'count'; timer = 2.5;
  }

  function step() {
    mt += DT;
    for (const { r, body } of rollers) body.setNextKinematicRotation(rollerRot(r, mt));
    if (st === 'count' && (timer -= DT) <= 0) st = 'fight';
    const active = st !== 'count';
    for (const p of ps) if (p.alive) control(p, active);
    stepHooks();
    world.step();

    for (const p of ps) {
      if (p.alive && inKill(p.bodies[TORSO].translation())) { fx('out', p.bodies[TORSO].translation()); removeRagdoll(p); p.respawn = 1.5; }
      if (practice && !p.alive && !p.left && (p.respawn -= DT) <= 0) spawn(p);
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
      st, tm: Math.ceil(timer), rn: round, mt: r2(mt), sc: scores, win,
      p: ps.map(p => {
        if (!p.alive) return [p.slot, 0];
        const flags = (p.spin > 0) | (p.charge > 0) << 1 | (p.empower > 0) << 2 | (p.grabs.some(Boolean)) << 3 | (p.ko > 0) << 4;
        // hips position + every part's rotation; clients rebuild the other positions from the joint anchors (beast.js fk)
        const t = p.bodies[HIPS].translation();
        const out = [p.slot, 1, Math.round(p.daze), flags, Math.ceil(p.cd[0] * 10), Math.ceil(p.cd[1] * 10), r2(t.x), r2(t.y), r2(t.z)];
        for (const b of p.bodies) { const q = b.rotation(); out.push(r3(q.x), r3(q.y), r3(q.z), r3(q.w)); }
        return out;
      }),
      h: hooks.map(h => [h.o.slot, r2(h.pos.x), r2(h.pos.y), r2(h.pos.z)]),
    };
  }

  for (const p of ps) spawn(p);
  return {
    world, players: ps, step, snapshot, takeEvents: () => events.splice(0),
    get state() { return st; },
    setInput(slot, inp) { const p = ps[slot]; if (p) p.input = { x: +inp.x || 0, z: +inp.z || 0, b: inp.b | 0 }; },
    drop(slot) { const p = ps[slot]; if (p) { p.left = true; removeRagdoll(p); } },
  };
}
