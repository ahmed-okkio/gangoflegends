# Gang of Legends

Gang Beasts-style ragdoll brawler with League of Legends champions (Blitzcrank, Hecarim). Up to 8 players online peer-to-peer with a 5-letter lobby code, last one standing wins the round. Private fan mashup.

**Download** from the [latest release](https://github.com/ahmed-okkio/gangoflegends/releases/latest):
- **Windows:** `GangOfLegends-Setup-x.y.z.exe`. The game updates itself after that.
- **Mac** (Intel and Apple Silicon): `GangOfLegends-x.y.z-mac.dmg`, drag it into Applications. It's unsigned, so once run `xattr -cr /Applications/GangOfLegends.app` in Terminal (or right-click → Open). It can't update itself: at launch it offers the newer `.dmg` when there is one.

## Dev

```
npm install
python tools/import_gb.py girders   # Gang Beasts stage from your install -> gbcache/ (UnityPy)
python tools/import_beast.py        # beast mesh -> gbcache/beast
python tools/import_audio.py        # sounds -> gbcache/audio
npm start          # run from source
npm run dev        # straight into practice with DevTools
npm test           # physics, combat and netcode-size checks
npm run release    # build the Windows installer and publish it as a GitHub release (uses gh); CI then adds the Mac .dmg
```

Bump `version` in package.json before each release and add its entry at the top of `patchnotes.json` (the release notes, also shown in the game's Patch notes tab after the update); installed copies pick it up on next launch, and lobbies only accept players on the host's version.

## Platforms

The game ships for **Windows and macOS**. Keep everything cross-platform: no Windows-only paths, APIs, shell commands or
assumptions in game or app code (`path.join`, not backslashes; `process.platform` checks where the platforms really differ).
Dev tools (`tools/`) may assume Windows; anything that ships may not.

Releasing: `npm run release` on Windows publishes the `.exe` and `latest.yml` (Windows auto-update). Publishing the release
triggers `.github/workflows/mac.yml`, which builds the unsigned universal `.dmg` on a GitHub Mac runner (~5 min) and
attaches it to the same release. Check that run went green. `gbcache/` is committed so CI has the game assets: re-commit
it after re-importing.
