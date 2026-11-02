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
npm run dev        # straight into practice with DevTools: Rooftop, saved champ, 1 dummy; -- --map=girders --champ=vi --bots=2 (or --bots=blitz,hec)
npm test           # physics, combat and netcode-size checks
npm run release    # push main first: starts the Mac CI build, builds the Windows installer, publishes the GitHub release (uses gh)
```

Bump `version` in package.json before each release and add its entry at the top of `patchnotes.json` (the release notes, also shown in the game's Patch notes tab after the update); installed copies pick it up on next launch, and lobbies only accept players on the host's version.

## Ability indicators

Aiming shows League's own ground indicators: Riot's textures in `assets/indicators/`, taken from CommunityDragon
(`https://raw.communitydragon.org/latest/game/assets/spells/textures/<name>.png`; more there, e.g. `semicirclerangeindicator`, `rectangleline`).
`render.js` draws them additive (black is see-through), each laid flat under the champ, pointing at the cursor and scaled to the ability:

| Shape | Textures | Ability fields (`champs.js`) |
|---|---|---|
| Line (skillshot) | `locallinemissilebase` stretched + `locallinemissiletarget` arrowhead | `aim` = length (`back: true` = both sides, no arrowhead) |
| Cone | `conicrangeindicator`, warped to the cone's angle | `aim` = length, `cone` = radians each side |
| Circle (spot) | `circularrangeindicator` ring + `aoe` spot | `point: true`, `aim` = max range, `radius` = spot |

The hit code reads the same fields (e.g. `rage()` in `sim.js` uses Lee E's `aim` and `cone`), so the indicator is the hitbox: new
abilities should do the same rather than hard-coding their shape. A new shape = one more texture there and one more mesh by `aimBar` in `render.js`.

## Platforms

The game ships for **Windows and macOS**. Keep everything cross-platform: no Windows-only paths, APIs, shell commands or
assumptions in game or app code (`path.join`, not backslashes; `process.platform` checks where the platforms really differ).
Dev tools (`tools/`) may assume Windows; anything that ships may not.

Releasing: push main, then `npm run release` on Windows. It first starts `.github/workflows/mac.yml` (the unsigned universal
`.dmg`, built from origin/main on a GitHub Mac runner), builds the Windows installer meanwhile, and publishes the release with
the `.exe` and `latest.yml` (Windows auto-update); the Mac job attaches its `.dmg` once that release exists. The release also carries `files.json` (every game file's git hash): installed copies fetch just the changed files
from the release tag and restart in a second; only an Electron or npm dependency change falls back to the full installer. Check that run
went green. `gbcache/` is committed so CI has the game assets: re-commit
it after re-importing.
