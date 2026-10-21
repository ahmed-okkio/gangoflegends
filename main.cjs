const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// SMOKE=<png path> loads SMOKE_HASH (default #practice-girders), screenshots after SMOKE_MS, then quits. Offscreen, no window.
const smoke = process.env.SMOKE;
const dev = process.argv.includes('--dev'); // npm run dev: straight into practice (DEV_MAP, default Girders) with DevTools open
if (smoke) app.setPath('userData', path.join(app.getPath('temp'), `gangoflegends-test-${process.pid}`));

app.whenReady().then(() => {
  // no app menu: its shortcuts (Ctrl+W closes, Ctrl+R reloads) fire while holding Ctrl to lie down and pressing a move key
  if (!dev) Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1400, height: 860, backgroundColor: '#0b1426', autoHideMenuBar: true, show: !smoke,
    title: 'Gang of Legends', webPreferences: { backgroundThrottling: false, offscreen: !!smoke },
  });
  const updates = app.isPackaged && !smoke;
  // v feeds the lobby version check; u=1 makes the page start behind the "checking for updates" screen
  win.loadFile(path.join(__dirname, 'index.html'), { query: { v: app.getVersion(), u: updates ? '1' : '0' }, hash: smoke ? (process.env.SMOKE_HASH ?? 'practice-girders') : dev ? `practice-${process.env.DEV_MAP || 'girders'}` : '' });
  if (dev) win.webContents.openDevTools({ mode: 'detach' });
  if (updates) checkForUpdates(win);
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
