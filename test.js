// Headless sim check: node test.js
import assert from 'node:assert/strict';
import { initPhysics, createSim, BTN, STAND } from './sim.js';

await initPhysics();
Math.random = () => 0.9999; // spawn shuffle leaves the order alone, so spawns match what these checks were tuned on
const run = (sim, n, each) => { for (let i = 0; i < n; i++) { each?.(i); sim.step(); } };
const torso = (sim, slot) => sim.players[slot].bodies[0].translation();
const upright = (sim, slot) => { const q = sim.players[slot].bodies[0].rotation(); return 1 - 2 * (q.x * q.x + q.z * q.z); }; // cos(tilt)
const near = (champA, champB, extra = {}) => createSim({
  mapId: 'grind', practice: true, ...extra,
  players: [{ id: 'a', name: 'A', champ: champA, team: 0 }, { id: 'b', name: 'B', champ: champB, team: 1 }],
});
// put B 1.1m in front of A on the solid floor and face A at B
function lineUp(sim, gap = 1.1) {
  for (const [slot, x] of [[0, -4], [1, -4 + gap]]) {
    const p = sim.players[slot], dx = x - p.bodies[0].translation().x;
    for (const b of p.bodies) { const t = b.translation(); b.setTranslation({ x: t.x + dx, y: t.y, z: t.z - (t.z - 3) }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
  }
  sim.players[0].input = { x: 1, z: 0, b: 0 }; run(sim, 3); sim.players[0].input = { x: 0, z: 0, b: 0 };
}

// 1. ragdolls stand on their own
{
  const sim = near('blitz', 'hec');
  run(sim, 180);
  for (const s of [0, 1]) {
    assert.ok(Math.abs(torso(sim, s).y - STAND) < 0.15, `stands at ${torso(sim, s).y}`);
    assert.ok(upright(sim, s) > 0.95, `upright ${upright(sim, s)}`);
  }
  // walking moves you
  const x0 = torso(sim, 0).x;
  sim.setInput(0, { x: 0, z: -1, b: 0 });
  run(sim, 60);
  assert.ok(Math.abs(torso(sim, 0).x - x0) < 1 && upright(sim, 0) > 0.85, 'walks upright');
  console.log('stand + walk ok');
}

// 2. punches daze, enough of them knock out
{
  const sim = near('blitz', 'hec');
  run(sim, 90);
  lineUp(sim);
  let k = 0;
  for (; k < 10 && sim.players[1].ko <= 0; k++) { lineUp(sim); run(sim, 22, i => sim.setInput(0, { x: 0, z: 0, b: i < 3 ? BTN.LEFT : 0 })); }
  console.log('punches to KO', k, 'daze', sim.players[1].daze.toFixed(0));
  assert.ok(sim.players[1].ko > 0, 'punches knock out');
  // KO length is fixed and getting up gives a safe window: punching through it doesn't chain another KO
  let kos = 0, wasKo = true;
  for (let i = 0; i < 12; i++) { lineUp(sim); run(sim, 22, j => { sim.setInput(0, { x: 0, z: 0, b: j < 3 ? BTN.LEFT : 0 }); const ko = sim.players[1].ko > 0; if (ko && !wasKo) kos++; wasKo = ko; }); }
  assert.ok(sim.players[1].ko <= 0 || kos > 0, 'KO does not last forever under punches');
  assert.ok(kos <= 1, `no chain KO right after waking (${kos})`);
}

// 3. Blitz hook pulls from range
{
  const sim = near('blitz', 'hec');
  run(sim, 90);
  lineUp(sim, 6);
  const before = torso(sim, 1).x - torso(sim, 0).x;
  run(sim, 40, i => sim.setInput(0, { x: 0, z: 0, b: i < 2 ? BTN.A1 : 0 }));
  const after = torso(sim, 1).x - torso(sim, 0).x;
  console.log('hook gap', before.toFixed(2), '->', after.toFixed(2));
  assert.ok(after < before - 2, 'hook pulls');
}

// 4. Hecarim charge ramps up, shoves hard at full gallop, recast stops it, Rampage works mid-charge
{
  const sim = near('hec', 'blitz');
  run(sim, 90);
  lineUp(sim, 9);
  const bx = torso(sim, 1).x, sp = () => Math.hypot(sim.players[0].bodies[0].linvel().x, sim.players[0].bodies[0].linvel().z);
  let early = 0, late = 0;
  run(sim, 120, i => { sim.setInput(0, { x: 1, z: 0, b: i < 2 ? BTN.A2 : 0 }); if (i === 20) early = sp(); if (i === 70) late = sp(); });
  console.log('charge speed', early.toFixed(1), '->', late.toFixed(1), 'shove', (torso(sim, 1).x - bx).toFixed(2));
  assert.ok(early < 5.5 && late > 6.5, 'charge ramps up');
  assert.ok(torso(sim, 1).x - bx > 2, 'charge shoves');
  const s2 = near('hec', 'blitz');
  run(s2, 90);
  run(s2, 30, i => s2.setInput(0, { x: 1, z: 0, b: i < 2 || (i > 20 && i < 23) ? BTN.A2 : 0 }));
  assert.ok(s2.players[0].charge <= 0, 'recast cancels the charge');
  const s3 = near('hec', 'blitz');
  run(s3, 90);
  lineUp(s3, 9);
  const x0 = torso(s3, 0).x;
  run(s3, 60, i => s3.setInput(0, { x: 1, z: 0, b: (i < 2 ? BTN.A2 : 0) | (i > 30 && i < 33 ? BTN.A1 : 0) }));
  assert.ok(torso(s3, 0).x - x0 > 3, 'keeps charging through Rampage');
  console.log('hec ok', (torso(s3, 0).x - x0).toFixed(2));
}

// 5. Power Fist launches
{
  const sim = near('blitz', 'hec');
  run(sim, 90);
  lineUp(sim);
  let peak = 0;
  run(sim, 60, i => { sim.setInput(0, { x: 0, z: 0, b: i < 2 ? BTN.A2 : i > 5 && i < 9 ? BTN.LEFT : 0 }); peak = Math.max(peak, torso(sim, 1).y); });
  console.log('fist peak', peak.toFixed(2));
  assert.ok(peak > STAND + 1, 'power fist launches');
}

// 6. walking into the grinder eliminates; round ends, winner scores
{
  const sim = near('blitz', 'hec', { practice: false });
  run(sim, 180);
  const p = sim.players[1];
  for (const b of p.bodies) { const t = b.translation(); b.setTranslation({ x: t.x - (p.bodies[0].translation().x), y: t.y, z: t.z - p.bodies[0].translation().z + 2 }, true); }
  run(sim, 200, () => sim.setInput(1, { x: 0, z: -1, b: 0 }));
  assert.equal(p.alive, false, 'grinder kills');
  assert.equal(sim.snapshot().sc[0], 1, 'survivor scores');
  console.log('grinder + scoring ok');
}

// 7. grab sticks to a body and lets go
{
  const sim = near('blitz', 'hec');
  run(sim, 90);
  lineUp(sim, 0.95);
  run(sim, 30, () => sim.setInput(0, { x: 0, z: 0, b: (BTN.LEFT | BTN.RIGHT) }));
  assert.ok(sim.players[0].grabs.some(Boolean), 'grabbed');
  run(sim, 5, () => sim.setInput(0, { x: 0, z: 0, b: 0 }));
  assert.ok(!sim.players[0].grabs.some(Boolean), 'released');
  // grabbing the side wall while standing holds on without dragging the beast down
  const p = sim.players[0], t0 = torso(sim, 0);
  for (const b of p.bodies) { const t = b.translation(); b.setTranslation({ x: t.x - t0.x - 6.45, y: t.y, z: t.z - t0.z }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
  run(sim, 60, () => sim.setInput(0, { x: -1, z: 0, b: 0 }));
  run(sim, 120, () => sim.setInput(0, { x: 0, z: 0, b: BTN.LEFT | BTN.RIGHT }));
  assert.ok(p.grabs.some(g => g?.target.isFixed()), 'grabs the wall');
  assert.ok(Math.abs(torso(sim, 0).y - STAND) < 0.12, `stays standing while holding the wall (${torso(sim, 0).y})`);
  console.log('grab ok');
}

// 8. headbutt dazes, lying down drops you and you get back up, hanging off a ledge you can climb up
{
  const sim = near('blitz', 'hec');
  run(sim, 90);
  lineUp(sim, 0.75);
  run(sim, 20, i => sim.setInput(0, { x: 0, z: 0, b: i < 3 ? BTN.BUTT : 0 }));
  assert.ok(sim.players[1].daze > 0, 'headbutt dazes');
  run(sim, 60, () => sim.setInput(0, { x: 0, z: 0, b: BTN.LAY }));
  assert.ok(torso(sim, 0).y < 0.35, `lies down ${torso(sim, 0).y}`);
  run(sim, 90, () => sim.setInput(0, { x: 0, z: 0, b: 0 }));
  assert.ok(Math.abs(torso(sim, 0).y - STAND) < 0.15, 'gets back up');
  // hang off the +z edge of the floor (top y 0, edge z 5) facing it, then climb (B moved out of the way)
  for (const b of sim.players[1].bodies) { const t = b.translation(); b.setTranslation({ x: t.x, y: t.y, z: t.z - 5 }, true); }
  const p = sim.players[0], t0 = torso(sim, 0);
  for (const b of p.bodies) { const t = b.translation(); b.setTranslation({ x: t.x - t0.x - 3, y: t.y - t0.y - 0.45, z: t.z - t0.z + 5.35 }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
  p.yaw = Math.PI;
  run(sim, 40, () => sim.setInput(0, { x: 0, z: 0, b: (BTN.LEFT | BTN.RIGHT) }));
  assert.ok(p.grabs.every(Boolean), 'hangs by both hands');
  run(sim, 60, i => sim.setInput(0, { x: 0, z: 0, b: (BTN.LEFT | BTN.RIGHT) | (i === 2 ? BTN.JUMP : 0) }));
  assert.ok(p.alive && torso(sim, 0).y > 0.3 && torso(sim, 0).z < 5, `climbs onto the ledge ${JSON.stringify(torso(sim, 0))}`);
  console.log('headbutt + lie down + climb ok');
}

// 9. Vi: Vault Breaker dash hits, Relentless Force punches through to the champ behind
{
  const sim = createSim({ mapId: 'grind', practice: true, players: [
    { id: 'a', name: 'A', champ: 'vi', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }, { id: 'c', name: 'C', champ: 'blitz', team: 2 }] });
  run(sim, 90);
  lineUp(sim, 2.2);
  run(sim, 60, i => sim.setInput(0, { x: 0, z: 0, b: i < 30 ? BTN.A1 : 0 }));
  assert.ok(sim.players[1].daze > 0, 'vault breaker hits');
  const sim2 = createSim({ mapId: 'grind', practice: true, players: [
    { id: 'a', name: 'A', champ: 'vi', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }, { id: 'c', name: 'C', champ: 'blitz', team: 2 }] });
  run(sim2, 90);
  lineUp(sim2, 0.95);
  const c = sim2.players[2], bt = torso(sim2, 1), ct = c.bodies[0].translation();
  for (const b of c.bodies) { const t = b.translation(); b.setTranslation({ x: t.x - ct.x + bt.x + 0.9, y: t.y, z: t.z - ct.z + bt.z }, true); }
  run(sim2, 30, i => sim2.setInput(0, { x: 0, z: 0, b: (i === 0 ? BTN.A2 : 0) | (i > 2 && i < 6 ? BTN.LEFT : 0) }));
  assert.ok(sim2.players[1].daze > 0 && c.daze > 0, `relentless force hits through (${sim2.players[1].daze}, ${c.daze})`);
  console.log('vi ok');
}

// 10. Sett: Haymaker cone, Facebreaker from both sides stuns
{
  const sim = createSim({ mapId: 'grind', practice: true, players: [
    { id: 'a', name: 'A', champ: 'sett', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }, { id: 'c', name: 'C', champ: 'blitz', team: 2 }] });
  run(sim, 90);
  lineUp(sim, 1.4);
  // Haymaker: hold to pour Grit in; full Grit hits far harder than none, and Sett stands still while charging
  sim.players[0].grit = 100;
  const hx = torso(sim, 0).x;
  let moved = 0;
  run(sim, 120, i => { sim.setInput(0, { x: 1, z: 0, b: i < 100 ? BTN.A1 : 0 }); if (i === 99) moved = torso(sim, 0).x - hx; });
  assert.ok(Math.abs(moved) < 0.3, `stands still while charging (${moved})`);
  assert.ok(sim.players[1].daze >= 70 || sim.players[1].ko > 0, `full haymaker hits hard (${sim.players[1].daze})`);
  assert.ok(sim.players[0].grit < 5, 'uses up the Grit');
  // C goes behind Sett, B in front: Facebreaker catches both and stuns
  lineUp(sim, 1.2);
  const c = sim.players[2], at = torso(sim, 0), ct = c.bodies[0].translation();
  for (const b of c.bodies) { const t = b.translation(); b.setTranslation({ x: t.x - ct.x + at.x - 1.2, y: t.y, z: t.z - ct.z + at.z }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
  run(sim, 200, () => sim.setInput(0, { x: 0, z: 0, b: 0 })); // cooldowns
  sim.players[0].cd = [0, 0]; sim.players[1].safe = sim.players[2].safe = 0;
  sim.setInput(0, { x: 0, z: 0, b: BTN.A2 }); sim.step();
  assert.ok(sim.players[1].stun > 1 && c.stun > 1, 'facebreaker from both sides stuns');
  console.log('sett ok');
}

// 11. a hooked champ goes limp and can't punch back
{
  const sim = near('blitz', 'vi');
  run(sim, 90);
  lineUp(sim, 4);
  sim.players[1].yaw = -Math.PI / 2;
  let punched = false;
  run(sim, 30, i => { sim.setInput(0, { x: 0, z: 0, b: i < 2 ? BTN.A1 : 0 }); sim.setInput(1, { x: 0, z: 0, b: i % 4 < 2 ? BTN.LEFT : 0 }); if (sim.players[1].hooked > 0 && sim.players[1].punch) punched = true; });
  assert.ok(!punched, 'no punching while hooked');
  console.log('hook lock ok');
}

// 12. client prediction: a local copy driven by my inputs tracks the host's copy of me, and catches up after a shove
{
  const players = [{ id: 'a', name: 'A', champ: 'blitz', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }];
  const host = createSim({ mapId: 'girders', players }), cli = createSim({ mapId: 'girders', players, local: 0 });
  // 200ms round trip with up to 100ms of jitter each way (messages stay in order, like the reliable channel)
  let seed = 3, lastAt = { host: 0, cli: 0 };
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const send = (to, m, i) => { const at = Math.max(lastAt[to], i + 12 + Math.floor(rnd() * 6)); lastAt[to] = at; wire.push({ ...m, to, at }); };
  const wire = [], q = [];
  let maxErr = 0;
  for (let i = 0; i < 400; i++) {
    const inp = { x: i > 200 ? 1 : 0, z: i % 120 < 60 ? -1 : 1, b: 0 };
    cli.setInput(0, inp); cli.step();
    q.push([inp.x, inp.z, inp.b]); if (q.length > 4) q.shift();
    if (cli.tick % 2 === 0) send('host', { inp: { n: cli.tick, i: [...q] } }, i);
    if (i === 300) for (const b of host.players[0].bodies) b.setLinvel({ x: 0, y: 3, z: 6 }, true); // a hit the client never saw
    for (const m of wire.filter(m => m.at === i)) m.to === 'host' ? host.setInput(0, m.inp) : cli.sync(m.s, m.s.p[0]);
    host.step();
    if (i % 2) send('cli', { s: JSON.parse(JSON.stringify(host.snapshot())) }, i);
    if (i > 150 && i < 300) maxErr = Math.max(maxErr, cli.err);
  }
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z), hp = host.players[0].bodies[0].translation(), cp = cli.players[0].bodies[0].translation();
  console.log('prediction err while walking', maxErr.toFixed(3), 'after shove', cli.err.toFixed(3), 'apart now', d(hp, cp).toFixed(2));
  assert.ok(maxErr < 0.15, 'prediction stays close');
  assert.ok(cli.err < 0.3, 'catches up with a hit it did not predict');
}

// 13. snapshot is small
{
  const sim = createSim({ mapId: 'girders', players: Array.from({ length: 8 }, (_, i) => ({ id: i, name: 'P', champ: i % 2 ? 'hec' : 'blitz', team: i })) });
  run(sim, 120);
  const bytes = JSON.stringify(sim.snapshot()).length;
  console.log('8p snapshot bytes', bytes);
  assert.ok(bytes < 5000);
  assert.ok(sim.players.every(p => p.alive), 'nobody falls off at spawn');
}
console.log('all ok');
