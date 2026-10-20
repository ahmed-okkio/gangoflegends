// Publishes release/ to GitHub Releases for the current package.json version (installed copies auto-update from it).
const { execFileSync } = require('child_process');
const { version } = require('./package.json');
const files = [`GangOfLegends-Setup-${version}.exe`, `GangOfLegends-Setup-${version}.exe.blockmap`, 'latest.yml'].map(f => `release/${f}`);
execFileSync('gh', ['release', 'create', `v${version}`, ...files, '--repo', 'ahmed-okkio/gangoflegends', '--title', `Gang of Legends ${version}`, '--notes', process.env.NOTES || `Gang of Legends ${version}`], { stdio: 'inherit' });
