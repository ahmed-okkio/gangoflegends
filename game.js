// App flow: menu -> lobby -> match. The host (or practice) runs the sim; clients send input and draw snapshots.
import { initPhysics, createSim, DT, BTN } from './sim.js';
import { createRenderer, playerColor, loadProps } from './render.js';
import { CHAMPS, TEAM_NAMES, TEAM_COLORS, FFA_COLORS } from './champs.js';
import { MAPS } from './maps.js';
import * as net from './net.js';
import { prepareMap, loadBeast } from './stages.js';
import { loadSfx, play, ui, setVolume } from './sfx.js';

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

// ---------- controls: rebindable, saved on this machine ----------
// each action takes up to two keys or mouse buttons ('Mouse0' left, 'Mouse1' middle, 'Mouse2' right)
const ACTIONS = [
  ['up', 'Move up', ['KeyW', 'ArrowUp']], ['down', 'Move down', ['KeyS', 'ArrowDown']],
  ['left', 'Move left', ['KeyA', 'ArrowLeft']], ['right', 'Move right', ['KeyD', 'ArrowRight']],
  ['jump', 'Jump / climb', ['Space']], ['lhand', 'Left hand', ['Mouse0', 'KeyJ']], ['rhand', 'Right hand', ['Mouse2', 'KeyK']],
  ['a1', 'Ability 1', ['KeyQ']], ['a2', 'Ability 2', ['KeyE']], ['butt', 'Headbutt', ['KeyF', 'Mouse1']], ['lay', 'Lie down (hold)', ['ControlLeft']], ['lift', 'Lift (hold, grabbing)', ['ShiftLeft']],
];
let binds = {};
try { binds = JSON.parse(store.get('binds', '{}')) || {}; } catch {}
for (const [id, , def] of ACTIONS) if (!Array.isArray(binds[id])) binds[id] = [...def];
const MOUSE = ['LMB', 'MMB', 'RMB', 'M4', 'M5'];
const ARROWS = { Up: '↑', Down: '↓', Left: '←', Right: '→' };
const keyName = c => !c ? '–' : c.startsWith('Mouse') ? MOUSE[+c.slice(5)] ?? c : c.replace(/^(Key|Digit)/, '')
  .replace(/^Arrow(\w+)/, (_, d) => ARROWS[d]).replace(/^(Control|Shift|Alt|Meta)(Left|Right)$/, (_, m) => m === 'Control' ? 'Ctrl' : m);
// every <kbd data-act="..."> on the page shows that action's first key
const showKeys = () => { for (const el of document.querySelectorAll('[data-act]')) el.textContent = keyName(binds[el.dataset.act].find(Boolean)); };
let rebinding = null; // { id, slot } while waiting for the next key or click
function renderBinds() {
  const wait = (id, s) => rebinding?.id === id && rebinding.slot === s;
  $('binds').innerHTML = ACTIONS.map(([id, label]) => `<span class="bindrow">${label}<i></i>${[0, 1].map(s =>
    `<button class="bind ${wait(id, s) ? 'wait' : ''}" data-id="${id}" data-slot="${s}">${wait(id, s) ? 'press…' : keyName(binds[id][s])}</button>`).join('')}</span>`).join('');
  showKeys();
}
$('binds').onclick = e => { const b = e.target.closest('.bind'); if (b) { rebinding = { id: b.dataset.id, slot: +b.dataset.slot }; renderBinds(); } };
$('bindReset').onclick = () => { for (const [id, , def] of ACTIONS) binds[id] = [...def]; store.set('binds', JSON.stringify(binds)); rebinding = null; renderBinds(); };
// Esc cancels, Backspace/Delete clears the slot; a key taken from another action is removed there
function bindTo(code) {
  const { id, slot } = rebinding;
  rebinding = null;
  if (code) for (const a in binds) binds[a] = binds[a].map(c => c === code ? null : c);
  binds[id][slot] = code;
  store.set('binds', JSON.stringify(binds));
  renderBinds();
}
addEventListener('keydown', e => {
  if (!rebinding) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.code === 'Escape') { rebinding = null; renderBinds(); } else bindTo(e.code === 'Backspace' || e.code === 'Delete' ? null : e.code);
}, true);
// any mouse button binds, except a left click on a key slot (that just picks the slot)
addEventListener('mousedown', e => { if (rebinding && !(e.button === 0 && e.target.closest('.bind'))) { e.preventDefault(); e.stopImmediatePropagation(); bindTo(`Mouse${e.button}`); } }, true);
renderBinds();

// ---------- menu ----------
$('nameIn').value = me.name;
$('nameIn').addEventListener('input', e => { me.name = e.target.value.trim().slice(0, 14) || 'Summoner'; store.set('name', me.name); });
const stages = Object.entries(MAPS).filter(([, m]) => !m.hidden);
$('setMap').innerHTML = stages.map(([id, m]) => `<option value="${id}">${m.name}</option>`).join('');
let practiceMap = MAPS[store.get('practiceMap')] && !MAPS[store.get('practiceMap')].hidden ? store.get('practiceMap') : stages[0][0];
const renderMaps = () => { $('practiceMaps').innerHTML = stages.map(([id, m]) => `<button class="map ${id === practiceMap ? 'on' : ''}" data-id="${id}" data-sfx="pick"><b>${m.name}</b><small>${m.blurb}</small></button>`).join(''); };
renderMaps();
$('practiceMaps').onclick = e => { const id = e.target.closest('.map')?.dataset.id; if (id) { practiceMap = id; store.set('practiceMap', id); renderMaps(); } };
$('practiceMaps').ondblclick = e => { if (e.target.closest('.map')) startPractice(practiceMap); };
$('verTxt').textContent = VERSION === 'dev' ? 'Dev build' : `Version ${VERSION}`;
// main menu tabs: the rail picks which panel shows
document.querySelector('.tabs').onclick = e => {
  const t = e.target.closest('.tab');
  if (!t) return;
  for (const b of document.querySelectorAll('.tabs .tab')) b.classList.toggle('on', b === t);
  for (const p of document.querySelectorAll('#menu .panel')) {
    const on = p.dataset.panel === t.dataset.tab;
    p.classList.toggle('hidden', !on);
    if (on) { p.classList.remove('enter'); void p.offsetWidth; p.classList.add('enter'); }
  }
};

function champCards(el, onPick) {
  el.innerHTML = Object.entries(CHAMPS).map(([id, c]) => `
    <button class="champ ${id === me.champ ? 'on' : ''}" data-id="${id}" data-sfx="pick" style="--c:${c.body};--e:${c.eyes}">
      <span class="bean"></span>
      <b>${c.name}</b><small>${c.title}</small>
      ${c.abilities.map((a, i) => `<span class="ab"><kbd data-act="a${i + 1}"></kbd><span><b>${a.name}</b>${a.desc}</span></span>`).join('')}
    </button>`).join('');
  showKeys();
  el.onclick = e => {
    const id = e.target.closest('.champ')?.dataset.id;
    if (!id) return;
    me.champ = id; store.set('champ', id);
    for (const g of [$('champs'), $('lobbyChamps')]) for (const b of g.children) b.classList.toggle('on', b.dataset.id === id);
    $('champName').textContent = CHAMPS[id].name;
    onPick?.(id);
  };
}
champCards($('champs'));
$('champName').textContent = CHAMPS[me.champ].name;

// problems in red with the error sound; progress and confirmations (ok) in grey
const menuError = (msg, ok) => { $('menuErr').textContent = msg || ''; $('menuErr').classList.toggle('ok', !!ok); if (msg && !ok) ui('error'); };
// network debugging for players who can't connect: run the test, then paste the log to whoever is helping
$('netTestBtn').onclick = async () => { menuError('Testing network…', true); menuError(await net.selfTest(), true); };
$('relayIn').checked = store.get('relay', '0') === '1';
net.useRelay($('relayIn').checked);
$('relayIn').onchange = e => { net.useRelay(e.target.checked); store.set('relay', e.target.checked ? '1' : '0'); };
$('netLogBtn').onclick = async () => {
  const text = [`Gang of Legends ${VERSION}`, new Date().toString(), navigator.userAgent, ...net.netLog].join('\n');
  try { await navigator.clipboard.writeText(text); menuError(`Copied ${net.netLog.length} log lines. Paste them to whoever is helping you.`, true); }
  catch { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text])); a.download = 'gangoflegends-network-log.txt'; a.click(); menuError('Saved the log as a file.', true); }
};

$('practiceBtn').onclick = () => startPractice(practiceMap);
function startPractice(map) {
  const roster = Object.keys(CHAMPS).filter(c => c !== me.champ); // one dummy of each other champ
  const dummies = roster.slice(0, 7).map((champ, i) => ({ id: `dummy${i}`, name: 'Dummy', champ, team: i + 1 }));
  startGame({ map, teams: 0, rounds: 3, practice: true, players: [{ id: 'me', name: me.name, champ: me.champ, team: 0 }, ...dummies] });
}

$('hostBtn').onclick = async () => {
  menuError('Opening lobby…', true);
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
  menuError('Connecting…', true);
  try { conn = await net.join(code, me.name, VERSION); } catch (e) { conn = null; return menuError(e.message); }
  menuError();
  conn.on('msg', m => {
    if (m.t === 'lobby') { lobby = m.lobby; game = null; renderLobby(); show('lobby'); }
    else if (m.t === 'start') startGame(m.setup);
    else if (m.t === 'snap' && game) {
      game.snaps.push(m.s);
      // host clock vs mine over the last 2s of snapshots: the quickest arrival sets the offset, and how late the rest
      // came on average is the jitter the playback delay has to cover (a window, so a host whose sim runs a bit slow
      // or a route that gets slower is followed within seconds)
      const offs = game.offs; offs.push(m.s.mt - performance.now() / 1000); if (offs.length > 60) offs.shift();
      game.off = Math.max(...offs);
      game.jit = offs.reduce((sum, o) => sum + game.off - o, 0) / offs.length;
      game.local?.sync(m.s, m.s.p[game.mySlot]);
      const ev = m.ev?.filter(e => e[5] !== game.mySlot); // my own swings already played when I made them
      if (ev?.length) setTimeout(() => view.fx(ev), game.delay * 1000); // in step with the playback delay
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
    return `<li style="--pc:${color}"><b>${esc(p.name)}</b>${p.id === myId ? ' <em class="me">you</em>' : ''}${p.id === 'host' ? ' <em>host</em>' : ''}
      <span class="pick">${CHAMPS[p.champ].name}</span>${s.teams ? `<span class="team">${TEAM_NAMES[i % s.teams]}</span>` : ''}</li>`;
  }).join('') + '<li class="empty">Open</li>'.repeat(8 - lobby.players.length);
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
$('lobbyCode').onclick = () => { navigator.clipboard?.writeText(lobby.code); $('lobbyNote').textContent = 'Code copied.'; };
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
  game = { setup, mySlot: setup.players.findIndex(p => p.id === myId), snaps: [], cur: null, fightAt: 0, pendingEv: [], inq: [], offs: [], off: null, jit: 0, delay: 0.1 };
  if (setup.practice || isHost()) game.sim = createSim({ mapId: setup.map, players: setup.players, practice: !!setup.practice, roundsToWin: setup.rounds });
  else game.local = createSim({ mapId: setup.map, players: setup.players, local: game.mySlot }); // my champ, predicted (sim.js)
  attract = null;
  view.setMatch(setup);
  const mine = CHAMPS[setup.players[game.mySlot]?.champ ?? 'blitz'];
  $('abil').innerHTML = mine.abilities.map((a, i) => `<div class="slot"><kbd data-act="a${i + 1}"></kbd><b>${a.name}</b><i></i><span class="cd"></span></div>`).join('');
  showKeys();
  show('hud');
}

const teamName = t => game.setup.teams ? `${TEAM_NAMES[t]} Team` : game.setup.players[t]?.name ?? '?';
const plural = t => game.setup.teams ? 'win' : 'wins';
function updateHud(s, now) {
  const { setup } = game;
  if (setup.practice) $('scores').innerHTML = `<span class="chip">Practice on ${MAPS[setup.map].name}</span>`;
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
    else { $('escMenu').classList.toggle('hidden'); ui($('escMenu').classList.contains('hidden') ? 'close' : 'open'); }
  }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); mouse.clear(); });
$('view').addEventListener('mousedown', e => { mouse.add(e.button); if (e.button === 1) e.preventDefault(); }); // middle click: no autoscroll
addEventListener('mouseup', e => mouse.delete(e.button));
addEventListener('contextmenu', e => { if (game || rebinding) e.preventDefault(); });
$('resumeBtn').onclick = () => $('escMenu').classList.add('hidden');
// volume sliders (menu + Esc menu) share one saved setting each
function slider(cls, key, def, apply, sample) {
  const els = document.querySelectorAll('.' + cls), outs = document.querySelectorAll(`.${cls}Out`);
  const set = v => { apply(v / 100); store.set(key, v); els.forEach(el => { el.value = v; }); outs.forEach(o => { o.textContent = v; }); };
  els.forEach(el => { el.oninput = () => set(+el.value); el.onchange = sample; });
  set(+store.get(key, def));
}
slider('vol', 'volume', 70, setVolume, () => play('hit', 0.8));

// UI sounds: a tick on hover, and each button's data-sfx (default "click") on click
let hovered = null;
addEventListener('pointerover', e => {
  const t = e.target.closest('button, select, summary');
  if (t !== hovered && t && !t.disabled) ui('hover');
  hovered = t;
});
addEventListener('click', e => { const t = e.target.closest('button, summary'); if (t) ui(t.dataset.sfx || 'click'); });
$('quitBtn').onclick = () => leave();

const k = act => binds[act].some(c => c && (c.startsWith('Mouse') ? mouse.has(+c.slice(5)) : keys.has(c)));
function readInput() {
  let x = (k('right') ? 1 : 0) - (k('left') ? 1 : 0);
  let z = (k('down') ? 1 : 0) - (k('up') ? 1 : 0);
  // Gang Beasts layout: each hand has its own button (tap punches with it, hold reaches out and grabs)
  let b = (k('jump') ? BTN.JUMP : 0) | (k('lhand') ? BTN.LEFT : 0) | (k('rhand') ? BTN.RIGHT : 0)
    | (k('a1') ? BTN.A1 : 0) | (k('a2') ? BTN.A2 : 0) | (k('butt') ? BTN.BUTT : 0) | (k('lay') ? BTN.LAY : 0) | (k('lift') ? BTN.LIFT : 0);
  const pad = [...(navigator.getGamepads?.() ?? [])].find(Boolean);
  if (pad) {
    const [ax, az] = pad.axes, on = i => pad.buttons[i]?.pressed;
    if (Math.hypot(ax, az) > 0.2) { x = ax; z = az; }
    // triggers / bumpers are the hands, like Gang Beasts on a pad
    b |= (on(0) ? BTN.JUMP : 0) | (on(4) || on(6) ? BTN.LEFT : 0) | (on(5) || on(7) ? BTN.RIGHT : 0) | (on(2) ? BTN.A1 : 0) | (on(3) ? BTN.A2 : 0) | (on(11) ? BTN.BUTT : 0) | (on(1) ? BTN.LAY : 0) | (on(10) ? BTN.LIFT : 0);
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
  if (!game) { runAttract(dt); return; }
  const inp = $('escMenu').classList.contains('hidden') ? readInput() : { x: 0, z: 0, b: 0 };
  if (game.sim) {
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      game.sim.setInput(game.mySlot, inp);
      game.sim.step();
      const ev = game.sim.takeEvents();
      if (ev.length) { view.fx(ev); game.pendingEv.push(...ev); }
      game.prev = game.cur; game.cur = game.sim.snapshot();
      // ponytail: full JSON snapshots at 30Hz over PeerJS's reliable channel (~2KB each); move to an unreliable binary channel if 8-player games stutter
      if (conn && ++tick % 2 === 0) conn.broadcast({ t: 'snap', s: game.cur, ev: game.pendingEv.splice(0) });
    }
    if (!game.cur) return;
    view.apply(game.prev ?? game.cur, game.cur, acc / DT); // between the last two steps: smooth on screens faster than 60Hz
    if (game.sim.state === 'over') { game = null; pushLobby(); return; }
  } else {
    // my champ moves right away on my own copy (sim.js sync). Inputs go out every other tick, each message carrying
    // the last 4 ticks' inputs, so a late message costs nothing; the host plays them back tick by tick.
    const { local } = game;
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      local.setInput(game.mySlot, inp);
      local.step();
      const ev = local.takeEvents();
      if (ev.length) view.fx(ev);
      game.mine = [game.mine?.[1], local.snapshot().p[game.mySlot]];
      game.inq.push([inp.x, inp.z, inp.b]); if (game.inq.length > 4) game.inq.shift();
      if (local.tick % 2 === 0) conn.send({ t: 'in', n: local.tick, i: game.inq });
    }
    // everyone else plays back on the host's clock, far enough behind to ride out the jitter seen so far
    const s = game.snaps;
    if (!s.length || !game.mine) return;
    game.delay += (Math.min(0.35, Math.max(0.06, 0.05 + 2.5 * game.jit)) - game.delay) * 0.02;
    const at = now / 1000 + game.off - game.delay;
    while (s.length > 2 && s[1].mt <= at) s.shift();
    const a = s[0], b = s[1] ?? a, alpha = b === a ? 1 : Math.min(1, Math.max(0, (at - a.mt) / (b.mt - a.mt)));
    // me: between my last two local steps, unless knocked out or hooked (then the host's ragdoll is the truth)
    const me = local.players[game.mySlot], limp = !me.alive || me.ko > 0 || me.hooked > 0;
    view.apply(a, b, alpha, limp ? null : { slot: game.mySlot, a: game.mine[0] ?? game.mine[1], b: game.mine[1], alpha: acc / DT });
    b.p.forEach((e, i) => { const o = a.p[i]; local.place(i, ...(e[1] && o?.[1] ? [6, 7, 8].map(k => o[k] + (e[k] - o[k]) * alpha) : [0, -100, 0])); });
    game.cur = { ...b, p: b.p.map((e, i) => i === game.mySlot && !limp ? game.mine[1] : e) };
  }
  updateHud(game.cur, now);
  view.render(dt);
}

// ---------- menu backdrop: bots brawling on a stage behind the menus ----------
let attract = null; // { sim, prev, cur, bots }
async function startAttract() {
  const map = 'rooftop', mark = attract = {};
  await Promise.all([prepareMap(map), loadBeast(), loadProps(), loadSfx()]);
  if (game || attract !== mark) return;
  const players = [...Object.keys(CHAMPS), ...Object.keys(CHAMPS)].slice(0, 6).map((champ, i) => ({ id: `bot${i}`, name: '', champ, team: i }));
  const sim = createSim({ mapId: map, players, practice: true });
  view.setMatch({ map, teams: 0, rounds: 3, practice: true, menu: true, players });
  attract = { sim, prev: null, cur: null, bots: players.map(() => ({ t: 0, x: 0, z: 0, hold: 0, hand: 0, ab: 0 })) };
}
// each bot walks at the nearest other one and throws punches when close, now and then an ability
function botInput(sim, i, bot) {
  const ps = sim.players, me = ps[i];
  if (!me.alive) return { x: 0, z: 0, b: 0 };
  const p = me.bodies[0].translation();
  if ((bot.t -= DT) <= 0) {
    bot.t = 0.4 + Math.random() * 0.8;
    const foes = ps.filter((q, j) => j !== i && q.alive).map(q => q.bodies[0].translation()).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    const f = foes[0], d = f ? Math.hypot(f.x - p.x, f.z - p.z) : 0;
    [bot.x, bot.z] = !f || d < 0.01 || Math.random() < 0.2 ? [0, 0] : [(f.x - p.x) / d, (f.z - p.z) / d];
    if (f && d < 1.4) { bot.hold = Math.random() < 0.25 ? 30 : 3; bot.hand = Math.random() < 0.5 ? BTN.LEFT : BTN.RIGHT; } // a grab or a punch
    if (Math.random() < 0.08) bot.ab = Math.random() < 0.5 ? BTN.A1 : BTN.A2;
  }
  const b = (bot.hold-- > 0 ? bot.hand : 0) | bot.ab;
  bot.ab = 0;
  return { x: bot.x, z: bot.z, b };
}
function runAttract(dt) {
  if ($('menu').classList.contains('hidden') && $('lobby').classList.contains('hidden')) return;
  if (!attract) { startAttract(); return; }
  const a = attract;
  if (!a.sim) return;
  acc += dt;
  while (acc >= DT) {
    acc -= DT;
    a.bots.forEach((bot, i) => a.sim.setInput(i, botInput(a.sim, i, bot)));
    a.sim.step();
    a.sim.takeEvents(); // the backdrop stays quiet
    a.prev = a.cur; a.cur = a.sim.snapshot();
  }
  if (!a.cur) return;
  view.apply(a.prev ?? a.cur, a.cur, acc / DT);
  view.render(dt);
}

requestAnimationFrame(frame);
show('menu');

// dev shortcuts: #practice-<map> starts straight into practice (used by the smoke test)
const dev = location.hash.match(/^#practice-(\w+)/);
if (dev && MAPS[dev[1]]) startPractice(dev[1]);
if (dev) { Object.defineProperty(window, "game", { get: () => game }); window.view = view; } // smoke-test probes
