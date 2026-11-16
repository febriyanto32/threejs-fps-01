// EMBERLINE — util.js
// Tiny math helpers shared by every module. No dependencies, no DOM, no
// allocations in the hot path: the helpers below work on plain numbers.

/** Clamp v into [lo, hi]. */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Linear interpolation between a and b. */
export const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest signed angular difference from a to b, in radians. */
export function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Move angle a toward b by at most maxStep radians. */
export function angleToward(a, b, maxStep) {
  const d = angleDiff(a, b);
  return a + clamp(d, -maxStep, maxStep);
}

/** Distance on the XZ plane between two points. */
export const dist2d = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/** Seeded RNG (mulberry32) so bot behaviour is reproducible per round. */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle of a copy of an array, using the given RNG. */
export function shuffled(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Format seconds as M:SS for the round timer. */
export function fmtTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Format dollars as $1,900. */
export function fmtMoney(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}
