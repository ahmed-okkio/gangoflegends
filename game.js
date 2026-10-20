// App flow: menu -> lobby -> match. The host (or practice) runs the sim; clients send input and draw snapshots.
import { initPhysics, createSim, DT, BTN } from './sim.js';
import { createRenderer, playerColor, loadProps } from './render.js';
import { CHAMPS, TEAM_NAMES, TEAM_COLORS, FFA_COLORS } from './champs.js';
import { MAPS } from './maps.js';
import * as net from './net.js';
import { prepareMap, loadBeast } from './stages.js';
import { loadSfx, play, setVolume } from './sfx.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
// the app version (main.cjs passes it in); lobbies only take players on the same one
const VERSION = new URLSearchParams(location.search).get('v') || 'dev';

// update screen, driven by main.cjs while a new version downloads
window.__update = s => {
  $('update').classList.toggle('hidden', !!s.done);
  if (s.done) return;
  $('updTitle').textContent = s.checking ? 'Checking for updates…' : s.installing ? 'Installing…' : `Downloading v${s.v ?? ''}`;
  $('updFill').style.width = `${s.checking ? 30 : s.p ?? 0}%`;
  $('updTxt').textContent = s.total ? `${(s.got / 1e6).toFixed(1)} / ${(s.total / 1e6).toFixed(1)} MB` : s.installing ? 'The game restarts by itself' : 'One moment';
};
if (new URLSearchParams(location.search).get('u') === '1') window.__update({ checking: true });

await initPhysics();
const view = createRenderer($('view'));
const me = { name: store.get('name', '') || `Summoner${100 + Math.floor(Math.random() * 900)}`, champ: CHAMPS[store.get('champ')] ? store.get('champ') : 'blitz' };

let conn = null;  // net session; null in practice
let lobby = null; // { code, players: [{ id, name, champ }], settings: { map, teams, rounds } }
let game = null;  // { setup, mySlot, sim?, snaps, cur, fightAt }

function show(screen) {
  for (const s of ['menu', 'lobby', 'hud']) $(s).classList.toggle('hidden', s !== screen);
  $('escMenu').classList.add('hidden');
  document.body.classList.toggle('playing', screen === 'hud'); // hides the cursor unless the Esc menu is up
}

// ---------- menu ----------
$('nameIn').value = me.name;
$('nameIn').addEventListener('input', e => { me.name = e.target.value.trim().slice(0, 14) || 'Summoner'; store.set('name', me.name); });
const mapOptions = Object.entries(MAPS).filter(([, m]) => !m.hidden).map(([id, m]) => `<option value="${id}">${m.name}</option>`).join('');
$('practiceMap').innerHTML = $('setMap').innerHTML = mapOptions;

function champCards(el, onPick) {
  el.innerHTML = Object.entries(CHAMPS).map(([id, c]) => `
    <button class="champ ${id === me.champ ? 'on' : ''}" data-id="${id}" style="--c:${c.body};--e:${c.eyes}">
      <span class="bean"></span>
      <b>${c.name}</b><small>${c.title}</small>
      ${c.abilities.map(a => `<span class="ab"><kbd>${a.key}</kbd><span><b>${a.name}</b>${a.desc}</span></span>`).join('')}
    </button>`).join('');
  el.onclick = e => {
    const id = e.target.closest('.champ')?.dataset.id;
    if (!id) return;
    me.champ = id; store.set('champ', id);
    for (const b of el.children) b.classList.toggle('on', b.dataset.id === id);
    onPick?.(id);
  };
}
champCards($('champs'));

const menuError = msg => { $('menuErr').textContent = msg || ''; };
// network debugging for players who can't connect: run the test, then paste the log to whoever is helping
$('netTestBtn').onclick = async () => { menuError('Testing network…'); menuError(await net.selfTest()); };
$('relayIn').checked = store.get('relay', '0') === '1';
net.useRelay($('relayIn').checked);
$('relayIn').onchange = e => { net.useRelay(e.target.checked); store.set('relay', e.target.checked ? '1' : '0'); };
$('netLogBtn').onclick = async () => {
  const text = [`Gang of Legends ${VERSION}`, new Date().toString(), navigator.userAgent, ...net.netLog].join('\n');
  try { await navigator.clipboard.writeText(text); menuError(`Copied ${net.netLog.length} log lines. Paste them to whoever is helping you.`); }
  catch { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text])); a.download = 'gangoflegends-network-log.txt'; a.click(); menuError('Saved the log as a file.'); }
};

$('practiceBtn').onclick = () => startPractice($('practiceMap').value);
function startPractice(map) {
  const roster = Object.keys(CHAMPS).filter(c => c !== me.champ); // one dummy of each other champ
  const dummies = roster.slice(0, 7).map((champ, i) => ({ id: `dummy${i}`, name: 'Dummy', champ, team: i + 1 }));
  startGame({ map, teams: 0, rounds: 3, practice: true, players: [{ id: 'me', name: me.name, champ: me.champ, team: 0 }, ...dummies] });
}

$('hostBtn').onclick = async () => {
  menuError('Opening lobby…');
  try { conn = await net.host(); } catch (e) { return menuError(e.message); }
  menuError();
  lobby = { code: conn.code, players: [{ id: 'host', name: me.name, champ: me.champ }], settings: { map: 'girders', teams: 0, rounds: 3 } };
  conn.on('join', (id, name, v) => {
    const why = v !== VERSION ? `Version mismatch: the host is on v${VERSION}, you're on v${v}. Restart the game to update.` : game ? 'A match is in progress.' : lobby.players.length >= 8 ? 'Lobby is full.' : '';
    if (why) { conn.send(id, { t: 'deny', msg: why }); setTimeout(() => conn.kick(id), 300); return; }
    lobby.players.push({ id, name, champ: 'blitz' });
    pushLobby();
  });
  conn.on('msg', (id, m) => {
    if (m.t === 'in' && game?.sim) game.sim.setInput(game.setup.players.findIndex(p => p.id === id), m);
    else if (m.t === 'pick' && CHAMPS[m.champ]) { const p = lobby.players.find(p => p.id === id); if (p) { p.champ = m.champ; pushLobby(); } }
  });
  conn.on('leave', id => {
    lobby.players = lobby.players.filter(p => p.id !== id);
    if (game?.sim) game.sim.drop(game.setup.players.findIndex(p => p.id === id));
    pushLobby();
  });
  pushLobby();
  show('lobby');
};

$('joinBtn').onclick = () => joinLobby($('codeIn').value);
$('codeIn').addEventListener('keydown', e => { if (e.key === 'Enter') joinLobby(e.target.value); });
async function joinLobby(raw) {
  const code = net.cleanCode(raw);
  if (code.length !== 5) return menuError('Lobby codes are 5 letters.');
  menuError('Connecting…');
  try { conn = await net.join(code, me.name, VERSION); } catch (e) { conn = null; return menuError(e.message); }
  menuError();
  conn.on('msg', m => {
    if (m.t === 'lobby') { lobby = m.lobby; game = null; renderLobby(); show('lobby'); }
    else if (m.t === 'start') startGame(m.setup);
    else if (m.t === 'snap' && game) {
      game.snaps.push({ at: performance.now(), s: m.s });
      game.local?.sync(m.s, m.s.p[game.mySlot]);
      const ev = m.ev?.filter(e => e[5] !== game.mySlot); // my own swings already played when I made them
      if (ev?.length) setTimeout(() => view.fx(ev), 80); // match the interpolation delay
    }
    else if (m.t === 'deny') leave(m.msg);
  });
  conn.on('close', () => leave('Lost connection to the host.'));
  conn.send({ t: 'pick', champ: me.champ });
}

function leave(msg) {
  conn?.close();
  conn = lobby = game = null;
  show('menu');
  menuError(msg);
}

// ---------- lobby ----------
const isHost = () => conn?.mode === 'host';
// clients treat any lobby message as "match over", so mid-match changes wait until the match ends
function pushLobby() {
  if (game) return;
  conn.broadcast({ t: 'lobby', lobby });
  renderLobby();
  show('lobby');
}
function renderLobby() {
  const s = lobby.settings, myId = conn.myId;
  $('lobbyCode').textContent = lobby.code;
  $('lobbyPlayers').innerHTML = lobby.players.map((p, i) => {
    const color = s.teams ? TEAM_COLORS[i % s.teams] : FFA_COLORS[i];
    return `<li style="--pc:${color}"><span class="dot"></span><b>${esc(p.name)}</b>${p.id === myId ? ' <em>you</em>' : ''}${p.id === 'host' ? ' <em>host</em>' : ''}
      <span class="pick">${CHAMPS[p.champ].name}</span>${s.teams ? `<span class="team">${TEAM_NAMES[i % s.teams]}</span>` : ''}</li>`;
  }).join('') + `<li class="empty">${8 - lobby.players.length} open slots</li>`;
  $('setMap').value = s.map; $('setTeams').value = s.teams; $('setRounds').value = s.rounds;
  for (const id of ['setMap', 'setTeams', 'setRounds']) $(id).disabled = !isHost();
  $('startBtn').classList.toggle('hidden', !isHost());
  $('lobbyNote').textContent = isHost() ? 'Share the code. Start whenever everyone is in.' : 'Waiting for the host to start…';
  $('mapBlurb').textContent = MAPS[s.map].blurb;
}
champCards($('lobbyChamps'), id => {
  if (isHost()) { lobby.players[0].champ = id; pushLobby(); } else conn?.send({ t: 'pick', champ: id });
});
for (const [id, key, num] of [['setMap', 'map'], ['setTeams', 'teams', 1], ['setRounds', 'rounds', 1]])
  $(id).onchange = e => { lobby.settings[key] = num ? +e.target.value : e.target.value; pushLobby(); };
$('lobbyCode').onclick = () => navigator.clipboard?.writeText(lobby.code);
$('leaveBtn').onclick = () => leave();
$('startBtn').onclick = () => {
  const { map, teams, rounds } = lobby.settings;
  const setup = { map, teams, rounds, players: lobby.players.map((p, i) => ({ id: p.id, name: p.name, champ: p.champ, team: teams ? i % teams : i })) };
  conn.broadcast({ t: 'start', setup });
  startGame(setup);
};

// ---------- match ----------
async function startGame(setup) {
  await Promise.all([prepareMap(setup.map), loadBeast(), loadProps(), loadSfx()]);
  const myId = conn ? conn.myId : 'me';
  game = { setup, mySlot: setup.players.findIndex(p => p.id === myId), snaps: [], cur: null, fightAt: 0, lastIn: '', sentAt: 0, pendingEv: [] };
  if (setup.practice || isHost()) game.sim = createSim({ mapId: setup.map, players: setup.players, practice: !!setup.practice, roundsToWin: setup.rounds });
  else game.local = createSim({ mapId: setup.map, players: setup.players, local: game.mySlot }); // my champ, predicted (sim.js)
  view.setMatch(setup);
  const mine = CHAMPS[setup.players[game.mySlot]?.champ ?? 'blitz'];
  $('abil').innerHTML = mine.abilities.map(a => `<div class="slot"><kbd>${a.key}</kbd><b>${a.name}</b><i></i><span class="cd"></span></div>`).join('');
  show('hud');
}

const teamName = t => game.setup.teams ? `${TEAM_NAMES[t]} Team` : game.setup.players[t]?.name ?? '?';
const plural = t => game.setup.teams ? 'win' : 'wins';
function updateHud(s, now) {
  const { setup } = game;
  if (setup.practice) $('scores').innerHTML = `<span class="chip">Practice · ${MAPS[setup.map].name} · Esc to leave</span>`;
  else if (setup.teams) $('scores').innerHTML = s.sc.slice(0, setup.teams).map((n, t) => `<span class="chip" style="--pc:${TEAM_COLORS[t]}">${TEAM_NAMES[t]} <b>${n}</b></span>`).join('');
  else $('scores').innerHTML = setup.players.map((p, i) => `<span class="chip ${s.p[i]?.[1] ? '' : 'out'}" style="--pc:${playerColor(setup, i)}">${esc(p.name)} <b>${s.sc[i] ?? 0}</b></span>`).join('');

  if (s.st === 'count' && s.tm !== game.lastTm) play('count', 0.7, 1);
  if (s.st !== game.lastSt && (s.st === 'round' || s.st === 'match') && s.win >= 0) { play('star', 0.8, 1); play('win', 0.9, 1); }
  game.lastTm = s.tm; game.lastSt = s.st;
  if (s.st === 'fight' && !game.fightAt) game.fightAt = now;
  if (s.st !== 'fight') game.fightAt = 0;
  const banner = s.st === 'count' ? `<small>Round ${s.rn}</small>${s.tm}`
    : s.st === 'fight' && now - game.fightAt < 900 && !setup.practice ? 'FIGHT!'
    : s.st === 'round' ? (s.win >= 0 ? `<small>Round ${s.rn}</small>${esc(teamName(s.win))} ${plural(s.win)}!` : 'Draw!')
    : s.st === 'match' || s.st === 'over' ? `<small>Match over</small>${esc(teamName(s.win))} ${plural(s.win)} the match!` : '';
  $('banner').innerHTML = banner;
  $('banner').classList.toggle('hidden', !banner);

  const mine = s.p[game.mySlot];
  $('out').classList.toggle('hidden', !!mine?.[1] || !!setup.practice || s.st !== 'fight');
  if (mine?.[1]) [...$('abil').children].forEach((el, i) => {
    const cd = mine[4 + i] / 10;
    el.classList.toggle('cooling', cd > 0);
    el.querySelector('.cd').textContent = cd > 0 ? Math.ceil(cd) : '';
    el.querySelector('i').style.height = `${Math.min(100, cd / CHAMPS[setup.players[game.mySlot].champ].abilities[i].cd * 100)}%`;
  });
}

// ---------- input ----------
const keys = new Set(), mouse = new Set();
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (game && $('escMenu').classList.contains('hidden')) e.preventDefault(); // Space would click a focused button, Ctrl+key would act
  if (e.code === 'Escape' && game) {
    if (game.setup.practice) { game = null; show('menu'); }
    else $('escMenu').classList.toggle('hidden');
  }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); mouse.clear(); });
$('view').addEventListener('mousedown', e => { mouse.add(e.button); if (e.button === 1) e.preventDefault(); }); // middle click: no autoscroll
addEventListener('mouseup', e => mouse.delete(e.button));
addEventListener('contextmenu', e => { if (game) e.preventDefault(); });
$('resumeBtn').onclick = () => $('escMenu').classList.add('hidden');
// volume sliders (menu + Esc menu) share one saved setting
const vols = document.querySelectorAll('.vol');
const applyVol = v => { setVolume(v / 100); store.set('volume', v); vols.forEach(el => { el.value = v; }); };
vols.forEach(el => { el.oninput = () => applyVol(+el.value); el.onchange = () => play('hit', 0.8); });
applyVol(+store.get('volume', 70));
$('quitBtn').onclick = () => leave();

const k = (...codes) => codes.some(c => keys.has(c));
function readInput() {
  let x = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
  let z = (k('KeyS', 'ArrowDown') ? 1 : 0) - (k('KeyW', 'ArrowUp') ? 1 : 0);
  let b = (k('Space') ? BTN.JUMP : 0) | (k('KeyJ') || mouse.has(0) ? BTN.PUNCH : 0) | (k('KeyK') || mouse.has(2) ? BTN.GRAB : 0)
    | (k('KeyQ') ? BTN.A1 : 0) | (k('KeyE') ? BTN.A2 : 0) | (k('KeyF', 'KeyH') || mouse.has(1) ? BTN.BUTT : 0) | (k('KeyC', 'ControlLeft') ? BTN.LAY : 0);
  const pad = [...(navigator.getGamepads?.() ?? [])].find(Boolean);
  if (pad) {
    const [ax, az] = pad.axes, on = i => pad.buttons[i]?.pressed;
    if (Math.hypot(ax, az) > 0.2) { x = ax; z = az; }
    b |= (on(0) ? BTN.JUMP : 0) | (on(2) ? BTN.PUNCH : 0) | (on(5) || on(7) ? BTN.GRAB : 0) | (on(4) ? BTN.A1 : 0) | (on(6) ? BTN.A2 : 0) | (on(1) ? BTN.BUTT : 0) | (on(3) ? BTN.LAY : 0);
  }
  const side = view.camSide; // controls are camera-relative: up on the stick is away from the camera
  return { x: Math.round(x * side * 100) / 100, z: Math.round(z * side * 100) / 100, b };
}

// ---------- loop ----------
let last = performance.now(), acc = 0, tick = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!game) return;
  const inp = $('escMenu').classList.contains('hidden') ? readInput() : { x: 0, z: 0, b: 0 };
  if (game.sim) {
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      game.sim.setInput(game.mySlot, inp);
      game.sim.step();
      const ev = game.sim.takeEvents();
      if (ev.length) { view.fx(ev); game.pendingEv.push(...ev); }
      // ponytail: full JSON snapshots at 30Hz over PeerJS's reliable channel (~2KB each); move to an unreliable binary channel if 8-player games stutter
      if (conn && ++tick % 2 === 0) conn.broadcast({ t: 'snap', s: game.sim.snapshot(), ev: game.pendingEv.splice(0) });
    }
    game.cur = game.sim.snapshot();
    view.apply(game.cur, game.cur, 1);
    if (game.sim.state === 'over') { game = null; pushLobby(); return; }
  } else {
    // my champ moves right away on my own copy; inputs carry the tick they start on so the host can say which one it's at
    const { local } = game;
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      local.setInput(game.mySlot, inp);
      local.step();
      const ev = local.takeEvents();
      if (ev.length) view.fx(ev);
      const key = `${inp.x},${inp.z},${inp.b}`;
      if (key !== game.lastIn || now - game.sentAt > 100) { conn.send({ t: 'in', ...inp, n: local.tick }); game.lastIn = key; game.sentAt = now; }
    }
    // everyone else is drawn ~80ms in the past, between the two snapshots around that moment
    const at = now - 80, s = game.snaps;
    while (s.length > 2 && s[1].at <= at) s.shift();
    if (!s.length) return;
    const a = s[0], b = s[1] ?? a, alpha = b === a ? 1 : Math.min(1, Math.max(0, (at - a.at) / (b.at - a.at)));
    const mine = local.snapshot().p[game.mySlot], withMe = x => ({ ...x, p: x.p.map((e, i) => i === game.mySlot ? mine : e) });
    view.apply(withMe(a.s), withMe(b.s), alpha);
    b.s.p.forEach((e, i) => { const o = a.s.p[i]; local.place(i, ...(e[1] && o?.[1] ? [6, 7, 8].map(k => o[k] + (e[k] - o[k]) * alpha) : [0, -100, 0])); });
    game.cur = withMe(b.s);
  }
  updateHud(game.cur, now);
  view.render(dt);
}
requestAnimationFrame(frame);
show('menu');

// dev shortcuts: #practice-<map> starts straight into practice (used by the smoke test)
const dev = location.hash.match(/^#practice-(\w+)/);
if (dev && MAPS[dev[1]]) startPractice(dev[1]);
if (dev) { Object.defineProperty(window, "game", { get: () => game }); window.view = view; } // smoke-test probes
