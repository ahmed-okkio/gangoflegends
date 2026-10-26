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
const files = [`GangOfLegends-Setup-${version}.exe`, `GangOfLegends-Setup-${version}.exe.blockmap`, 'latest.yml'].map(f => `release/${f}`);
execFileSync('gh', ['release', 'create', `v${version}`, ...files, '--repo', 'ahmed-okkio/gangoflegends', '--title', `Gang of Legends ${version}`, '--notes', entry.notes], { stdio: 'inherit' });
