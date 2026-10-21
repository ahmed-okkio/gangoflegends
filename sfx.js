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

// menu sounds: short synthesized ticks, quiet and clean. [from Hz, to Hz, seconds, gain, wave, delay]
const UI = {
  hover: [[2600, 2600, 0.016, 0.012, 'sine']],
  click: [[1100, 1500, 0.045, 0.03, 'sine']],
  open: [[520, 880, 0.08, 0.025, 'sine']],
  close: [[880, 520, 0.08, 0.025, 'sine']],
  back: [[760, 480, 0.06, 0.03, 'sine']],
  pick: [[1050, 1050, 0.04, 0.028, 'sine'], [1575, 1575, 0.07, 0.024, 'sine', 0.045]],
  start: [[660, 660, 0.07, 0.03, 'sine'], [990, 990, 0.14, 0.03, 'sine', 0.07]],
  error: [[260, 190, 0.14, 0.04, 'triangle']],
};
export function ui(kind) {
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  for (const [f0, f1, dur, vol, type, delay = 0] of UI[kind] ?? []) {
    const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * volume, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02);
  }
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
    else if (kind === 'vi') play('swing', 0.8);
    else if (kind === 'pulv') { play('hitHard', 0.9); play('fall', 0.6); }
  }
}
