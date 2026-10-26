// Headless sim check: node test.js
import assert from 'node:assert/strict';
import { initPhysics, createSim, BTN, STAND } from './sim.js';
import { prepareMap } from './stages.js';
import { packSnap, unpackSnap, b64, frame, unframe } from './wire.js';
import { HIPS } from './beast.js';

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

// a host and a client predicting `slot`, `ow` ticks apart each way. step(inp, hostSide) runs one tick of both; the client's
// inputs go up every tick (the last 6), snapshots and the host's events come down every tick (60Hz, like game.js)
function duo(mapId, players, slot, ow, extra = {}) {
  const { gb, ...opts } = extra, host = createSim({ mapId, players, ...opts }), cli = createSim({ mapId, players, local: slot, gb });
  const wire = [], q = [], d = { host, cli, i: 0, snaps: [], events: [] };
  d.step = (inp, hostSide) => {
    cli.setInput(slot, gb ? { ...inp, b: inp.b & ~BTN.LIFT } : inp); cli.step(); // as game.js GB_MODE
    q.push([inp.x, inp.z, inp.b, inp.a, inp.d]); if (q.length > 6) q.shift();
    wire.push({ to: 'host', at: d.i + ow, inp: { n: cli.tick, i: [...q] } });
    for (const m of wire.filter(m => m.at === d.i)) {
      if (m.to === 'host') host.setInput(slot, m.inp);
      else {
        cli.sync(m.s, m.s.p[slot]); d.snaps.push(m.s); d.events.push(...m.ev.map(e => [...e, d.i]));
        for (const e of m.s.p) cli.place(e[0], ...(e[1] ? [e[6], e[7], e[8]] : [0, -100, 0])); // stand-ins: as of arrival, no playback delay
      }
    }
    hostSide?.(host);
    host.step();
    wire.push({ to: 'cli', at: d.i + ow, s: JSON.parse(JSON.stringify(host.snapshot())), ev: host.takeEvents() });
    d.i++;
  };
  return d;
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
  for (; k < 10 && sim.players[1].ko <= 0; k++) { lineUp(sim); run(sim, 36, i => sim.setInput(0, { x: 0, z: 0, b: i < 3 ? (k % 2 ? BTN.RIGHT : BTN.LEFT) : 0 })); }
  console.log('punches to KO', k, 'daze', sim.players[1].daze.toFixed(0));
  assert.ok(sim.players[1].ko > 0, 'punches knock out');
  // KO length is fixed and getting up gives a safe window: punching through it doesn't chain another KO
  let kos = 0, wasKo = true;
  for (let i = 0; i < 12; i++) { lineUp(sim); run(sim, 22, j => { sim.setInput(0, { x: 0, z: 0, b: j < 3 ? BTN.LEFT : 0 }); const ko = sim.players[1].ko > 0; if (ko && !wasKo) kos++; wasKo = ko; }); }
  assert.ok(sim.players[1].ko <= 0 || kos > 0, 'KO does not last forever under punches');
  assert.ok(kos <= 1, `no chain KO right after waking (${kos})`);
}
// 2a. just up from a KO (safe): punches and hooks go through them, nothing heard; after 1s they land again
{
  const sim = near('blitz', 'hec'), hits = () => sim.takeEvents().filter(e => e[0] === 'hit').length;
  run(sim, 90);
  lineUp(sim, 0.9);
  sim.takeEvents();
  sim.players[1].safe = 1;
  run(sim, 22, i => sim.setInput(0, { x: 0, z: 0, b: i < 3 ? BTN.LEFT : 0 }));
  lineUp(sim, 4);
  run(sim, 30, i => sim.setInput(0, { x: 0, z: 0, b: i < 1 ? BTN.A1 : 0, a: Math.PI / 2 }));
  assert.ok(!hits() && sim.players[1].daze === 0 && !sim.snapshot().h.some(h => h[5]), 'safe: not hit, not hooked');
  run(sim, 20);
  lineUp(sim, 0.9);
  run(sim, 22, i => sim.setInput(0, { x: 0, z: 0, b: i < 3 ? BTN.LEFT : 0 }));
  assert.ok(hits() && sim.players[1].daze > 0, 'hit again once it wears off');
}

// 2b. punch aim assist: someone off to the side, but in front, still gets hit
{
  const sim = near('blitz', 'hec');
  run(sim, 90);
  lineUp(sim, 0.9);
  for (const b of sim.players[1].bodies) { const t = b.translation(); b.setTranslation({ x: t.x, y: t.y, z: t.z + 0.75 }, true); }
  run(sim, 22, i => sim.setInput(0, { x: 0, z: 0, b: i < 3 ? BTN.LEFT : 0 }));
  console.log('aim assist daze', sim.players[1].daze.toFixed(0));
  assert.ok(sim.players[1].daze > 0, 'punch tracks a target off to the side');
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
  assert.ok(sim.players[1].dizzy > 0 && sim.players[1].stun > 0 && sim.players[1].hooked <= 0 && sim.snapshot().p[1][3] & 256, 'stunned on their feet (stars) after the pull, not limp');
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

// 4b. Sylas Hijack steals the hit champ's Q; Abscond dashes, recast spins
{
  const sim = near('sylas', 'blitz');
  run(sim, 90);
  lineUp(sim, 5);
  run(sim, 40, i => sim.setInput(0, { x: 0, z: 0, b: i < 3 ? BTN.A1 : 0, a: Math.PI / 2, d: 5 }));
  assert.equal(sim.players[0].stole, 'blitz', 'hijack steals');
  assert.equal(sim.snapshot().sl[0], 'blitz', 'steal in snapshot');
  run(sim, 10, i => sim.setInput(0, { x: 0, z: 0, b: i < 2 ? BTN.A2 : 0 }));
  assert.ok(sim.players[0].empower > 0 && sim.players[0].emp === 'aoe' && sim.players[0].cd[1] > 6, 'abscond: dash, empowered, cooling at once');
  // Abduct: Abscond's recast throws the chains; the champ hit is stopped and Sylas flies in and knocks them back
  const s2 = near('sylas', 'blitz');
  run(s2, 90);
  lineUp(s2, 7);
  const bx = torso(s2, 1).x;
  let stopped = false, flew = false;
  run(s2, 90, i => {
    s2.setInput(0, { x: 0, z: 0, b: i < 2 || (i > 20 && i < 23) ? BTN.A2 : 0, a: Math.PI / 2 });
    if (s2.players[1].stun > 0.5) stopped = true;
    if (s2.players[0].leap?.sy) flew = true;
  });
  console.log('abduct shove', (torso(s2, 1).x - bx).toFixed(2), 'gap', (torso(s2, 1).x - torso(s2, 0).x).toFixed(2));
  assert.ok(stopped && flew, 'abduct: chains stop them and he flies in');
  assert.ok(torso(s2, 1).x - bx > 1, 'abduct knocks them back');
  console.log('sylas ok');
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
// 6a. the last two out within 0.5s of each other draw the round; 0.5s+ apart, the later one wins
for (const [gap, draw] of [[0.3, true], [0.7, false]]) {
  const sim = near('blitz', 'hec', { practice: false });
  run(sim, 180);
  const drop = slot => { for (const b of sim.players[slot].bodies) { const t = b.translation(); b.setTranslation({ x: t.x, y: t.y - 100, z: t.z }, true); } };
  drop(0);
  run(sim, Math.round(gap * 60));
  if (sim.players[1].alive) drop(1);
  run(sim, 40);
  const s = sim.snapshot();
  assert.ok(s.st === 'round' && (draw ? s.win === -1 && s.sc[1] === 0 : s.win === 1 && s.sc[1] === 1), `out ${gap}s apart: ${draw ? 'draw' : 'later one wins'} (${s.st}, win ${s.win})`);
}

// 7. grab sticks to a body and lets go
{
  const sim = near('blitz', 'hec');
  run(sim, 90);
  lineUp(sim, 0.95);
  run(sim, 30, () => sim.setInput(0, { x: 0, z: 0, b: (BTN.LEFT | BTN.RIGHT) }));
  assert.ok(sim.players[0].grabs.some(Boolean), 'grabbed');
  assert.ok(sim.snapshot().p.every(e => e[3] & 128), 'holder and held both flagged tied (clients follow the host)');
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
// 7a. grab assist: someone knocked down on the floor 1.2m off gets grabbed (the hands go for them, not the floor)
{
  const sim = near('blitz', 'hec'), [a, b] = sim.players;
  run(sim, 90);
  lineUp(sim, 0.9);
  b.daze = 99;
  run(sim, 22, i => sim.setInput(0, { x: 0, z: 0, b: i < 3 ? BTN.LEFT : 0 }));
  run(sim, 30, () => sim.setInput(0, { x: 0, z: 0, b: 0 }));
  const at = torso(sim, 0), bt = torso(sim, 1);
  for (const p of b.bodies) { const t = p.translation(); p.setTranslation({ x: t.x - bt.x + at.x + 1.2, y: t.y, z: t.z - bt.z + at.z }, true); p.setLinvel({ x: 0, y: 0, z: 0 }, true); }
  run(sim, 10);
  run(sim, 40, () => sim.setInput(0, { x: 0, z: 0, b: BTN.LEFT | BTN.RIGHT }));
  assert.ok(b.ko > 0 && a.grabs.some(g => g?.vic === b), `grabs someone down on the floor (${a.grabs.map(g => g ? (g.vic ? 'P' : 'F') : '-').join('')})`);
}

// 7b. lift: grab, hold lift and B goes up over A's head; let go of the hands and B is thrown
{
  const sim = near('blitz', 'hec');
  run(sim, 90);
  lineUp(sim, 0.95);
  run(sim, 30, () => sim.setInput(0, { x: 0, z: 0, b: BTN.LEFT | BTN.RIGHT }));
  run(sim, 60, () => sim.setInput(0, { x: 0, z: 0, b: BTN.LEFT | BTN.RIGHT | BTN.LIFT }));
  const up = torso(sim, 1).y - torso(sim, 0).y;
  assert.ok(up > 0.6, `lifted overhead (${up.toFixed(2)})`);
  assert.ok(upright(sim, 0) > 0.8, `lifter stays up (${upright(sim, 0).toFixed(2)})`);
  const x = torso(sim, 1).x;
  run(sim, 20, () => sim.setInput(0, { x: 0, z: 0, b: BTN.LIFT }));
  assert.ok(torso(sim, 1).x - x > 0.5, `thrown (${(torso(sim, 1).x - x).toFixed(2)})`);
  console.log('lift ok');
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
  for (const b of p.bodies) { const t = b.translation(); b.setTranslation({ x: t.x - t0.x - 3, y: t.y - t0.y, z: t.z - t0.z + 5.4 }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
  p.yaw = Math.PI;
  run(sim, 40, () => sim.setInput(0, { x: 0, z: 0, b: (BTN.LEFT | BTN.RIGHT) }));
  assert.ok(p.grabs.every(Boolean), 'hangs by both hands');
  // hold jump: hoists the chest up to the hands (its middle sits 0.25 above torso()) and stops there, legs hanging
  run(sim, 60, () => sim.setInput(0, { x: 0, z: 0, b: BTN.LEFT | BTN.RIGHT | BTN.JUMP }));
  const hipsY = p.bodies[HIPS].translation().y;
  assert.ok(p.grabs.every(Boolean) && Math.abs(torso(sim, 0).y + 0.2) < 0.15 && hipsY < torso(sim, 0).y - 0.1, `hoists up to the hands ${torso(sim, 0).y.toFixed(2)} hips ${hipsY.toFixed(2)}`);
  // push toward the ledge (-z): still holding on, the legs swing up over it; then let go onto it
  run(sim, 90, () => sim.setInput(0, { x: 0, z: -1, b: BTN.LEFT | BTN.RIGHT | BTN.JUMP }));
  assert.ok(p.grabs.every(Boolean) && p.bodies[HIPS].translation().y > 0.1, `swings the legs up over the edge ${p.bodies[HIPS].translation().y.toFixed(2)}`);
  run(sim, 60, () => sim.setInput(0, { x: 0, z: -1, b: 0 }));
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
  // Haymaker: a full windup hits hard, and Sett stands still while winding up
  const hx = torso(sim, 0).x;
  let moved = 0;
  run(sim, 120, i => { sim.setInput(0, { x: 1, z: 0, b: i < 100 ? BTN.A1 : 0 }); if (i === 99) moved = torso(sim, 0).x - hx; });
  assert.ok(Math.abs(moved) < 0.3, `stands still while charging (${moved})`);
  assert.ok(sim.players[1].daze >= 70 || sim.players[1].ko > 0, `full haymaker hits hard (${sim.players[1].daze})`);
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

// 10a. Sett's Facebreaker, timed right, stops Vi's Vault Breaker dash mid-flight
{
  const sim = near('sett', 'vi');
  run(sim, 90);
  lineUp(sim, 5);
  const vi = sim.players[1];
  vi.yaw = -Math.PI / 2;
  run(sim, 40, () => sim.setInput(1, { x: 0, z: 0, b: BTN.A1, a: -Math.PI / 2 })); // wind up
  sim.setInput(1, { x: 0, z: 0, b: 0, a: -Math.PI / 2 });
  let stopped = false;
  for (let i = 0; i < 40 && !stopped; i++) {
    const near2 = Math.abs(torso(sim, 1).x - torso(sim, 0).x) < 2;
    sim.setInput(0, { x: 0, z: 0, b: near2 ? BTN.A2 : 0 });
    sim.step();
    if (near2 && sim.players[0].cd[1] > 0) stopped = !vi.dash && vi.stun > 0;
  }
  assert.ok(stopped, 'Facebreaker cancels the dash');
}

// 10b. Sett's Haymaker windup doesn't flinch from punches
{
  const sim = near('sett', 'blitz');
  run(sim, 90);
  lineUp(sim, 1.1);
  sim.players[1].yaw = -Math.PI / 2;
  let hits = 0;
  run(sim, 60, i => {
    sim.setInput(0, { x: 0, z: 0, b: BTN.A1 });
    sim.setInput(1, { x: 0, z: 0, b: i % 6 < 2 ? BTN.LEFT : 0 });
    if (sim.players[0].sinceHit === 0) hits++;
  });
  const s = sim.players[0];
  console.log('haymaker took hits', hits, 'daze', s.daze.toFixed(0));
  assert.ok(hits > 0 && s.hay > 0 && s.ko <= 0, 'still winding up after being punched');
}

// 10c. switching champ: right away in practice, next round in a match
{
  const sim = near('blitz', 'hec');
  run(sim, 30);
  sim.setChamp(0, 'sett');
  assert.ok(sim.players[0].champ === 'sett' && sim.players[0].alive && sim.snapshot().ch[0] === 'sett', 'practice: swapped now');
  const m = createSim({ mapId: 'girders', players: [{ id: 'a', name: 'A', champ: 'blitz', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }] });
  m.setChamp(0, 'vi');
  assert.ok(m.players[0].champ === 'blitz', 'match: not until the next round');
}

// 10d. Alistar: Pulverize launches whoever's close; Headbutt knocks them back, much further while they're airborne
{
  const knock = combo => {
    const sim = near('ali', 'blitz');
    run(sim, 90);
    lineUp(sim, 1.3);
    const x0 = torso(sim, 1).x;
    let peak = 0;
    if (combo) { run(sim, 2, i => sim.setInput(0, { x: 0, z: 0, b: i ? 0 : BTN.A1 })); run(sim, 10, () => { sim.setInput(0, { x: 0, z: 0, b: 0 }); peak = Math.max(peak, torso(sim, 1).y); }); }
    run(sim, 2, i => sim.setInput(0, { x: 0, z: 0, b: i ? 0 : BTN.A2 }));
    run(sim, 50, () => { sim.setInput(0, { x: 0, z: 0, b: 0 }); peak = Math.max(peak, torso(sim, 1).y); });
    return { peak, dist: torso(sim, 1).x - x0 };
  };
  const solo = knock(false), combo = knock(true);
  console.log('alistar headbutt', solo.dist.toFixed(2), 'after pulverize', combo.dist.toFixed(2), 'launch peak', combo.peak.toFixed(2));
  assert.ok(combo.peak > STAND + 0.8, 'Pulverize launches');
  assert.ok(solo.dist > 1.5, 'Headbutt knocks back');
  assert.ok(combo.dist > solo.dist * 1.3, 'Headbutt after Pulverize knocks much further');
}

// 10e. Thresh: the hook tugs its target a little toward him and chains them; recast leaps him to them. Flay knocks
// whoever's in the line the way he aimed: away in front, toward him behind
{
  const tap = (sim, b, a) => run(sim, 2, i => sim.setInput(0, { x: 0, z: 0, b: i ? 0 : b, a }));
  let sim = near('thresh', 'blitz');
  run(sim, 90);
  lineUp(sim, 5);
  const gap0 = torso(sim, 1).x - torso(sim, 0).x;
  tap(sim, BTN.A1, Math.PI / 2);
  run(sim, 30, () => sim.setInput(0, { x: 0, z: 0, b: 0 }));
  const gap1 = torso(sim, 1).x - torso(sim, 0).x;
  assert.ok(sim.players[0].tether === 1 && gap1 < gap0 - 0.8 && gap1 > 2, `hooked, tugged a little (${gap0.toFixed(2)} -> ${gap1.toFixed(2)}), chained`);
  tap(sim, BTN.A1, Math.PI / 2);
  run(sim, 30, () => sim.setInput(0, { x: 0, z: 0, b: 0 }));
  const gap2 = torso(sim, 1).x - torso(sim, 0).x;
  assert.ok(sim.players[0].tether == null && gap2 < gap1 - 1, `recast leaps to them (${gap2.toFixed(2)})`);
  sim = near('thresh', 'blitz'); // recast while the hook's still flying (pressed a ping early): leaps the moment it catches
  run(sim, 90);
  lineUp(sim, 5);
  tap(sim, BTN.A1, Math.PI / 2);
  run(sim, 3, () => sim.setInput(0, { x: 0, z: 0, b: 0 }));
  tap(sim, BTN.A1, Math.PI / 2);
  run(sim, 40, () => sim.setInput(0, { x: 0, z: 0, b: 0 }));
  assert.ok(torso(sim, 1).x - torso(sim, 0).x < 2, `an early recast still leaps (${(torso(sim, 1).x - torso(sim, 0).x).toFixed(2)})`);
  sim = near('thresh', 'blitz');
  run(sim, 90);
  lineUp(sim, 2.5);
  const far = torso(sim, 1).x - torso(sim, 0).x;
  tap(sim, BTN.A2, Math.PI / 2);
  run(sim, 40, () => sim.setInput(0, { x: 0, z: 0, b: 0 }));
  assert.ok(torso(sim, 1).x - torso(sim, 0).x > far + 0.5, 'Flay aimed at them pushes them away');
  sim = near('thresh', 'blitz');
  run(sim, 90);
  lineUp(sim, 1.5);
  const before = torso(sim, 1).x;
  tap(sim, BTN.A2, -Math.PI / 2); // aimed away from them
  run(sim, 40, () => sim.setInput(0, { x: 0, z: 0, b: 0 }));
  assert.ok(torso(sim, 1).x < before - 0.3, 'Flay aimed away draws them toward him');
  console.log('thresh ok', gap0.toFixed(2), gap1.toFixed(2), gap2.toFixed(2));
}

// 10f. Lee Sin: the wave marks whoever it hits without hurting them; recast flies him to them and knocks them back.
// Dragon's Rage kicks the champ in front back, and whoever they crash into goes too
{
  const tap = (sim, b, a) => run(sim, 2, i => sim.setInput(0, { x: 0, z: 0, b: i ? 0 : b, a }));
  const idle = sim => () => sim.setInput(0, { x: 0, z: 0, b: 0 });
  let sim = near('lee', 'blitz');
  run(sim, 90);
  lineUp(sim, 5);
  const [lee, b] = sim.players, x0 = torso(sim, 1).x;
  tap(sim, BTN.A1, Math.PI / 2);
  run(sim, 30, idle(sim));
  assert.ok(lee.tether === 1 && b.daze === 0 && Math.abs(torso(sim, 1).x - x0) < 0.3, `marked, unhurt, not moved (${b.daze}, ${(torso(sim, 1).x - x0).toFixed(2)})`);
  assert.ok(lee.cd[0] === 6, 'Q cooldown waits on the mark');
  tap(sim, BTN.A1, Math.PI / 2);
  run(sim, 50, idle(sim));
  const gap = torso(sim, 1).x - torso(sim, 0).x;
  assert.ok(lee.tether == null && torso(sim, 1).x > x0 + 1 && torso(sim, 0).x > x0 - 3 && b.daze === 0, `flies to them, knocks them back (${(torso(sim, 1).x - x0).toFixed(2)}, gap ${gap.toFixed(2)})`);
  sim = near('lee', 'blitz'); // left marked, it wears off after 3s
  run(sim, 90);
  lineUp(sim, 5);
  tap(sim, BTN.A1, Math.PI / 2);
  run(sim, 200, idle(sim));
  assert.ok(sim.players[0].tether == null && sim.players[0].cd[0] < 6 && sim.players[0].cd[0] > 5, 'the mark wears off, then Q cools');
  sim = near('lee', 'blitz'); // aimed behind him: he turns round first, then the wave goes out behind
  run(sim, 90);
  lineUp(sim, 5);
  tap(sim, BTN.A1, -Math.PI / 2);
  const early = sim.snapshot().h.length;
  run(sim, 25, idle(sim));
  const [w] = sim.snapshot().h;
  assert.ok(!early && w && w[1] < torso(sim, 0).x - 0.5, `turns first, then fires behind (${early}, ${w?.[1].toFixed(2)} vs ${torso(sim, 0).x.toFixed(2)})`);
  sim = createSim({ mapId: 'grind', practice: true, players: [
    { id: 'a', name: 'A', champ: 'lee', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }, { id: 'c', name: 'C', champ: 'blitz', team: 2 }] });
  run(sim, 90);
  lineUp(sim, 1.2);
  const c = sim.players[2], bt = torso(sim, 1), ct = c.bodies[0].translation(), bx = bt.x, cx = bt.x + 1.5;
  for (const p of c.bodies) { const t = p.translation(); p.setTranslation({ x: t.x - ct.x + cx, y: t.y, z: t.z - ct.z + bt.z }, true); }
  run(sim, 20, idle(sim));
  tap(sim, BTN.A2);
  run(sim, 40, idle(sim));
  assert.ok(sim.players[1].daze > 0 && torso(sim, 1).x > bx + 1.5, `kicks them back (${(torso(sim, 1).x - bx).toFixed(2)})`);
  assert.ok(c.daze > 0 && torso(sim, 2).x > cx + 0.5, `and whoever they crash into (${c.daze}, ${(torso(sim, 2).x - cx).toFixed(2)})`);
  console.log('lee ok', gap.toFixed(2));
}

// 10f. Singed: glue slows and grounds whoever's in it; Fling throws the champ beside him over to his other side
{
  let sim = near('singed', 'blitz');
  run(sim, 90);
  lineUp(sim, 5);
  run(sim, 2, i => sim.setInput(0, { x: 0, z: 0, b: i ? 0 : BTN.A1, a: Math.PI / 2 }));
  const x0 = torso(sim, 1).x;
  run(sim, 60, () => { sim.setInput(0, { x: 0, z: 0, b: 0 }); sim.setInput(1, { x: 1, z: 0, b: BTN.JUMP }); });
  const slow = torso(sim, 1).x - x0;
  assert.ok(sim.snapshot().g.length === 1 && slow < 1.6, `glued: slow (${slow.toFixed(2)}m in 1s)`);
  run(sim, 2, i => sim.setInput(1, { x: 0, z: 0, b: i ? 0 : BTN.A2 }));
  assert.ok(sim.players[1].cd[1] === 0, 'no abilities in enemy glue');
  sim = near('singed', 'blitz');
  run(sim, 90);
  lineUp(sim, 1.1);
  run(sim, 2, i => sim.setInput(0, { x: 0, z: 0, b: i ? 0 : BTN.A2 }));
  run(sim, 50, () => sim.setInput(0, { x: 0, z: 0, b: 0 }));
  console.log('fling lands', (torso(sim, 0).x - torso(sim, 1).x).toFixed(2), 'm behind');
  assert.ok(torso(sim, 1).x < torso(sim, 0).x, 'Fling throws them to his other side');
  sim = near('singed', 'blitz');
  run(sim, 90);
  run(sim, 2, i => sim.setInput(0, { x: 0, z: 0, b: i ? 0 : BTN.A1, a: 0, d: 0 })); // cursor on himself
  const [g] = sim.snapshot().g, me0 = torso(sim, 0);
  assert.ok(g && Math.hypot(g[0] - me0.x, g[2] - me0.z) < 0.3, 'glue can go right under Singed');
  console.log('singed ok', slow.toFixed(2));
}

// 10g. running (double-tapped move key) is faster than walking
{
  const walk = b => { const sim = near('blitz', 'hec'); run(sim, 90); lineUp(sim, 12); const x0 = torso(sim, 0).x; run(sim, 40, () => sim.setInput(0, { x: 1, z: 0, b })); return torso(sim, 0).x - x0; };
  const w = walk(0), r = walk(BTN.RUN);
  console.log('walk', w.toFixed(2), 'run', r.toFixed(2));
  assert.ok(r > w * 1.15, 'running is faster');
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
  let maxErr = 0, postErr = 0, postN = 0;
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
    if (i > 320) { postErr += cli.err; postN++; }
  }
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z), hp = host.players[0].bodies[0].translation(), cp = cli.players[0].bodies[0].translation();
  console.log('prediction err while walking', maxErr.toFixed(3), 'after shove', (postErr / postN).toFixed(3), 'apart now', d(hp, cp).toFixed(2));
  assert.ok(maxErr < 0.15, 'prediction stays close');
  // it's walking off the girder, ~0.5s ahead of the host, so the two drift; moderate drift is pulled in gradually (sync())
  assert.ok(postErr / postN < 0.6, 'catches up with a hit it did not predict');
}

// 12b. a client holding a champ (and holding jump) stays on the host's state instead of being flung about
{
  const players = [{ id: 'a', name: 'A', champ: 'blitz', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }];
  const host = createSim({ mapId: 'grind', players }), cli = createSim({ mapId: 'grind', players, local: 0 });
  const G = BTN.LEFT | BTN.RIGHT, wire = [], q = [];
  let maxErr = 0;
  for (let i = 0; i < 450; i++) {
    if (i === 160) {
      for (const [slot, x] of [[0, -4], [1, -3.05]]) {
        const p = host.players[slot], dx = x - p.bodies[0].translation().x, dz = 3 - p.bodies[0].translation().z;
        for (const b of p.bodies) { const t = b.translation(); b.setTranslation({ x: t.x + dx, y: t.y, z: t.z + dz }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
      }
      host.players[0].yaw = Math.PI / 2; host.players[1].yaw = -Math.PI / 2;
    }
    const b = i > 170 ? G | (i > 260 ? BTN.JUMP : 0) : 0, inp = { x: 0, z: 0, b, a: i > 160 ? Math.PI / 2 : null };
    cli.setInput(0, inp); cli.step();
    q.push([inp.x, inp.z, inp.b, inp.a]); if (q.length > 6) q.shift();
    if (cli.tick % 2 === 0) wire.push({ to: 'host', at: i + 10, inp: { n: cli.tick, i: [...q] } });
    for (const m of wire.filter(m => m.at === i)) m.to === 'host' ? host.setInput(0, m.inp) : cli.sync(m.s, m.s.p[0]);
    host.setInput(1, { x: 0, z: 0, b });
    host.step();
    if (i % 2) wire.push({ to: 'cli', at: i + 10, s: JSON.parse(JSON.stringify(host.snapshot())) });
    if (i > 300) maxErr = Math.max(maxErr, cli.err);
  }
  console.log('tied err', maxErr.toFixed(2));
  assert.ok(host.players[0].grabs.some(g => g?.vic) && maxErr < 0.3, 'held together, the client stays on the host');
}

// 12c. a knock-up the client never saw coming (host Alistar's Pulverize, 200ms round trip) still lifts its own copy
// nearly as high as the host's (it used to rise late and low, then the hover spring ate the rest)
{
  const players = [{ id: 'a', name: 'A', champ: 'ali', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }];
  const host = createSim({ mapId: 'grind', players, practice: true }), cli = createSim({ mapId: 'grind', players, local: 1 });
  const A = host.players[0], b0 = host.players[1].bodies[0].translation(), a0 = A.bodies[0].translation();
  for (const b of A.bodies) { const t = b.translation(); b.setTranslation({ x: t.x + b0.x - 1.2 - a0.x, y: t.y, z: t.z + b0.z - a0.z }, true); }
  const wire = [], q = [];
  let hostPeak = 0, cliPeak = 0;
  for (let i = 0; i < 300; i++) {
    cli.setInput(1, { x: 0, z: 0, b: 0 }); cli.step();
    q.push([0, 0, 0]); if (q.length > 6) q.shift();
    if (cli.tick % 2 === 0) wire.push({ to: 'host', at: i + 6, inp: { n: cli.tick, i: [...q] } });
    for (const m of wire.filter(m => m.at === i)) m.to === 'host' ? host.setInput(1, m.inp) : cli.sync(m.s, m.s.p[1]);
    host.setInput(0, { x: 0, z: 0, b: i === 120 ? BTN.A1 : 0 });
    host.step();
    if (i % 2) wire.push({ to: 'cli', at: i + 6, s: JSON.parse(JSON.stringify(host.snapshot())) });
    if (i >= 120) { hostPeak = Math.max(hostPeak, host.players[1].bodies[10].translation().y); cliPeak = Math.max(cliPeak, cli.snapshot().p[1][7]); }
  }
  console.log('pulverize peak host', hostPeak.toFixed(2), 'client', cliPeak.toFixed(2));
  assert.ok(hostPeak > 1.5 && cliPeak - 0.41 > 0.8 * (hostPeak - 0.41), 'the client sees its own knock-up');
}

// 12d. at 400ms round trip a client's cooldown comes back when it should, not a round trip late
{
  const d = duo('grind', [{ id: 'a', name: 'A', champ: 'blitz', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }], 0, 12, { practice: true });
  let ready = -1;
  for (let i = 0; i < 500; i++) {
    d.step({ x: 0, z: 0, b: i === 100 ? BTN.A2 : 0 }); // Power Fist, 5s
    if (i > 100 && ready < 0 && d.cli.players[0].cd[1] <= 0) ready = i;
  }
  console.log('cooldown back after', ((ready - 100) / 60).toFixed(2), 's');
  assert.ok(d.host.players[0].empower > 0 || d.host.players[0].cd[1] < 5, 'the host cast it too');
  assert.ok(ready > 0 && (ready - 100) / 60 < 5.1, 'cooldown not held up by the ping');
}

// 12e. a client's own punch shows its hit at once; the host's copy says who hit whom (game.js skips it, having played it)
{
  const d = duo('grind', [{ id: 'a', name: 'A', champ: 'blitz', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }], 0, 12, { practice: true });
  const mine = [];
  for (let i = 0; i < 320; i++) {
    if (i === 150) for (const [slot, x] of [[0, -4], [1, -3]]) {
      const p = d.host.players[slot], t0 = p.bodies[0].translation();
      for (const b of p.bodies) { const t = b.translation(); b.setTranslation({ x: t.x + x - t0.x, y: t.y, z: t.z + 3 - t0.z }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
    }
    d.step({ x: i >= 190 && i < 196 ? 1 : 0, z: 0, b: i >= 200 && i < 203 ? BTN.LEFT : 0 });
    mine.push(...d.cli.takeEvents().filter(e => e[0] === 'hit').map(e => [...e, i]));
  }
  const host = d.events.find(e => e[0] === 'hit');
  console.log('own hit shown at tick', mine[0]?.[7], 'host copy arrives', host?.[7]);
  assert.ok(mine.length && mine[0][5] === 0 && mine[0][6] === 1, 'my copy plays my hit on the stand-in');
  assert.ok(host && host[5] === 0 && host[6] === 1 && host[7] - mine[0][7] >= 20, 'the host saw it too, a round trip later');
}

// 12f. a client's own hook flies on its copy at once and catches the stand-in; a Thresh recast then leaps there before
// the host's catch has come back (the host leaps too)
{
  const d = duo('grind', [{ id: 'a', name: 'A', champ: 'thresh', team: 0 }, { id: 'b', name: 'B', champ: 'hec', team: 1 }], 0, 12, { practice: true });
  let flew = -1, caught = -1, hostCaught = -1;
  const gaps = []; // my copy's distance to their stand-in (placed at x = 1)
  for (let i = 0; i < 320; i++) {
    if (i === 150) for (const [slot, x] of [[0, -4], [1, 1]]) {
      const p = d.host.players[slot], t0 = p.bodies[0].translation();
      for (const b of p.bodies) { const t = b.translation(); b.setTranslation({ x: t.x + x - t0.x, y: t.y, z: t.z + 3 - t0.z }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
    }
    d.step({ x: 0, z: 0, b: i === 200 || i === 216 ? BTN.A1 : 0, a: Math.PI / 2 });
    const h = d.cli.snapshot().h.find(h => h[0] === 0);
    if (h && flew < 0) flew = i;
    if (h?.[5] && caught < 0) caught = i;
    if (hostCaught < 0 && d.snaps.at(-1)?.h.some(h => h[0] === 0 && h[5])) hostCaught = i;
    gaps.push(1 - (d.cli.players[0].bodies?.[0].translation().x ?? -9));
  }
  const hostGap = d.host.players[1].bodies[0].translation().x - d.host.players[0].bodies[0].translation().x, leapGap = gaps[hostCaught - 1];
  console.log('own hook flies at', flew, 'caught', caught, 'host catch arrives', hostCaught, '| my copy that close by then:', leapGap.toFixed(2), 'host gap', hostGap.toFixed(2));
  assert.ok(flew === 201 && caught > flew && caught < hostCaught, 'my hook flies and catches on my copy first');
  assert.ok(leapGap < 2.2 && hostGap < 2, 'the recast leaps on my copy before the host says it caught, and on the host');
}

// 12g. lag compensation: a client whose screen showed a walking target 0.25s late hooks where it saw it, and catches it;
// the same throw from a client with nothing to make up for misses (the target has walked on)
{
  const tryHook = late => {
    const sim = near('blitz', 'hec');
    run(sim, 90);
    for (const [slot, x, z] of [[0, -4, 3.5], [1, 1, 1.6]]) {
      const p = sim.players[slot], t0 = p.bodies[0].translation();
      for (const b of p.bodies) { const t = b.translation(); b.setTranslation({ x: t.x + x - t0.x, y: t.y, z: t.z + z - t0.z }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
    }
    const A = sim.players[0], B = sim.players[1], path = [];
    let n = 0, caught = false;
    for (let i = 0; i < 70; i++) {
      // on that client's screen B is 15 steps back, and walks on while the hook flies (~10 steps): it aims at B 5 steps ago
      const seenB = path.at(-5), a = seenB && Math.atan2(seenB.x - torso(sim, 0).x, seenB.z - torso(sim, 0).z);
      const b = i === 30 ? BTN.A1 : 0, v = late ? sim.snapshot().mt - 15 / 60 : null;
      sim.setInput(0, { n: ++n, i: [[0, 0, b, i >= 30 ? a : null, null, v]] });
      sim.setInput(1, { x: 0, z: 1, b: 0 });
      sim.step();
      path.push(torso(sim, 1));
      if (B.hooked > 0) caught = true;
    }
    return caught;
  };
  const withComp = tryHook(true), without = tryHook(false);
  console.log('hook on a walking target seen 0.25s late:', withComp ? 'caught' : 'missed', '| no lag to make up:', without ? 'caught' : 'missed');
  assert.ok(withComp && !without, 'abilities land where the caster saw the target');
}

// 12h. GB mode: my own moves play on my copy at once (a charge carries only me) and the host's agrees
{
  const d = duo('grind', [{ id: 'a', name: 'A', champ: 'hec', team: 0 }, { id: 'b', name: 'B', champ: 'blitz', team: 1 }], 0, 12, { practice: true, gb: true });
  let owned = 0, charged = -1, hostCharged = 0, worst = 0;
  for (let i = 0; i < 500; i++) {
    d.step({ x: 0, z: 0, b: i === 100 ? BTN.A2 : 0 }); // Devastating Charge
    owned += !!d.cli.players[0].hostOwned; hostCharged += d.host.players[0].charge > 0;
    if (charged < 0 && d.cli.players[0].charge > 0) charged = i;
    if (i > 100) worst = Math.max(worst, d.cli.err);
  }
  console.log('GB mode: own charge starts at tick', charged, '| host-owned', owned, 'ticks | worst correction', worst.toFixed(2));
  assert.ok(charged === 100 && hostCharged && !owned, 'my copy charges at once, the host too, and never takes my body');
  // walking on after it: ponytail: not checked, walking into the other champ's ragdoll corrects ~1m either way (was so before)
  assert.ok(worst < 0.5, 'my charge and the host agree');
}
{ // aiming turns my copy round too: my arms are drawn from the host, whose me turned to cast (Lee's Q tapped behind him)
  const d = duo('grind', [{ id: 'a', name: 'A', champ: 'lee', team: 0 }, { id: 'b', name: 'B', champ: 'blitz', team: 1 }], 0, 12, { practice: true, gb: true });
  for (let i = 0; i < 200; i++) d.step({ x: i > 100 && i < 115 ? 1 : 0, z: 0, b: i > 130 && i < 136 ? BTN.A1 : 0, a: -Math.PI / 2 });
  const fwd = s => { const q = s.players[0].bodies[0].rotation(); return 2 * (q.x * q.z + q.w * q.y); }; // the chest's facing, along x
  assert.ok(fwd(d.cli) < -0.7 && fwd(d.host) < -0.7 && !d.cli.snapshot().h.length && d.host.players[0].cd[0] > 0,
    `both face the aim, only the host cast (${fwd(d.cli).toFixed(2)}, ${fwd(d.host).toFixed(2)})`);
}

// 13. snapshot is small
{
  const sim = createSim({ mapId: 'girders', players: Array.from({ length: 8 }, (_, i) => ({ id: i, name: 'P', champ: i % 2 ? 'hec' : 'blitz', team: i })) });
  run(sim, 120);
  const bytes = JSON.stringify(sim.snapshot()).length;
  // on the wire (wire.js): packed binary, every field back as sim.js rounded it, rotations turned the same to within half a degree (10 bits a component: ~0.1)
  // two ways: as JSON with the block in base64 (the relay), and as one binary frame (the fast channel)
  const snap = sim.snapshot(), wire = JSON.stringify(packSnap(snap), b64), back = unpackSnap(JSON.parse(wire)), fr = frame({ t: 'snap', s: packSnap(snap) });
  console.log('8p snapshot bytes', bytes, 'as JSON', wire.length, 'as a frame', fr.byteLength);
  assert.ok(bytes < 5000 && wire.length < bytes * 0.55 && fr.byteLength < wire.length * 0.85);
  assert.deepEqual(unpackSnap(unframe(fr).s).p, back.p, 'frame and JSON agree');
  assert.deepEqual(unframe(frame({ t: 'in', n: 3 })), { t: 'in', n: 3 }, 'plain messages go as JSON');
  assert.deepEqual(back.p.map(e => e.length), snap.p.map(e => e.length));
  for (const [i, e] of snap.p.entries()) for (let k = 0; k < e.length; k++) {
    if (k < 9 || k >= e.length - 9) assert.ok(back.p[i][k] === e[k], `field ${k}`); // (=== : JSON makes -0 a 0)
    else if ((k - 9) % 4 === 0) { // the same turn: the rounded original isn't quite unit length
      const q = [0, 1, 2, 3].map(j => e[k + j]), dot = q.reduce((t, c, j) => t + c * back.p[i][k + j], 0) / Math.hypot(...q);
      assert.ok(Math.abs(dot) > 1 - 1e-5, `part ${(k - 9) / 4} turned`);
    }
  }
  assert.ok(sim.players.every(p => p.alive), 'nobody falls off at spawn');
}

// 15. aiming: Rocket Grab goes off on release, toward the cursor's yaw, and turns the champ to it while held
{
  const sim = near('blitz', 'hec');
  run(sim, 90);
  run(sim, 20, () => sim.setInput(0, { x: 0, z: 0, b: BTN.A1, a: 2 }));
  const p = sim.players[0];
  assert.ok(Math.abs(p.yaw - 2) < 1e-6 && p.cd[0] === 0, 'aims while held, not cast yet');
  run(sim, 1, () => sim.setInput(0, { x: 0, z: 0, b: 0, a: 2 }));
  assert.ok(p.cd[0] > 0, 'casts on release');
  console.log('aim ok');
}

// 14. Incinerator (when imported): nobody spawns over the pit, the belts carry you into it
if ((await prepareMap('incinerator')).imported) {
  const sim = createSim({ mapId: 'incinerator', players: Array.from({ length: 8 }, (_, i) => ({ id: i, name: 'P', champ: 'blitz', team: i })) });
  run(sim, 120);
  assert.ok(sim.players.every(p => p.alive), 'nobody spawns over the pit');
  const p = sim.players[0], t0 = torso(sim, 0);
  for (const b of p.bodies) { const t = b.translation(); b.setTranslation({ x: t.x - t0.x + 9.5, y: t.y + 0.3, z: t.z - t0.z - 5 }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
  run(sim, 120);
  console.log('belt carried', (9.5 - torso(sim, 0).x).toFixed(2));
  assert.ok(torso(sim, 0).x < 8.5, 'belt rolls you toward the pit');
}
// 15. Subway (when imported): a train comes down the track, carries whoever's on it into the tunnel and they're out
if ((await prepareMap('subway')).imported) {
  const { trainsAt, MAPS } = await import('./maps.js');
  const sim = createSim({ mapId: 'subway', players: [0, 1].map(i => ({ id: i, name: 'P', champ: 'blitz', team: i })) });
  let t = 0; while (!trainsAt(MAPS.subway, t).some(o => o.k === 0)) t += 1 / 60; // the first train on the back track (z 6, running +x)
  run(sim, Math.ceil((t + 1.5) * 60) - 1);
  const p = sim.players[0], t0 = torso(sim, 0);
  for (const b of p.bodies) { const q = b.translation(); b.setTranslation({ x: q.x - t0.x, y: q.y - t0.y - 0.6, z: q.z - t0.z + 6 }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
  let out = false;
  for (let i = 0; i < 240 && !out; i++) { sim.step(); out = !p.alive; }
  assert.ok(out, 'a train carries you into the tunnel');
  console.log('subway train ok');
}
// 16. Trawler (when imported): overboard you float and can swim a while, then tire and sink out; held under, sooner
if ((await prepareMap('trawler')).imported) {
  const sea = (await import('./maps.js')).MAPS.trawler.view.sea;
  const sim = createSim({ mapId: 'trawler', practice: true, players: [0, 1].map(i => ({ id: i, name: 'P', champ: 'blitz', team: i })) });
  const dropAt = (slot, x, z) => { const p = sim.players[slot], t0 = torso(sim, slot); for (const b of p.bodies) { const q = b.translation(); b.setTranslation({ x: q.x - t0.x + x, y: q.y - t0.y + sea + 0.5, z: q.z - t0.z + z }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); } };
  dropAt(0, 0, 9); dropAt(1, 3, 12);
  sim.setInput(0, { x: 1, z: 0, b: 0 });
  run(sim, 180);
  const a = sim.players[0];
  assert.ok(a.alive && Math.abs(torso(sim, 0).y - sea) < 0.6, `floats at the surface: ${torso(sim, 0).y.toFixed(2)}`);
  assert.ok(torso(sim, 0).x > 2, `swims: ${torso(sim, 0).x.toFixed(2)}`);
  let t = 3; while (a.alive && t < 80) { sim.step(); t += 1 / 60; }
  console.log('swam, tired and sank out after', t.toFixed(1), 's');
  assert.ok(!a.alive && t > 30 && t < 70, 'tires and sinks out');
  // B (fresh, treading water) held under by A from above
  run(sim, 100); // A back in practice
  dropAt(0, 3, 12.8); dropAt(1, 3, 12);
  const b = sim.players[1]; b.stamina = 100; a.stamina = 100;
  for (const bd of a.bodies) { const q = bd.translation(); bd.setTranslation({ x: q.x, y: q.y + 0.4, z: q.z }, true); }
  a.yaw = Math.PI; sim.setInput(0, { x: 0, z: 0, b: BTN.LEFT | BTN.RIGHT }); // facing B, both hands out
  let u = 0; while (b.alive && u < 20) { sim.step(); u += 1 / 60; }
  console.log('held under: out after', u.toFixed(1), 's, grabbed', a.grabs.some(g => g?.vic === b));
  assert.ok(!b.alive && u < 9, 'held under you drown quicker');
}
console.log('all ok');

// 12j. GB mode: my copy plays my own punch and Vi's windup at once (for show); the host still does the hitting
{
  const d = duo('grind', [{ id: 'a', name: 'A', champ: 'vi', team: 0 }, { id: 'b', name: 'B', champ: 'blitz', team: 1 }], 0, 12, { practice: true, gb: true });
  let punched = false, wound = false;
  for (let i = 0; i < 200; i++) {
    d.step({ x: 0, z: 0, b: i === 60 ? BTN.LEFT : i >= 120 && i < 150 ? BTN.A1 : 0 });
    punched ||= !!d.cli.players[0].punch; wound ||= d.cli.players[0].vault > 0 && !d.cli.players[0].hostOwned;
  }
  assert.ok(punched && wound, 'my copy punched and wound up Vault Breaker itself');
  console.log('GB mode: own punch and windup predicted');
}
