// Gang Beasts sound effects (tools/import_audio.py -> gbcache/audio/). Silent when not imported.
import { xhr } from './stages.js';

const ctx = typeof AudioContext !== 'undefined' ? new AudioContext() : null;
const base = './gbcache/audio/';
const VOLUME = 0.3; // GB clips are mastered hot: the slider's 100% is this
let volume = 1;
export const setVolume = v => { volume = v; };
let index = {};
const buffers = {}; // file -> Promise<AudioBuffer>

export async function loadSfx() {
  if (!ctx || Object.keys(index).length) return;
  try { index = JSON.parse(await xhr(base + 'index.json', 'text')); } catch { /* not imported */ }
}

export function play(group, vol = 1, rate = 0.92 + Math.random() * 0.16) {
  const list = index[group];
  if (!ctx || !list?.length) return;
  if (ctx.state === 'suspended') ctx.resume();
  const file = list[Math.floor(Math.random() * list.length)];
  buffers[file] ??= xhr(base + file, 'arraybuffer').then(b => ctx.decodeAudioData(b));
  buffers[file].then(buf => {
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf; src.playbackRate.value = rate; g.gain.value = vol * VOLUME * volume;
    src.connect(g).connect(ctx.destination);
    src.start();
  }, () => {});
}

// sim fx events -> sounds
export function playEvents(events) {
  for (const [kind, , , , big] of events) {
    if (kind === 'hit') { play(big ? 'hitHard' : 'hit', 0.8); play('body', 0.5); }
    else if (kind === 'ko') play('ko', 0.9, 1);
    else if (kind === 'out') { play('fall', 0.9, 1); play('wind', 0.6); }
    else if (kind === 'swing') play('swing', 0.35);
    else if (kind === 'grab') play('grab', 0.5);
    else if (kind === 'fb') { play('swing', 0.7); play('grab', 0.6); }
  }
}
