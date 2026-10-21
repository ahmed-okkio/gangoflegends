// App flow: menu -> lobby -> match. The host (or practice) runs the sim; clients send input and draw snapshots.
import { initPhysics, createSim, DT, BTN } from './sim.js';
import { createRenderer, playerColor, loadProps } from './render.js';
import { CHAMPS, TEAM_NAMES, TEAM_COLORS, FFA_COLORS } from './champs.js';
import { MAPS } from './maps.js';
import * as net from './net.js';
import { prepareMap, loadBeast } from './stages.js';
import { PARTS } from './beast.js';
import { packSnap, unpackSnap } from './wire.js';
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
  $('chat').classList.remove('open'); $('chatIn').classList.add('hidden');
  document.body.classList.toggle('playing', screen === 'hud'); // hides the cursor unless the Esc menu is up
  if (screen === 'hud') lockMouse(); else document.exitPointerLock();
}

// ---------- controls: rebindable, saved on this machine ----------
// each action takes up to two keys or mouse buttons ('Mouse0' left, 'Mouse1' middle, 'Mouse2' right)
const ACTIONS = [
  ['up', 'Move up', ['KeyW', 'ArrowUp']], ['down', 'Move down', ['KeyS', 'ArrowDown']],
  ['left', 'Move left', ['KeyA', 'ArrowLeft']], ['right', 'Move right', ['KeyD', 'ArrowRight']],
  ['jump', 'Jump / climb', ['Space']], ['lhand', 'Left hand', ['Mouse0', 'KeyJ']], ['rhand', 'Right hand', ['Mouse2', 'KeyK']],
  ['a1', 'Ability 1', ['KeyQ']], ['a2', 'Ability 2', ['KeyE']], ['butt', 'Headbutt', ['KeyF', 'Mouse1']], ['lay', 'Lie down (hold)', ['ControlLeft']], ['lift', 'Lift (hold, grabbing)', ['ShiftLeft']],
  ['chat', 'Chat', ['KeyT', 'Enter']],
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
  const lag = netSim();
  startGame({ map, teams: 0, rounds: 3, practice: true, lag: lag.ping || lag.jitter || lag.loss ? lag : null, players: [{ id: 'me', name: me.name, champ: me.champ, team: 0 }, ...dummies] });
}
// dev mode (Settings) shows the practice connection simulator: ping (round trip), jitter (extra each way, up to) and
// packet loss. Practice with any of them set plays me as a client of a host running right here
const devOn = () => store.get('dev', '0') === '1';
const showDev = () => $('netSim').classList.toggle('hidden', !devOn());
$('devIn').checked = devOn();
$('devIn').onchange = e => { store.set('dev', e.target.checked ? '1' : '0'); showDev(); };
showDev();
const SIM = [['simPing', 'ping', 1000], ['simJit', 'jitter', 500], ['simLoss', 'loss', 50]];
for (const [id, key, max] of SIM) {
  $(id).value = store.get(`sim_${key}`, 0);
  $(id).onchange = e => { e.target.value = Math.min(max, Math.max(0, Math.round(+e.target.value) || 0)); store.set(`sim_${key}`, e.target.value); };
}
$('simTcp').checked = store.get('sim_tcp', '0') === '1';
$('simTcp').onchange = e => store.set('sim_tcp', e.target.checked ? '1' : '0');
const netSim = () => ({ ...Object.fromEntries(SIM.map(([, key]) => [key, devOn() ? +store.get(`sim_${key}`, 0) : 0])), tcp: store.get('sim_tcp', '0') === '1' });

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
    if (m.t === 'chat') hostChat(id, m.text);
    else if (m.t === 'in' && game?.sim) game.sim.setInput(game.setup.players.findIndex(p => p.id === id), m);
    else if (m.t === 'ping') conn.sendFast(id, { t: 'pong', c: m.c });
    else if (m.t === 'pick' && CHAMPS[m.champ]) {
      const p = lobby.players.find(p => p.id === id);
      if (p) { p.champ = m.champ; pushLobby(); }
      game?.sim?.setChamp(game.setup.players.findIndex(p => p.id === id), m.champ); // mid-match: from next round
    }
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
  if (code.length !== 3) return menuError('Lobby codes are 3 characters.');
  menuError('Connecting…', true);
  try { conn = await net.join(code, me.name, VERSION); } catch (e) { conn = null; return menuError(e.message); }
  menuError();
  conn.on('msg', m => {
    if (m.t === 'lobby') { lobby = m.lobby; game = null; renderLobby(); show('lobby'); }
    else if (m.t === 'start') startGame(m.setup);
    else if (m.t === 'snap') onSnap(m);
    else if (m.t === 'pong') onPong(m);
    else if (m.t === 'deny') leave(m.msg);
    else if (m.t === 'chat') showChat(m.slot, m.text);
  });
  conn.on('close', () => leave('Lost connection to the host.'));
  conn.send({ t: 'pick', champ: me.champ });
}

// a snapshot from the host (or the practice connection simulator)
function onSnap(m) {
  if (!game?.local || m.s.mt <= game.lastMt) return; // the unreliable channel can deliver out of order: an older one is stale
  game.lastMt = m.s.mt;
  game.snaps.push(unpackSnap(m.s));
  // host clock vs mine: the quickest arrival over the last 5s sets the offset (short, so it follows the host's clock when
  // that loses time: a frame of theirs over 0.1s), and the playback delay has to cover how late all but the latest 1% came
  // over the last 30s. Not the average: over TCP (the relay, TURN) a lost packet holds up everything behind it for a round
  // trip, and those stalls froze everyone else, then made them jump. 30s, not 5: a stall every few seconds dropped out of
  // a short window, the delay shrank and the next stall froze them again (media players remember about as long). One
  // that arrives right after a long frame of mine (loading the match, GC) waited on me, not the network: not counted
  const offs = game.offs, t = performance.now();
  if (!offs.length || t - last < 50) { offs.push(m.s.mt - t / 1000); if (offs.length > 900) offs.shift(); }
  game.off = Math.max(...offs.slice(-150));
  game.jit = offs.map(o => Math.max(0, game.off - o)).sort((a, b) => a - b)[Math.floor(0.99 * (offs.length - 1))];
  game.local.sync(m.s, m.s.p[game.mySlot]);
  // events ride along on several snapshots (any one can be lost); e[7] numbers them so each plays once (sim.js fx() for
  // the rest). Mine that my copy already played are skipped; one it didn't see coming (a hit it didn't predict) still plays.
  // What happens to me plays now (my ragdoll took it as this arrived, sync()), the rest in step with the playback delay
  const ev = m.ev?.filter(e => e[7] > game.evN && !(e[5] === game.mySlot && claim(e, t))) ?? [];
  for (const e of m.ev ?? []) game.evN = Math.max(game.evN, e[7]);
  const now = ev.filter(e => e[6] === game.mySlot), later = ev.filter(e => e[6] !== game.mySlot);
  if (now.length) view.fx(now);
  if (later.length) setTimeout(() => view.fx(later), game.delay * 1000);
}
// one of the effects my copy played (game.played: [...event, time]) standing in for the host's e: same kind, same victim.
// Each stands in for one, so two punches that both landed don't cover a third the host saw and I didn't
function claim(e, t) {
  game.played = game.played.filter(p => t - p[7] < (game.ping ?? 200) + 400);
  const i = game.played.findIndex(p => p[0] === e[0] && p[6] === e[6]);
  if (i >= 0) game.played.splice(i, 1);
  return i >= 0;
}

// ping (top left): round trip of a ping over the same channel as the game, once a second; the median of the last 5,
// so one held up by a hitch (loading the match, a stall) doesn't show
function onPong(m) {
  if (!game) return;
  const p = game.pings = [...game.pings ?? [], performance.now() - m.c].slice(-5);
  game.ping = [...p].sort((a, b) => a - b)[p.length >> 1];
  const el = $('ping');
  el.textContent = `${Math.round(game.ping)} ms`;
  // dev mode: frames this second, the slowest one, and how far behind everyone else is drawn: a slow PC or a slow link
  const fr = game.fr ?? { n: 0, worst: 0 };
  if (devOn()) el.textContent += ` · ${fr.n} fps · worst frame ${Math.round(fr.worst * 1000)} ms · others ${Math.round(game.delay * 1000)} ms behind`;
  game.fr = { n: 0, worst: 0 };
  el.className = game.ping > 200 ? 'bad' : game.ping > 100 ? 'meh' : '';
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
for (const [id, key, num] of [['setMap', 'map'], ['setTeams', 'teams', 1]])
  $(id).onchange = e => { lobby.settings[key] = num ? +e.target.value : e.target.value; pushLobby(); };
$('setRounds').onchange = e => { lobby.settings.rounds = Math.min(99, Math.max(1, Math.round(+e.target.value) || 1)); pushLobby(); }; // typed: kept to 1-99
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
  game = { setup, mySlot: setup.players.findIndex(p => p.id === myId), snaps: [], cur: null, fightAt: 0, sentEv: [], evN: 0, played: [], lastMt: -1, inq: [], offs: [], off: null, jit: 0, delay: 0.1, at: null };
  $('chatLog').replaceChildren();
  $('ping').textContent = '';
  if (setup.practice || isHost()) game.sim = createSim({ mapId: setup.map, players: setup.players, practice: !!setup.practice, roundsToWin: setup.rounds });
  // my champ, predicted (sim.js). Practice behind a simulated connection has both: game.sim is the host
  if (!game.sim || setup.lag) game.local = createSim({ mapId: setup.map, players: setup.players, local: game.mySlot });
  game.fake = setup.lag && { acc: 0, t: 0, n: 0, ev: [] };
  attract = null;
  view.setMatch(setup);
  abilityHud();
  escChamps();
  show('hud');
}
function abilityHud() {
  const mine = CHAMPS[game.setup.players[game.mySlot]?.champ ?? 'blitz'];
  $('abil').innerHTML = mine.abilities.map((a, i) => `<div class="slot"><kbd data-act="a${i + 1}"></kbd><b>${a.name}</b><i></i><span class="cd"></span></div>`).join('');
  showKeys();
}
// Esc menu: switch champ for the next round (practice: right away)
function escChamps() {
  const now = game.setup.players[game.mySlot]?.champ;
  $('escChamps').innerHTML = Object.entries(CHAMPS).map(([id, c]) =>
    `<button class="${id === me.champ ? 'on' : ''}" data-id="${id}" data-sfx="pick" style="--c:${c.body};--e:${c.eyes}"><span class="bean"></span>${c.name}</button>`).join('');
  $('escChampNote').textContent = me.champ === now ? '' : game.setup.practice ? '' : `${CHAMPS[me.champ].name} from next round`;
}
$('escChamps').onclick = e => {
  const id = e.target.closest('button')?.dataset.id;
  if (!id || !game) return;
  me.champ = id; store.set('champ', id);
  for (const g of [$('champs'), $('lobbyChamps')]) for (const b of g.children) b.classList.toggle('on', b.dataset.id === id);
  $('champName').textContent = CHAMPS[id].name;
  if (game.sim) { game.sim.setChamp(game.mySlot, id); if (lobby) lobby.players[0].champ = id; }
  else conn.send({ t: 'pick', champ: id });
  escChamps();
};

const teamName = t => game.setup.teams ? `${TEAM_NAMES[t]} Team` : game.setup.players[t]?.name ?? '?';
const plural = t => game.setup.teams ? 'win' : 'wins';
function updateHud(s, now) {
  const { setup } = game;
  // someone's champ swap went through (a new round started): rebuild their beast, and my ability bar if it's me
  s.ch?.forEach((c, i) => {
    if (!setup.players[i] || setup.players[i].champ === c || !CHAMPS[c]) return;
    setup.players[i].champ = c;
    view.setChamp(i, c);
    if (i === game.mySlot) { abilityHud(); escChamps(); }
  });
  if (setup.practice) $('scores').innerHTML = `<span class="chip">Practice on ${MAPS[setup.map].name}${setup.lag ? ` · ${setup.lag.ping}ms${setup.lag.tcp ? ' TCP' : ''}` : ''}</span>`;
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
  if (e.code === 'Escape' && game) escape();
  else if (conn && game && binds.chat.includes(e.code) && $('escMenu').classList.contains('hidden')) openChat();
});
// Esc in a match: practice ends, a real match toggles the pause menu. Chromium also drops the mouse lock on Esc, and may
// or may not pass the key on, so a lost lock counts as Esc too; one press within 300 ms is the same press
let escAt = 0;
function escape() {
  if (performance.now() - escAt < 300) return;
  escAt = performance.now();
  if (game.setup.practice) { game = null; show('menu'); }
  else { $('escMenu').classList.toggle('hidden'); ui($('escMenu').classList.contains('hidden') ? 'close' : 'open'); }
  if (!$('escMenu').classList.contains('hidden') || !game) document.exitPointerLock(); else lockMouse();
}
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); mouse.clear(); });
$('view').addEventListener('mousedown', e => { mouse.add(e.button); if (e.button === 1) e.preventDefault(); lockMouse(); }); // middle click: no autoscroll
addEventListener('mouseup', e => mouse.delete(e.button));
// the mouse is locked to the window in a match (it can't wander onto another screen mid-fight); the crosshair is a
// virtual cursor moved by the raw mouse motion and kept inside the view. cursor aims abilities (readInput)
let cursor = null;
const locked = () => document.pointerLockElement === $('view');
function lockMouse() {
  if (game && !locked() && $('escMenu').classList.contains('hidden')) $('view').requestPointerLock()?.catch?.(() => {}); // needs a click first
}
function moveCursor(x, y) {
  const r = $('view').getBoundingClientRect();
  cursor = [Math.min(r.right - 1, Math.max(r.left, x)), Math.min(r.bottom - 1, Math.max(r.top, y))];
  $('crosshair').style.transform = `translate(${cursor[0] - 16}px, ${cursor[1] - 16}px)`;
}
addEventListener('mousemove', e => { if (locked()) moveCursor(cursor[0] + e.movementX, cursor[1] + e.movementY); else moveCursor(e.clientX, e.clientY); });
document.addEventListener('pointerlockchange', () => {
  if (locked()) { cursor ??= [innerWidth / 2, innerHeight / 2]; moveCursor(...cursor); }
  else if (game && $('escMenu').classList.contains('hidden') && !chatting() && document.hasFocus()) escape(); // Esc released it (not alt-tab)
});
addEventListener('contextmenu', e => { if (game || rebinding) e.preventDefault(); });
$('resumeBtn').onclick = () => { $('escMenu').classList.add('hidden'); lockMouse(); };

// ---------- chat (matches only): T opens it; the host relays every line to everyone ----------
const chatting = () => !$('chatIn').classList.contains('hidden');
function openChat() {
  keys.clear(); mouse.clear(); // whatever was held stops, instead of walking on while I type
  $('chat').classList.add('open'); $('chatIn').classList.remove('hidden');
  document.exitPointerLock(); // after chatting() turns true, so losing the lock isn't taken for Esc
  setTimeout(() => $('chatIn').focus()); // after this keydown, so the T isn't typed
}
function closeChat() {
  $('chat').classList.remove('open'); $('chatIn').classList.add('hidden'); $('chatIn').value = ''; $('chatIn').blur();
  lockMouse();
}
$('chatIn').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { const text = $('chatIn').value.trim(); if (text) isHost() ? hostChat('host', text) : conn?.send({ t: 'chat', text }); closeChat(); }
  else if (e.key === 'Escape') closeChat();
});
// host: a player's line, checked (text only, 120 chars, one line a second) and passed to everyone with their slot
const chatAt = new Map();
function hostChat(id, text) {
  const slot = game?.setup.players.findIndex(p => p.id === id) ?? -1;
  if (slot < 0 || typeof text !== 'string' || performance.now() - (chatAt.get(id) ?? -1e4) < 1000) return;
  text = text.trim().slice(0, 120);
  if (!text) return;
  chatAt.set(id, performance.now());
  conn.broadcast({ t: 'chat', slot, text });
  showChat(slot, text);
}
function showChat(slot, text) {
  const p = game?.setup.players[slot];
  if (!p || typeof text !== 'string') return;
  const line = document.createElement('p'), who = document.createElement('b');
  line.style.setProperty('--pc', playerColor(game.setup, slot));
  who.textContent = p.name; line.append(who, text.slice(0, 120)); // text, never HTML
  $('chatLog').append(line);
  while ($('chatLog').children.length > 8) $('chatLog').firstChild.remove();
  setTimeout(() => line.classList.add('old'), 10000);
  ui('pick');
}
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
// running: double-tap a move key (pressed again within 0.3s of letting it go); lasts until every move key is up
const MOVES = ['up', 'down', 'left', 'right'], moveUp = {}, moveWas = {};
let running = false;
function readInput() {
  const t = performance.now();
  for (const d of MOVES) {
    const on = k(d);
    if (on && !moveWas[d] && t - (moveUp[d] ?? -1e9) < 300) running = true;
    if (!on && moveWas[d]) moveUp[d] = t;
    moveWas[d] = on;
  }
  if (!MOVES.some(k)) running = false;
  let x = (k('right') ? 1 : 0) - (k('left') ? 1 : 0);
  let z = (k('down') ? 1 : 0) - (k('up') ? 1 : 0);
  // Gang Beasts layout: each hand has its own button (tap punches with it, hold reaches out and grabs)
  let b = (k('jump') ? BTN.JUMP : 0) | (k('lhand') ? BTN.LEFT : 0) | (k('rhand') ? BTN.RIGHT : 0)
    | (k('a1') ? BTN.A1 : 0) | (k('a2') ? BTN.A2 : 0) | (k('butt') ? BTN.BUTT : 0) | (k('lay') ? BTN.LAY : 0) | (k('lift') ? BTN.LIFT : 0) | (running ? BTN.RUN : 0);
  const pad = [...(navigator.getGamepads?.() ?? [])].find(Boolean);
  if (pad) {
    const [ax, az] = pad.axes, on = i => pad.buttons[i]?.pressed;
    if (Math.hypot(ax, az) > 0.2) { x = ax; z = az; }
    // triggers / bumpers are the hands, like Gang Beasts on a pad
    b |= (on(0) ? BTN.JUMP : 0) | (on(4) || on(6) ? BTN.LEFT : 0) | (on(5) || on(7) ? BTN.RIGHT : 0) | (on(2) ? BTN.A1 : 0) | (on(3) ? BTN.A2 : 0) | (on(11) ? BTN.BUTT : 0) | (on(1) ? BTN.LAY : 0) | (on(10) ? BTN.LIFT : 0);
  }
  const side = view.camSide; // controls are camera-relative: up on the stick is away from the camera
  const a = game && cursor ? view.aimYaw(...cursor, game.mySlot) : null; // abilities aim at the cursor
  return { x: Math.round(x * side * 100) / 100, z: Math.round(z * side * 100) / 100, b, a: a == null ? null : Math.round(a * 100) / 100, d: a == null ? null : Math.round(view.aimDist() * 10) / 10 };
}
// my skillshot strip: shown while an aimed ability's key is held, if it was ready when pressed (sim.js casts the same way).
// A windup ability's (aimMin) strip grows to its full reach over the windup
const aiming = [false, false], held = [0, 0];
function showAim(inp, dt) {
  const abs = CHAMPS[game.setup.players[game.mySlot].champ].abilities, mine = game.cur?.p[game.mySlot];
  let range = 0, back = false, point = null;
  const sim = game.sim ?? game.local, stuck = sim.stuck(game.mySlot);
  [BTN.A1, BTN.A2].forEach((btn, i) => {
    const ab = abs[i];
    if (!(inp.b & btn)) aiming[i] = false;
    else if (!aiming[i] && !(game.lastB & btn)) { aiming[i] = !!ab.aim && !(mine?.[4 + i] > 0) && !stuck; held[i] = 0; }
    if (!aiming[i]) return;
    held[i] += dt;
    range = ab.aimMin ? ab.aimMin + (ab.aim - ab.aimMin) * Math.min(1, held[i] / ab.windup) : ab.aim;
    back = !!ab.back;
    if (ab.point) point = { max: ab.aim, r: ab.radius };
  });
  game.lastB = inp.b;
  $('abil').classList.toggle('stuck', stuck);
  view.setAim(inp.a == null ? null : { slot: game.mySlot, yaw: inp.a, range, back, point, dist: inp.d });
}

// ---------- loop ----------
let last = performance.now(), acc = 0, tick = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!game) { runAttract(dt); return; }
  const fr = game.fr ??= { n: 0, worst: 0 }; fr.n++; fr.worst = Math.max(fr.worst, dt); // for the ping line (onPong)
  const inp = $('escMenu').classList.contains('hidden') ? readInput() : { x: 0, z: 0, b: 0, a: null, d: null };
  showAim(inp, dt);
  if (game.sim && !game.local) {
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      game.sim.setInput(game.mySlot, inp);
      game.sim.step();
      const ev = game.sim.takeEvents();
      if (ev.length) { view.fx(ev); if (conn) for (const e of ev) game.sentEv.push([...e, ++game.evN, now]); }
      game.prev = game.cur; game.cur = game.sim.snapshot();
      // ponytail: full JSON snapshots at 30Hz over PeerJS's reliable channel (~2KB each); move to an unreliable binary channel if 8-player games stutter
      if (conn && ++tick % 2 === 0) {
        game.sentEv = game.sentEv.filter(e => now - e[8] < 250); // each event goes out on ~7 snapshots
        conn.broadcastFast({ t: 'snap', s: packSnap(game.cur), ev: game.sentEv.map(e => e.slice(0, 8)) });
      }
    }
    if (!game.cur) return;
    view.apply(game.prev ?? game.cur, game.cur, acc / DT); // between the last two steps: smooth on screens faster than 60Hz
    if (game.sim.state === 'over') { game = null; pushLobby(); return; }
  } else {
    // my champ moves right away on my own copy (sim.js sync). Inputs go out every other tick, each message carrying
    // the last 6 ticks' inputs over the unreliable channel, so a lost or late message costs nothing; the host plays them back tick by tick.
    if (game.fake) fakeHost(dt, now);
    const { local } = game;
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      local.setInput(game.mySlot, inp);
      local.step();
      const ev = local.takeEvents();
      if (ev.length) { view.fx(ev); for (const e of ev) if (e[5] === game.mySlot) game.played.push([...e, now]); }
      game.mine = [game.mine?.[1], local.snapshot().p[game.mySlot]];
      game.inq.push([inp.x, inp.z, inp.b, inp.a, inp.d]); if (game.inq.length > 6) game.inq.shift(); // each tick goes out 3-6 times
      // every tick on a steady link (my inputs reach the host up to a tick sooner, and it can keep fewer waiting); every
      // other tick on a bursty one (TCP: every packet is one more chance of a stall: its stalls keep the lateness up), and
      // for the first 10s, till that's known: loading the match throws it off for a few seconds (measured: on TCP, starting
      // every tick then switching cost rubber-banding)
      if (local.tick % (local.tick > 600 && game.jit < 0.06 ? 1 : 2) === 0) sendIn({ t: 'in', n: local.tick, i: game.inq });
    }
    if (now - (game.pingAt ?? 0) > 1000) { game.pingAt = now; sendIn({ t: 'ping', c: now }); }
    // everyone else plays back on the host's clock, far enough behind to ride out the jitter seen so far and a lost snapshot
    const s = game.snaps;
    if (!s.length || !game.mine) return;
    // the margin over that lateness grows with it: a steady link plays as little as 2 snapshots behind (a good ping gets
    // others as fresh as it can), a bursty one keeps more spare (a gap past it carries on, see carryOn)
    game.delay += (Math.min(0.7, Math.max(0.067, game.jit * 1.2 + 0.05)) - game.delay) * 0.02;
    // that clock runs at wall speed, nudged toward where it should be: at most 5% fast or 15% slow (slower shows as slow
    // motion; engines stay within 0.85-1.1x). The offset jumps a few ms whenever its quickest sample leaves the window,
    // and jumping with it made everyone else stutter
    const want = now / 1000 + game.off - game.delay;
    game.at = game.at == null || Math.abs(want - game.at) > 0.25 ? want : game.at + dt * (1 + Math.max(-0.15, Math.min(0.05, (want - game.at) * 2)));
    const at = game.at;
    while (s.length > 2 && s[1].mt <= at) s.shift();
    const a = s[0], b = s[1] ?? a, alpha = b === a ? 1 : Math.min(1, Math.max(0, (at - a.mt) / (b.mt - a.mt)));
    // me: between my last two local steps, unless knocked out, hooked or grabbing / grabbed by someone (then the host's
    // ragdoll is the truth, and drawn on the same clock as whoever I'm tied to)
    const me = local.players[game.mySlot], limp = !me.alive || me.ko > 0 || me.hooked > 0 || me.tied;
    const shift = carryOn(a, b, alpha, s[s.length - 1], at, dt);
    if (!limp) shift[game.mySlot] = null;
    // my own glue puddles: drawn from my copy (cast at once) until the host's shows up on screen
    const og = local.ownGlue.filter(g => !b.g?.some(h => h[5] === g.team && Math.hypot(h[0] - g.x, h[2] - g.z) < 1));
    const drawn = og.length ? { ...b, g: [...b.g ?? [], ...og.map(g => [g.x, g.y, g.z, g.t, g.r, g.team])] } : b;
    view.apply(a, drawn, alpha, limp ? null : { slot: game.mySlot, a: game.mine[0] ?? game.mine[1], b: game.mine[1], alpha: acc / DT }, shift);
    b.p.forEach((e, i) => { const o = a.p[i], d = shift[i]; local.place(i, ...(e[1] && o?.[1] ? [6, 7, 8].map((k, j) => o[k] + (e[k] - o[k]) * alpha + (d?.[j] ?? 0)) : [0, -100, 0])); });
    game.cur = { ...b, p: b.p.map((e, i) => i === game.mySlot && !limp ? game.mine[1] : e) };
  }
  updateHud(game.cur, now);
  view.render(dt);
}

// a stall (a lost snapshot; over the relay or TURN-over-TCP, a round trip): past the newest snapshot everyone else carries
// on from it for a moment instead of freezing, sideways at their hips' speed, slowing down, at most 0.15s (ragdolls can't
// be extrapolated far: floors, walls, each other). When the next one lands, where they were drawn and where it puts them
// differ: that gap fades out (15% a frame at 60fps) instead of jumping. Returns how far to draw each one's hips off the snapshots
const VX = 10 + PARTS.length * 4; // hips velocity in a snapshot entry (sim.js snapshot())
const carry = (e, t) => { const k = 0.15 * (1 - Math.exp(-Math.min(t, 0.15) / 0.15)); return [e[VX] * k, 0, e[VX + 2] * k]; };
function carryOn(a, b, alpha, n, at, dt) {
  const was = game.carry, gaps = game.gaps ??= [], fade = Math.pow(0.85, dt * 60);
  game.carry = at > n.mt ? n : null;
  return b.p.map((e, i) => {
    const o = a.p[i];
    if (!e[1] || !o?.[1]) return gaps[i] = null;
    const ext = game.carry?.p[i]?.[1] ? carry(n.p[i], at - n.mt) : [0, 0, 0];
    let gap = gaps[i] ?? [0, 0, 0];
    if (was && was !== n && was.p[i]?.[1]) { // drawn from the old newest until now: start from there
      const w = was.p[i], wc = carry(w, at - was.mt);
      gap = [6, 7, 8].map((k, j) => gap[j] + w[k] + wc[j] - (o[k] + (e[k] - o[k]) * alpha + ext[j]));
      if (Math.hypot(...gap) > 1.5) gap = [0, 0, 0]; // respawned, flung: just go there
    }
    gaps[i] = gap = gap.map(v => v * fade);
    return ext.map((v, j) => v + gap[j]);
  });
}

const sendIn = m => {
  if (conn) return conn.sendFast(m);
  m = JSON.parse(JSON.stringify(m));
  lagged(() => m.t === 'ping' ? lagged(() => onPong({ c: m.c }), 'down') : game.sim.setInput(game.mySlot, m), 'up');
};
// practice behind a simulated connection: the host's steps run here too (like the host branch above), and everything
// between it and my predicted copy goes through lagged(): half the ping plus up to the jitter each way (so messages can
// overtake each other, like on the unreliable channel), and some never arrive. Like TCP (the relay, TURN over TCP),
// nothing is lost or overtaken: a lost packet is resent a round trip later and holds up everything behind it
function lagged(fn, dir) {
  const g = game, { ping, jitter, loss, tcp } = g.setup.lag, now = performance.now(), lost = Math.random() * 100 < loss;
  if (lost && !tcp) return;
  let at = now + ping / 2 + Math.random() * jitter + (lost ? ping + 40 : 0);
  if (tcp) at = g.fake[dir] = Math.max(g.fake[dir] ?? 0, at);
  setTimeout(() => { if (game === g) fn(); }, at - now);
}
function fakeHost(dt, now) {
  const h = game.fake;
  h.acc += dt;
  while (h.acc >= DT) {
    h.acc -= DT;
    game.sim.step();
    for (const e of game.sim.takeEvents()) h.ev.push([...e, ++h.n, now]);
    if (++h.t % 2) continue;
    h.ev = h.ev.filter(e => now - e[8] < 250);
    const m = JSON.parse(JSON.stringify({ t: 'snap', s: packSnap(game.sim.snapshot()), ev: h.ev.map(e => e.slice(0, 8)) }));
    lagged(() => onSnap(m), 'down');
  }
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
