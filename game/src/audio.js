// EMBERLINE — audio.js
// Every sound is synthesized with WebAudio: filtered noise bursts and
// oscillators, no audio files, nothing fetched. The synth is lazy: the
// AudioContext starts on the first user gesture (browsers demand it), and
// every call before that is a silent no-op, so headless runs stay quiet.

let ctx = null;
let master = null;
let muted = false;
let noiseBuf = null;

function ensure() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    // One shared 1 s white-noise buffer for every percussive sound.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Call from a user gesture (click / key) to unlock audio. */
export function unlockAudio() {
  const c = ensure();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function setMuted(m) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.5;
}
export function isMuted() { return muted; }

function noise(dur, filterType, freq, gain, when = 0, q = 1) {
  if (!ensure() || muted) return;
  const t = ctx.currentTime + when;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const flt = ctx.createBiquadFilter();
  flt.type = filterType; flt.frequency.value = freq; flt.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(flt).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

function tone(type, f0, f1, dur, gain, when = 0) {
  if (!ensure() || muted) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// --- The sound board -------------------------------------------------------

const SHOT_TONE = {
  p9: [180, 900], vk47: [140, 700], kestrel: [220, 1100],
  longbow: [90, 420], breacher: [110, 500],
};

/** A gunshot: crack of noise plus a low body thump, per weapon. */
export function playShot(weaponId, distant = false) {
  const [f, nf] = SHOT_TONE[weaponId] || SHOT_TONE.vk47;
  const g = distant ? 0.10 : 0.5;
  noise(0.09, 'highpass', nf, g * 0.9);
  tone('square', f, f * 0.4, 0.12, g * 0.5);
  noise(0.22, 'lowpass', 320, g * 0.55, 0.01);
}

export function playDryFire() { tone('square', 1200, 900, 0.03, 0.08); }

export function playReload() {
  noise(0.05, 'bandpass', 2400, 0.22, 0, 2);
  noise(0.05, 'bandpass', 1800, 0.22, 0.22, 2);
  tone('square', 500, 700, 0.05, 0.1, 0.4);
}

export function playHitmarker(headshot) {
  tone('sine', headshot ? 2100 : 1500, headshot ? 2600 : 1500, 0.06, 0.22);
}

export function playKill() {
  tone('sine', 880, 880, 0.07, 0.2);
  tone('sine', 1320, 1320, 0.1, 0.2, 0.07);
}

export function playHurt() {
  noise(0.12, 'lowpass', 300, 0.35);
  tone('sine', 140, 70, 0.15, 0.25);
}

export function playStep(run) {
  noise(0.05, 'lowpass', run ? 500 : 380, run ? 0.1 : 0.06);
}

export function playPlantBeep(final = false) {
  tone('sine', final ? 1500 : 1000, final ? 1500 : 1000, final ? 0.3 : 0.08, 0.25);
}

export function playDefuseBeep() { tone('sine', 1250, 1250, 0.08, 0.22); }

export function playExplosion() {
  noise(1.4, 'lowpass', 900, 0.9);
  tone('sine', 120, 28, 1.1, 0.8);
  noise(0.5, 'highpass', 2000, 0.3);
}

export function playGrenadePin() { tone('square', 900, 1400, 0.04, 0.12); }
export function playGrenadeBounce() { noise(0.06, 'lowpass', 500, 0.15); }

export function playBuy() {
  tone('sine', 660, 660, 0.06, 0.18);
  tone('sine', 990, 990, 0.08, 0.18, 0.06);
}

export function playClick() { tone('sine', 800, 800, 0.04, 0.12); }

/** Round-end sting: rising major for a win, falling minor for a loss. */
export function playRoundSting(win) {
  const notes = win ? [523, 659, 784, 1046] : [392, 330, 262, 196];
  notes.forEach((f, i) => tone('triangle', f, f, 0.22, 0.22, i * 0.11));
}

/** Short radio blip when a bot calls a site. */
export function playCallout() {
  tone('square', 950, 950, 0.05, 0.1);
  tone('square', 1150, 1150, 0.05, 0.1, 0.08);
}
