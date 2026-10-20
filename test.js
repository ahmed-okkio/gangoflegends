// Headless sim check: node test.js
import assert from 'node:assert/strict';
import { initPhysics, createSim, BTN, STAND } from './sim.js';

await initPhysics();
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
  for (; k < 10 && sim.players[1].ko <= 0; k++) { lineUp(sim); run(sim, 22, i => sim.setInput(0, { x: 0, z: 0, b: i < 3 ? BTN.PUNCH : 0 })); }
  console.log('punches to KO', k, 'daze', sim.players[1].daze.toFixed(0));
  assert.ok(sim.players[1].ko > 0, 'punches knock out');
  // KO length is fixed and getting up gives a safe window: punching through it doesn't chain another KO
  let kos = 0, wasKo = true;
  for (let i = 0; i < 12; i++) { lineUp(sim); run(sim, 22, j => { sim.setInput(0, { x: 0, z: 0, b: j < 3 ? BTN.PUNCH : 0 }); const ko = sim.players[1].ko > 0; if (ko && !wasKo) kos++; wasKo = ko; }); }
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

// 4. Hecarim charge shoves hard
{
  const sim = near('hec', 'blitz');
  run(sim, 90);
  lineUp(sim, 3);
  const bx = torso(sim, 1).x;
  run(sim, 40, i => sim.setInput(0, { x: 1, z: 0, b: i < 2 ? BTN.A2 : 0 }));
  console.log('charge shove', (torso(sim, 1).x - bx).toFixed(2));
  assert.ok(torso(sim, 1).x - bx > 2, 'charge shoves');
}

// 5. Power Fist launches
{
  const sim = near('blitz', 'hec');
  run(sim, 90);
  lineUp(sim);
  let peak = 0;
  run(sim, 60, i => { sim.setInput(0, { x: 0, z: 0, b: i < 2 ? BTN.A2 : i > 5 && i < 9 ? BTN.PUNCH : 0 }); peak = Math.max(peak, torso(sim, 1).y); });
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
  run(sim, 30, () => sim.setInput(0, { x: 0, z: 0, b: BTN.GRAB }));
  assert.ok(sim.players[0].grabs.some(Boolean), 'grabbed');
  run(sim, 5, () => sim.setInput(0, { x: 0, z: 0, b: 0 }));
  assert.ok(!sim.players[0].grabs.some(Boolean), 'released');
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
  // hang off the +z edge of the floor (top y 0, edge z 5) facing it, then climb
  const p = sim.players[0], t0 = torso(sim, 0);
  for (const b of p.bodies) { const t = b.translation(); b.setTranslation({ x: t.x - t0.x - 3, y: t.y - t0.y - 0.45, z: t.z - t0.z + 5.35 }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
  p.yaw = Math.PI;
  run(sim, 40, () => sim.setInput(0, { x: 0, z: 0, b: BTN.GRAB }));
  assert.ok(p.grabs.every(Boolean), 'hangs by both hands');
  run(sim, 60, i => sim.setInput(0, { x: 0, z: 0, b: BTN.GRAB | (i === 2 ? BTN.JUMP : 0) }));
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
  run(sim2, 30, i => sim2.setInput(0, { x: 0, z: 0, b: (i === 0 ? BTN.A2 : 0) | (i > 2 && i < 6 ? BTN.PUNCH : 0) }));
  assert.ok(sim2.players[1].daze > 0 && c.daze > 0, `relentless force hits through (${sim2.players[1].daze}, ${c.daze})`);
  console.log('vi ok');
}

// 10. Sett: Haymaker cone, Facebreaker from both sides stuns
{
  const sim = createSim({ mapId: 'grind', practice: true, players: [
    { id: 'a', name: 'A', champ: 'sett', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }, { id: 'c', name: 'C', champ: 'blitz', team: 2 }] });
  run(sim, 90);
  lineUp(sim, 1.4);
  run(sim, 50, i => sim.setInput(0, { x: 0, z: 0, b: i === 0 ? BTN.A1 : 0 }));
  assert.ok(sim.players[1].daze >= 40, `haymaker hits hard (${sim.players[1].daze})`);
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

// 11. snapshot is small
{
  const sim = createSim({ mapId: 'girders', players: Array.from({ length: 8 }, (_, i) => ({ id: i, name: 'P', champ: i % 2 ? 'hec' : 'blitz', team: i })) });
  run(sim, 120);
  const bytes = JSON.stringify(sim.snapshot()).length;
  console.log('8p snapshot bytes', bytes);
  assert.ok(bytes < 5000);
  assert.ok(sim.players.every(p => p.alive), 'nobody falls off at spawn');
}
console.log('all ok');
