# Gang of Legends

Gang Beasts-style ragdoll brawler with League of Legends champions. Free fan game under Riot's "Legal Jibber Jabber" policy: never sold, no Riot asset rips.

## Locked decisions
| Area | Decision |
|---|---|
| Stack | Electron + Three.js + PeerJS (WebRTC, lobby codes) + Rapier (WASM) |
| Netcode | Host-authoritative. Only the host simulates; clients send inputs, host broadcasts snapshots at 30Hz, clients interpolate ~80ms behind |
| Players | Up to 8, star topology through the host |
| Ragdoll | 6 bodies (torso, head, 2 arms, 2 legs). Torso hovers at standing height and is steered by velocity; limbs are aimed by angular-velocity control |
| Combat | Hidden daze meter, full = ~3s limp (carry/throw window). Only elimination is falling off or hazards |
| Mode | Last one standing, rounds. FFA or 2/3/4 teams, friendly fire on |
| Champs | 2 abilities each, no passives, roster hand-picked by the owner |
| Maps | Gang Beasts clones with LoL easter eggs |
| Art | Gummy bean bodies in champ colours + iconic primitive props, team-coloured belt |
| Champ select | Free pick, duplicates allowed |

## Roster
- **Blitzcrank**: Q Rocket Grab (hook pulls first champ hit), E Power Fist (next punch launches)
- **Hecarim**: Q Rampage (spin with both fists out), E Devastating Charge (gallop, bowl over first champ)

## Maps
- **Girders**: beams over Piltover, fall = out. Poro, hextech crystal.
- **Grind**: Zaun chem-works, grinder pit in the middle. Jinx graffiti, poro.

## Files
- `sim.js`: physics, abilities, rounds (host + tests)
- `render.js`: Three.js view of snapshots, effects
- `game.js`: menus, lobby, input, host/client loops
- `net.js`: PeerJS transport (from Strike Brawl)
- `champs.js`, `maps.js`: data
- `test.js`: headless sim checks (`npm test`)

## Not in MVP
Local couch play, bots, cosmetics, ranked, audio, auto-update/installer.
