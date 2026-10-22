const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const tls = require('tls');

// SMOKE=<png path> loads SMOKE_HASH (default #practice-girders), screenshots after SMOKE_MS, then quits. Offscreen, no window.
const smoke = process.env.SMOKE;
const dev = process.argv.includes('--dev'); // npm run dev: straight into practice (DEV_MAP, default Girders) with DevTools open
if (smoke) app.setPath('userData', path.join(app.getPath('temp'), `gangoflegends-test-${process.pid}`));

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
  const updates = app.isPackaged && !smoke;
  // v feeds the lobby version check; u=1 makes the page start behind the "checking for updates" screen
  win.loadFile(path.join(__dirname, 'index.html'), { query: { v: app.getVersion(), u: updates ? '1' : '0', rv: via ? JSON.stringify(via) : '' }, hash: smoke ? (process.env.SMOKE_HASH ?? 'practice-girders') : dev ? `practice-${process.env.DEV_MAP || 'girders'}` : '' });
  if (dev) win.webContents.openDevTools({ mode: 'detach' });
  if (updates) checkForUpdates(win);
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

// Downloads new versions from GitHub Releases at launch. The page shows a blocking progress bar (window.__update),
// then the installer runs silently and relaunches the game.
function checkForUpdates(win) {
  const { autoUpdater } = require('electron-updater');
  const show = s => win.webContents.executeJavaScript(`window.__update?.(${JSON.stringify(s)})`).catch(() => {});
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
  win.webContents.once('did-finish-load', () => autoUpdater.checkForUpdates().catch(() => {}));
}

app.on('window-all-closed', () => app.quit());
