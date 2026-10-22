// Publishes release/ to GitHub Releases for the current package.json version (installed copies auto-update from it).
// The release notes are this version's entry in patchnotes.json, the same text the game's Patch notes tab shows.
const { execFileSync } = require('child_process');
const { version } = require('./package.json');
const entry = require('./patchnotes.json').find(n => n.v === version);
if (!entry) throw new Error(`patchnotes.json has no entry for ${version}`);
const files = [`GangOfLegends-Setup-${version}.exe`, `GangOfLegends-Setup-${version}.exe.blockmap`, 'latest.yml'].map(f => `release/${f}`);
execFileSync('gh', ['release', 'create', `v${version}`, ...files, '--repo', 'ahmed-okkio/gangoflegends', '--title', `Gang of Legends ${version}`, '--notes', entry.notes], { stdio: 'inherit' });
