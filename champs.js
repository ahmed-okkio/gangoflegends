// Champion roster. Gameplay for each ability id lives in sim.js, looks live in render.js.
export const CHAMPS = {
  blitz: {
    name: 'Blitzcrank', title: 'The Great Steam Golem', body: '#d9a43a', limb: '#a8802c', eyes: '#7fe8ff',
    abilities: [
      { id: 'hook', name: 'Rocket Grab', cd: 6, aim: 12.5, release: true, desc: 'Hold to aim at your cursor, let go to fire your fist. Drags the first champ it hits to you.' },
      { id: 'fist', name: 'Power Fist', cd: 5, desc: 'Your next punch launches its target into the air.' },
    ],
  },
  hec: {
    name: 'Hecarim', title: 'The Shadow of War', body: '#2f6274', limb: '#1d3f4c', eyes: '#5ff7d2',
    abilities: [
      { id: 'rampage', name: 'Rampage', cd: 4, desc: 'Spin with both fists out, smacking everyone around you. Works on the move and mid-charge.' },
      { id: 'charge', name: 'Devastating Charge', cd: 8, aim: 6, release: true, desc: 'Hold to aim at your cursor, let go to gallop, building up speed, and bowl over the first champ you reach. Faster hits harder. Press again to stop.' },
    ],
  },
  vi: {
    name: 'Vi', title: 'The Piltover Enforcer', body: '#5b6b8c', limb: '#45526d', eyes: '#7fd3ff', glow: '#ff5fae',
    abilities: [
      { id: 'vault', name: 'Vault Breaker', cd: 6, aim: 5, desc: 'Hold to wind up (aimed at your cursor), let go to dash and punch the first champ you hit. Longer windup, bigger hit.' },
      { id: 'relentless', name: 'Relentless Force', cd: 4, desc: 'Your next punch smashes through its target into everyone behind it.' },
    ],
  },
  sett: {
    name: 'Sett', title: 'The Boss', body: '#c97a52', limb: '#9a5a3a', eyes: '#ffd166', glow: '#ffb000',
    abilities: [
      { id: 'haymaker', name: 'Haymaker', cd: 8, range: 2.4, cone: 0.6, core: 0.35, desc: 'Getting hit fills your Grit. Hold to plant and charge it in (taking half daze), let go for a cone punch as strong as the Grit spent.' },
      { id: 'facebreaker', name: 'Facebreaker', cd: 7, desc: 'Yank everyone close into you and stun them. Catch champs on both sides for a long stun.' },
    ],
  },
};

export const TEAM_COLORS = ['#ff4d5e', '#3d8bff', '#2ecc71', '#ffc93c'];
export const TEAM_NAMES = ['Red', 'Blue', 'Green', 'Gold'];
// free-for-all: everyone is their own team, coloured by slot
export const FFA_COLORS = ['#ff4d5e', '#3d8bff', '#2ecc71', '#ffc93c', '#b06bff', '#ff8a3d', '#3de0e0', '#ff6bd0'];
