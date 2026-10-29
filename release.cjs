// Publishes release/ to GitHub Releases for the current package.json version (installed copies auto-update from it).
// The release notes are this version's entry in patchnotes.json, the same text the game's Patch notes tab shows.
// Format, every entry: "## " sections in this order, only the ones used: Champions, Gameplay, Maps, Online play, Interface,
// Fixes. Under Champions a "### Name" per champion ("### Name (new)" for a new one). Every change is a "- " bullet under a
// heading. An optional last line in *italics* says who needs the version ("*The host needs X for ...*").
const { execFileSync } = require('child_process');
const { version } = require('./package.json');
const entry = require('./patchnotes.json').find(n => n.v === version);
if (!entry) throw new Error(`patchnotes.json has no entry for ${version}`);
// CI builds the Mac .dmg from the pushed main, alongside this Windows build, and attaches it once the release exists
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
git('fetch', '-q', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) throw new Error('push main first: CI builds the Mac version from origin/main');
execFileSync('gh', ['workflow', 'run', 'mac.yml', '--repo', 'ahmed-okkio/gangoflegends', '--ref', 'main', '-f', `tag=v${version}`], { stdio: 'inherit' });
execFileSync('npx', ['electron-builder', '--win', '--publish', 'never'], { stdio: 'inherit', shell: true });
// files.json: every packaged file's git blob hash, for the in-game patcher (main.cjs patchFiles). Files git has are fetched
// from the release tag; the rest (node_modules) are marked local, and a change in one needs the installer
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const tree = new Map(git('ls-tree', '-r', 'HEAD').split('\n').map(l => [l.split('\t')[1], l.split(/\s/)[2]])); // "<mode> blob <hash>\t<path>"
const appDir = 'release/win-unpacked/resources/app', manifest = { electron: require('electron/package.json').version, files: {}, local: [] };
for (const f of fs.readdirSync(appDir, { recursive: true })) {
  const p = f.split(path.sep).join('/'), full = path.join(appDir, f);
  if (!fs.statSync(full).isFile()) continue;
  if (tree.has(p)) manifest.files[p] = tree.get(p);
  else { const b = fs.readFileSync(full); manifest.files[p] = crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); manifest.local.push(p); }
}
fs.writeFileSync('release/files.json', JSON.stringify(manifest));
const files = [`GangOfLegends-Setup-${version}.exe`, `GangOfLegends-Setup-${version}.exe.blockmap`, 'latest.yml', 'files.json'].map(f => `release/${f}`);
execFileSync('gh', ['release', 'create', `v${version}`, ...files, '--repo', 'ahmed-okkio/gangoflegends', '--title', `Gang of Legends ${version}`, '--notes', entry.notes], { stdio: 'inherit' });
