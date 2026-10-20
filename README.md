# Gang of Legends

Gang Beasts-style ragdoll brawler with League of Legends champions (Blitzcrank, Hecarim). Up to 8 players online peer-to-peer with a 5-letter lobby code, last one standing wins the round. Private fan mashup.

**Download:** grab `GangOfLegends-Setup-x.y.z.exe` from the [latest release](https://github.com/ahmed-okkio/gangoflegends/releases/latest). The game updates itself after that.

## Dev

```
npm install
python tools/import_gb.py girders   # Gang Beasts stage from your install -> gbcache/ (UnityPy)
python tools/import_beast.py        # beast mesh -> gbcache/beast
python tools/import_audio.py        # sounds -> gbcache/audio
npm start          # run from source
npm run dev        # straight into practice with DevTools
npm test           # physics, combat and netcode-size checks
npm run release    # build the installer and publish it as a GitHub release (uses gh)
```

Bump `version` in package.json before each release; installed copies pick it up on next launch, and lobbies only accept players on the host's version.
