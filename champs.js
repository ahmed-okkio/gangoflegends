// Champion roster. Gameplay for each ability id lives in sim.js, looks live in render.js.
export const CHAMPS = {
  blitz: {
    name: 'Blitzcrank', title: 'The Great Steam Golem', body: '#d9a43a', limb: '#a8802c', eyes: '#7fe8ff',
    abilities: [
      { id: 'hook', key: 'Q', name: 'Rocket Grab', cd: 6, desc: 'Fire your fist and drag the first champ it hits to you.' },
      { id: 'fist', key: 'E', name: 'Power Fist', cd: 5, desc: 'Your next punch launches its target into the air.' },
    ],
  },
  hec: {
    name: 'Hecarim', title: 'The Shadow of War', body: '#2f6274', limb: '#1d3f4c', eyes: '#5ff7d2',
    abilities: [
      { id: 'rampage', key: 'Q', name: 'Rampage', cd: 4, desc: 'Spin with both fists out, smacking everyone around you.' },
      { id: 'charge', key: 'E', name: 'Devastating Charge', cd: 8, desc: 'Gallop at high speed and bowl over the first champ you reach.' },
    ],
  },
};

export const TEAM_COLORS = ['#ff4d5e', '#3d8bff', '#2ecc71', '#ffc93c'];
export const TEAM_NAMES = ['Red', 'Blue', 'Green', 'Gold'];
// free-for-all: everyone is their own team, coloured by slot
export const FFA_COLORS = ['#ff4d5e', '#3d8bff', '#2ecc71', '#ffc93c', '#b06bff', '#ff8a3d', '#3de0e0', '#ff6bd0'];
