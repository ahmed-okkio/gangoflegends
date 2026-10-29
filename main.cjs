const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const tls = require('tls');

// SMOKE=<png path> loads SMOKE_HASH (default #practice-girders), screenshots after SMOKE_MS, then quits. Offscreen, no window.
const smoke = process.env.SMOKE;
const dev = process.argv.includes('--dev'); // npm run dev: straight into practice with DevTools open
// npm run dev -- --map=girders --champ=vi --bots=2 (or --bots=blitz,hec): default Rooftop, my saved champ, one random dummy
const devArg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const devHash = `practice-${devArg('map') || process.env.DEV_MAP || 'rooftop'}&bots=${devArg('bots') || 1}${devArg('champ') ? `&champ=${devArg('champ')}` : ''}`;
// one dev instance at a time: a new npm run dev closes the last one
if (dev) {
  const pidFile = path.join(require('os').tmpdir(), 'gangoflegends-dev.pid');
  try { process.kill(+fs.readFileSync(pidFile, 'utf8')); } catch {}
  fs.writeFileSync(pidFile, String(process.pid));
}
if (smoke) app.setPath('userData', path.join(app.getPath('temp'), `gangoflegends-test-${process.pid}`));
// a throwaway profile per run: gone when it quits (hundreds of runs filled the temp drive). ponytail: best effort, a crash leaves one
if (smoke) process.on('exit', () => { try { fs.rmSync(app.getPath('userData'), { recursive: true, force: true }); } catch {} });

// Mainland China: ISPs there mostly reach Cloudflare's free plan through the US, but route some of its other IP ranges via
// Hong Kong or Japan, and every range serves every Cloudflare site. So a player in China (by time zone; RELAY_PROBE=1 to
// test elsewhere) times TLS handshakes to a sample of them against the normal address, in the background, and when one is
// clearly faster the relay (net.js RELAY: how they join a host) goes through it from the next launch on.
// ponytail: takes effect a launch late, and an address that dies spoils one launch; probe before the window if that bites
const RELAY_HOST = 'gangoflegends-turn.ahmed-okkio.workers.dev';
const CF_RANGES = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22']; // cloudflare.com/ips-v4
const china = process.env.RELAY_PROBE === '1' || /^Asia\/(Shanghai|Urumqi|Chongqing|Harbin|Kashgar)$/.test(Intl.DateTimeFormat().resolvedOptions().timeZone);
const viaFile = path.join(app.getPath('userData'), 'relay-via.json');
let via = null;
try { if (china) via = JSON.parse(fs.readFileSync(viaFile, 'utf8')); } catch { /* not probed yet */ }
if (via?.ip) app.commandLine.appendSwitch('host-resolver-rules', `MAP ${RELAY_HOST} ${via.ip}`);
// ms to a finished TLS handshake for RELAY_HOST at this address (Infinity: doesn't serve it), best of three
const shake = host => new Promise(res => {
  const t0 = performance.now(), s = tls.connect({ host, port: 443, servername: RELAY_HOST, timeout: 3000 }, () => { res(performance.now() - t0); s.destroy(); });
  s.on('error', () => res(Infinity)); s.on('timeout', () => { s.destroy(); res(Infinity); });
});
const best = async host => Math.min(await shake(host), await shake(host), await shake(host));
async function probeRelay() {
  const pick = c => { const [a, bits] = c.split('/'), n = a.split('.').reduce((v, x) => v * 256 + +x, 0) + Math.floor(Math.random() * 2 ** (32 - bits)); return [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.'); };
  const ips = [...new Set([...via?.ip ? [via.ip] : [], ...CF_RANGES.flatMap(c => Array.from({ length: 8 }, () => pick(c)))])]; // about a third serve it
  const [def, ...ms] = await Promise.all([best(RELAY_HOST), ...ips.map(best)]), i = ms.indexOf(Math.min(...ms));
  // the winner of a crowd of parallel handshakes, timed again on its own against the normal address (null: blocked)
  const [d, w] = ms[i] < def ? [await best(RELAY_HOST), await best(ips[i])] : [def, Infinity], out = { def: Math.round(d), at: new Date().toISOString() };
  if (w < d - 30 && w < d * 0.8) Object.assign(out, { ip: ips[i], ms: Math.round(w) });
  fs.writeFileSync(viaFile, JSON.stringify(out));
}

app.whenReady().then(() => {
  // no app menu: its shortcuts (Ctrl+W closes, Ctrl+R reloads) fire while holding Ctrl to lie down and pressing a move key
  if (!dev) Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1400, height: 860, backgroundColor: '#0b1426', autoHideMenuBar: true, show: !smoke,
    title: 'Gang of Legends', webPreferences: { backgroundThrottling: false, offscreen: !!smoke },
  });
  const updates = app.isPackaged && !smoke && process.platform !== 'darwin'; // unsigned Mac builds can't self-install: Mac players download the new .dmg
  // v feeds the lobby version check; u=1 makes the page start behind the "checking for updates" screen
  win.loadFile(path.join(__dirname, 'index.html'), { query: { v: app.getVersion(), u: updates ? '1' : '0', rv: via ? JSON.stringify(via) : '' }, hash: smoke ? (process.env.SMOKE_HASH ?? 'practice-girders') : dev ? devHash : '' });
  if (dev) win.webContents.openDevTools({ mode: 'detach' });
  if (updates) checkForUpdates(win);
  if (app.isPackaged && !smoke && process.platform === 'darwin') offerMacUpdate(win);
  if (china) setTimeout(() => probeRelay().catch(() => {}), 5000); // after startup's own traffic
  if (!smoke) return;
  win.webContents.setAudioMuted(true);
  win.webContents.setFrameRate(60);
  win.webContents.on('console-message', (_e, _level, msg) => fs.appendFileSync(smoke + '.log', `${msg}\n`)); // Electron's stdout doesn't reach Git Bash on Windows
  if (process.env.SMOKE_JS) win.webContents.once('did-finish-load', () => setTimeout(() => win.webContents.executeJavaScript(process.env.SMOKE_JS).then(r => fs.appendFileSync(smoke + '.log', `${JSON.stringify(r)}\n`), e => fs.appendFileSync(smoke + '.log', `error ${e.message}\n`)), Number(process.env.SMOKE_JS_MS || 3000)));
  setTimeout(async () => {
    fs.writeFileSync(smoke, (await win.capturePage()).toPNG());
    app.quit();
  }, Number(process.env.SMOKE_MS || 5000));
});

// Downloads new versions from GitHub Releases at launch. The page shows a blocking progress bar (window.__update).
// Usually only game files changed: patchFiles swaps those in and restarts in a second. When Electron or a dependency changed
// (or the release has no files.json), the installer runs silently and relaunches the game, which takes most of a minute.
async function checkForUpdates(win) {
  const show = s => win.webContents.executeJavaScript(`window.__update?.(${JSON.stringify(s)})`).catch(() => {});
  await new Promise(r => win.webContents.once('did-finish-load', r));
  try { if (await patchFiles(show)) return; } catch { /* half fetched or GitHub down: the installer path decides */ }
  const { autoUpdater } = require('electron-updater');
  // the page starts blocked; every outcome except a found update releases it. found: the new version, once there is one
  let found = false;
  const release = () => { if (!found) show({ done: true }); };
  autoUpdater.on('update-not-available', release);
  setTimeout(release, 15000); // a hung check (bad connection) never locks anyone out
  autoUpdater.on('update-available', i => { found = i.version; show({ v: found, p: 0 }); });
  autoUpdater.on('download-progress', d => show({ v: found, p: d.percent, got: d.transferred, total: d.total }));
  autoUpdater.on('error', () => { found = false; show({ done: true }); }); // offline or GitHub down: just play the current version
  autoUpdater.on('update-downloaded', () => {
    show({ p: 100, installing: true });
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 300); // long enough to paint "Installing…"; silent install, then reopen
  });
  autoUpdater.checkForUpdates().catch(() => {});
}

// files.json (release.cjs) lists every game file's git blob hash; the changed ones come from raw.githubusercontent at the
// release's tag (the repo is public), are written next to their file and renamed over it once all are in, then the game
// restarts. true: patched (or already current). false: needs the installer. ponytail: files a release drops stay behind
async function patchFiles(show) {
  const crypto = require('crypto'), sha = b => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); // git's blob hash
  const rel = await (await fetch('https://api.github.com/repos/ahmed-okkio/gangoflegends/releases/latest', { signal: AbortSignal.timeout(15000) })).json();
  if (rel.tag_name === `v${app.getVersion()}`) { show({ done: true }); return true; }
  const asset = rel.assets?.find(a => a.name === 'files.json');
  if (!asset) return false;
  const m = await (await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(15000) })).json();
  if (m.electron !== process.versions.electron) return false;
  const blob = p => { try { const b = fs.readFileSync(path.join(__dirname, p)); return sha(b); } catch { return null; } };
  const changed = Object.keys(m.files).filter(p => blob(p) !== m.files[p]);
  if (changed.some(p => m.local.includes(p))) return false;
  const v = rel.tag_name.slice(1);
  let got = 0;
  show({ v, p: 0 });
  for (let i = 0; i < changed.length; i += 8) await Promise.all(changed.slice(i, i + 8).map(async p => { // 8 at a time
    const r = await fetch(`https://raw.githubusercontent.com/ahmed-okkio/gangoflegends/${rel.tag_name}/${p}`);
    if (!r.ok) throw new Error(`${p}: ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    if (sha(b) !== m.files[p]) throw new Error(`${p}: hash`);
    const f = path.join(__dirname, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.new', b);
    show({ v, p: ++got / changed.length * 100 });
  }));
  for (const p of changed) fs.renameSync(path.join(__dirname, p) + '.new', path.join(__dirname, p));
  show({ p: 100, installing: true });
  app.relaunch();
  app.exit(0);
  return true;
}

// Unsigned Mac builds can't install updates themselves (macOS refuses), so at launch they ask GitHub for the latest
// release and, when it's newer, offer to open its .dmg (CI attaches it, .github/workflows/mac.yml).
async function offerMacUpdate(win) {
  try {
    const r = await (await fetch('https://api.github.com/repos/ahmed-okkio/gangoflegends/releases/latest')).json();
    const dmg = r.assets?.find(a => a.name.endsWith('.dmg'));
    if (!dmg || r.tag_name === `v${app.getVersion()}`) return; // the dmg lands a few minutes after the release: until then, nothing to offer
    const { response } = await dialog.showMessageBox(win, { message: `Gang of Legends ${r.tag_name.slice(1)} is out`,
      detail: 'Lobbies only accept players on the host’s version. Download it, then drag it into Applications over this one.', buttons: ['Download', 'Later'] });
    if (response === 0) shell.openExternal(dmg.browser_download_url);
  } catch { /* offline: play this version */ }
}

app.on('window-all-closed', () => app.quit());
